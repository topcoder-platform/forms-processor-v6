import { Pool, type PoolClient } from "pg";
import {
  ActionError,
  type Action,
  type ActionContext,
  type ClassificationRecord,
  type StoredClassification,
} from "./actions.js";
import {
  awaitsClassification,
  matches,
  matchesLabel,
  submissionSchema,
  type Submission,
} from "./contracts.js";

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

/** Store options beyond actions and settings. */
export interface StoreOptions {
  /** Flows that email the submitter; their accepted sends count toward the per-address reply cap. */
  submitterFlowIds?: ReadonlySet<string>;
  /** The answer holding the submitter's address in those flows. */
  submitterAddressAnswer?: string;
}

/** PostgreSQL foreign-key violation: the submission was deleted (retention/erasure) before classification. */
const FOREIGN_KEY_VIOLATION = "23503";

/** Owns the durable inbox, routing, and per-flow receipts in the API-managed forms schema.
 * main supplies actions and optional environment-owned settings for specific flows.
 *
 * Routing has two stages (ADR 0001, Decision 2): flows without a `classification` rule are
 * routed on arrival; flows with one are routed when a classify action reports the label, in
 * the same transaction that saves the classification and completes the classify delivery.
 */
export class Store {
  private readonly submitterFlowIds: string[];
  private readonly submitterAddressAnswer: string;

  /** Accepts a PostgreSQL pool, action registry, and optional settings replacements keyed by flow ID.
   * Returns a store without opening connections or throwing. main uses replacements for SSM-owned settings.
   */
  constructor(
    readonly pool: Pool,
    private readonly actions: ReadonlyMap<string, Action>,
    private readonly settingsOverrides: ReadonlyMap<
      string,
      unknown
    > = new Map(),
    options: StoreOptions = {},
  ) {
    this.submitterFlowIds = [...(options.submitterFlowIds ?? [])];
    this.submitterAddressAnswer = options.submitterAddressAnswer ?? "email";
  }

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
      'SELECT 1 FROM forms."ProcessorEvent", forms."ProcessorFlow", forms."ProcessorDelivery", forms."SubmissionClassification" LIMIT 0',
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

  /** Route one due inbox event to every matching stage-1 flow, including disabled flows; returns whether work was found.
   * Flows with a `classification` rule wait for stage 2. Invalid admin rules defer that event with a
   * safe code; database failures propagate for caller recovery.
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
        selected = flows.filter(
          (flow) =>
            !awaitsClassification(flow.rules) && matches(flow.rules, event),
        );
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
   * Takes no input; environment settings replace DB settings only for explicitly configured flow IDs.
   * A reported classification is saved and its label's stage-2 flows routed in the same transaction.
   * Returns whether work was found. Action failures are sanitized; DB failures propagate.
   * A crash after Bus API acceptance but before commit can resend (at-least-once delivery).
   */
  async deliverOne(): Promise<boolean> {
    return this.transaction(async (client) => {
      const {
        rows: [row],
      } = await client.query(`
        SELECT d.*, f.action, f.settings, e.payload, e."formKey", e."receivedAt" FROM forms."ProcessorDelivery" d
        JOIN forms."ProcessorFlow" f ON f.id = d."flowId"
        JOIN forms."ProcessorEvent" e ON e."submissionId" = d."submissionId"
        WHERE d."deliveredAt" IS NULL AND d."nextAttemptAt" <= now() AND f.enabled
        ORDER BY d."nextAttemptAt", d."createdAt" FOR UPDATE OF d SKIP LOCKED LIMIT 1`);
      if (!row) return false;
      let skipped: string | undefined;
      let label: string | undefined;
      try {
        const action = this.actions.get(row.action);
        if (!action) throw new ActionError("unknown_action");
        const event = submissionSchema.parse(row.payload);
        const result = await action.execute(
          event,
          this.settingsOverrides.has(row.flowId)
            ? this.settingsOverrides.get(row.flowId)
            : row.settings,
          await this.context(client, row.submissionId, row.receivedAt),
        );
        skipped = result?.skipped;
        if (result?.classification) {
          if (
            await this.saveClassification(
              client,
              row.submissionId,
              result.classification,
            )
          ) {
            label = result.classification.label;
            await this.routeLabel(client, row.formKey, event, label);
          } else skipped = "submission_missing";
        }
      } catch (error) {
        const code =
          error instanceof ActionError ? error.message : "action_failed";
        if (error instanceof ActionError && error.classification)
          await this.saveClassification(
            client,
            row.submissionId,
            error.classification,
          );
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
        'UPDATE forms."ProcessorDelivery" SET "deliveredAt" = now(), attempts = attempts + 1, "lastError" = $3 WHERE "submissionId" = $1 AND "flowId" = $2',
        [row.submissionId, row.flowId, skipped ? `skipped_${skipped}` : null],
      );
      log(skipped ? "delivery_skipped" : "delivery_accepted", {
        submissionId: row.submissionId,
        flowId: row.flowId,
        ...(skipped ? { code: skipped } : {}),
        ...(label ? { label } : {}),
      });
      return true;
    });
  }

  /** Build the per-delivery context: receipt time, stored classification, and the reply-cap counter. */
  private async context(
    client: PoolClient,
    submissionId: string,
    receivedAt: Date,
  ): Promise<ActionContext> {
    const {
      rows: [stored],
    } = await client.query(
      'SELECT label, status, confidence, "needsReview", "detectedLanguage", rationale, "workflowRunId", attempts, "lastError" FROM forms."SubmissionClassification" WHERE "submissionId" = $1',
      [submissionId],
    );
    return {
      receivedAt: new Date(receivedAt),
      classification: stored
        ? ({
            ...stored,
            confidence:
              stored.confidence === null ? null : Number(stored.confidence),
          } as StoredClassification)
        : null,
      recentSubmitterSends: async (address: string) => {
        if (!this.submitterFlowIds.length) return 0;
        const {
          rows: [count],
        } = await client.query(
          `SELECT count(*)::int AS n FROM forms."ProcessorDelivery" d
           JOIN forms."ProcessorEvent" e ON e."submissionId" = d."submissionId"
           WHERE d."flowId" = ANY($1) AND d."deliveredAt" > now() - interval '24 hours'
             AND d."lastError" IS NULL AND d."submissionId" <> $2
             AND lower(e.payload->'answers'->>$3) = $4`,
          [
            this.submitterFlowIds,
            submissionId,
            this.submitterAddressAnswer,
            address.toLowerCase(),
          ],
        );
        return count.n as number;
      },
    };
  }

  /** Upsert a submission's classification inside a savepoint. Returns false, leaving the
   * transaction usable, when the submission no longer exists; other errors propagate.
   */
  private async saveClassification(
    client: PoolClient,
    submissionId: string,
    c: ClassificationRecord,
  ): Promise<boolean> {
    await client.query("SAVEPOINT classification");
    try {
      await client.query(
        `INSERT INTO forms."SubmissionClassification"
           ("submissionId", label, status, confidence, "needsReview", "detectedLanguage", rationale,
            "workflowId", "workflowRunId", attempts, "lastError", "classifiedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12::boolean THEN now() END)
         ON CONFLICT ("submissionId") DO UPDATE SET
           label = EXCLUDED.label, status = EXCLUDED.status, confidence = EXCLUDED.confidence,
           "needsReview" = EXCLUDED."needsReview", "detectedLanguage" = EXCLUDED."detectedLanguage",
           rationale = EXCLUDED.rationale, "workflowId" = EXCLUDED."workflowId",
           "workflowRunId" = EXCLUDED."workflowRunId", attempts = EXCLUDED.attempts,
           "lastError" = EXCLUDED."lastError", "classifiedAt" = EXCLUDED."classifiedAt", "updatedAt" = now()`,
        [
          submissionId,
          c.label,
          c.status,
          c.confidence ?? null,
          c.needsReview ?? null,
          c.detectedLanguage?.slice(0, 8) ?? null,
          c.rationale?.slice(0, 500) ?? null,
          c.workflowId,
          c.workflowRunId ?? null,
          c.attempts,
          c.lastError?.slice(0, 100) ?? null,
          c.status === "CLASSIFIED",
        ],
      );
      await client.query("RELEASE SAVEPOINT classification");
      return true;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT classification");
      if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        log("classification_submission_missing", { submissionId });
        return false;
      }
      throw error;
    }
  }

  /** Stage 2: create deliveries for every **enabled** flow of the form that waits for this label.
   * Unlike stage 1, disabled flows get no queued delivery: label actions are replies, and a reply
   * queued while a flow was off (e.g. in shadow mode) must not go out weeks later when it is enabled.
   */
  private async routeLabel(
    client: PoolClient,
    formKey: string,
    event: Submission,
    label: string,
  ): Promise<void> {
    const { rows: flows } = await client.query(
      'SELECT id, rules FROM forms."ProcessorFlow" WHERE "formKey" = $1 AND enabled ORDER BY id',
      [formKey],
    );
    const selected = flows.filter((flow) => {
      try {
        return matchesLabel(flow.rules, event, label);
      } catch {
        // An invalid rule must not block the other flows; it is logged and skipped.
        log("stage_two_invalid_rules", { flowId: flow.id });
        return false;
      }
    });
    for (const flow of selected) {
      await client.query(
        'INSERT INTO forms."ProcessorDelivery" ("submissionId", "flowId") VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [event.submissionId, flow.id],
      );
    }
    log("submission_classified", {
      submissionId: event.submissionId,
      label,
      flowCount: selected.length,
    });
  }
}
