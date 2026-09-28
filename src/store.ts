import { Pool, type PoolClient } from "pg";
import { ActionError, type Action } from "./actions.js";
import { matches, submissionSchema, type Submission } from "./contracts.js";

/** Emit structured operational metadata only; callers must never include answers, settings, or raw errors. */
export function log(
  event: string,
  metadata: Record<string, string | number> = {},
): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...metadata }),
  );
}

/** Return capped exponential retry seconds from the previous failure count; no exceptions. */
export function retrySeconds(attempts: number): number {
  return Math.min(3600, 5 * 2 ** Math.min(attempts, 10));
}

/** Owns the durable inbox, routing, and per-flow delivery receipts in the API-managed forms schema. */
export class Store {
  /** Accepts an existing PostgreSQL pool and action registry. Does not open connections or throw. */
  constructor(
    readonly pool: Pool,
    private readonly actions: ReadonlyMap<string, Action>,
  ) {}

  /** Persist a validated submission before Kafka acknowledgement; duplicate IDs are no-ops. Throws on DB failure. */
  async enqueue(event: Submission): Promise<void> {
    await this.pool.query(
      'INSERT INTO forms."ProcessorEvent" ("submissionId", "formKey", payload) VALUES ($1, $2, $3) ON CONFLICT ("submissionId") DO NOTHING',
      [event.submissionId, event.formKey, JSON.stringify(event)],
    );
  }

  /** Verify all required migration tables exist at startup; returns nothing or throws on missing schema/DB failure. */
  async ready(): Promise<void> {
    await this.pool.query(
      'SELECT 1 FROM forms."ProcessorEvent", forms."ProcessorFlow", forms."ProcessorDelivery" LIMIT 0',
    );
  }

  /** Run a callback in a transaction; returns its result, rolls back on errors, and always releases the client. */
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Route one due inbox event to every matching flow, including disabled flows; returns whether work was found.
   * Invalid admin rules defer that event with a safe code; database failures propagate for caller recovery.
   */
  async routeOne(): Promise<boolean> {
    return this.transaction(async (client) => {
      const {
        rows: [row],
      } = await client.query(
        'SELECT * FROM forms."ProcessorEvent" WHERE "routedAt" IS NULL AND "nextAttemptAt" <= now() ORDER BY "nextAttemptAt", "receivedAt" FOR UPDATE SKIP LOCKED LIMIT 1',
      );
      if (!row) return false;
      const { rows: flows } = await client.query(
        'SELECT id, rules FROM forms."ProcessorFlow" WHERE "formKey" = $1 ORDER BY id',
        [row.formKey],
      );
      let selected: { id: string }[];
      try {
        const event = submissionSchema.parse(row.payload);
        selected = flows.filter((flow) => matches(flow.rules, event));
      } catch {
        await client.query(
          'UPDATE forms."ProcessorEvent" SET attempts = attempts + 1, "lastError" = $2, "nextAttemptAt" = now() + $3 * interval \'1 second\' WHERE "submissionId" = $1',
          [
            row.submissionId,
            "invalid_routing_configuration",
            retrySeconds(row.attempts),
          ],
        );
        log("routing_deferred", { submissionId: row.submissionId });
        return true;
      }
      for (const flow of selected) {
        await client.query(
          'INSERT INTO forms."ProcessorDelivery" ("submissionId", "flowId") VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [row.submissionId, flow.id],
        );
      }
      await client.query(
        'UPDATE forms."ProcessorEvent" SET "routedAt" = now(), "lastError" = NULL WHERE "submissionId" = $1',
        [row.submissionId],
      );
      log("submission_routed", {
        submissionId: row.submissionId,
        flowCount: selected.length,
      });
      return true;
    });
  }

  /** Deliver one pending enabled flow under a row lock; records success or schedules a retry.
   * Returns whether work was found. Action failures are sanitized; DB failures propagate.
   * A crash after Bus API acceptance but before commit can resend (at-least-once delivery).
   */
  async deliverOne(): Promise<boolean> {
    return this.transaction(async (client) => {
      const {
        rows: [row],
      } = await client.query(`
        SELECT d.*, f.action, f.settings, e.payload FROM forms."ProcessorDelivery" d
        JOIN forms."ProcessorFlow" f ON f.id = d."flowId"
        JOIN forms."ProcessorEvent" e ON e."submissionId" = d."submissionId"
        WHERE d."deliveredAt" IS NULL AND d."nextAttemptAt" <= now() AND f.enabled
        ORDER BY d."nextAttemptAt", d."createdAt" FOR UPDATE OF d SKIP LOCKED LIMIT 1`);
      if (!row) return false;
      try {
        const action = this.actions.get(row.action);
        if (!action) throw new ActionError("unknown_action");
        await action.execute(submissionSchema.parse(row.payload), row.settings);
      } catch (error) {
        const code =
          error instanceof ActionError ? error.message : "action_failed";
        await client.query(
          'UPDATE forms."ProcessorDelivery" SET attempts = attempts + 1, "lastError" = $3, "nextAttemptAt" = now() + $4 * interval \'1 second\' WHERE "submissionId" = $1 AND "flowId" = $2',
          [row.submissionId, row.flowId, code, retrySeconds(row.attempts)],
        );
        log("delivery_deferred", {
          submissionId: row.submissionId,
          flowId: row.flowId,
          code,
        });
        return true;
      }
      await client.query(
        'UPDATE forms."ProcessorDelivery" SET "deliveredAt" = now(), attempts = attempts + 1, "lastError" = NULL WHERE "submissionId" = $1 AND "flowId" = $2',
        [row.submissionId, row.flowId],
      );
      log("delivery_accepted", {
        submissionId: row.submissionId,
        flowId: row.flowId,
      });
      return true;
    });
  }
}
