import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { SendGridEmail } from "./actions.js";
import { config } from "./config.js";
import { consume } from "./consumer.js";
import { Store, log } from "./store.js";

/** Start the database inbox worker, Kafka consumer, and private health endpoint; propagate startup failures. */
async function main(): Promise<void> {
  const settings = config();
  const pool = new Pool({
    connectionString: settings.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 25_000,
    idle_in_transaction_session_timeout: 45_000,
  });
  pool.on("error", () => log("database_pool_error"));
  const store = new Store(
    pool,
    new Map([
      [
        "sendgrid-email",
        new SendGridEmail(settings.SENDGRID_API_KEY, settings.SENDGRID_SANDBOX),
      ],
    ]),
  );
  await store.ready();
  const shutdown = new AbortController();
  /** Begin graceful shutdown with a bounded deadline; takes no input and returns nothing. */
  const stop = (): void => {
    if (shutdown.signal.aborted) return;
    shutdown.abort();
    setTimeout(() => process.exit(1), 45_000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const server = createServer((_request, response) => {
    response.writeHead(shutdown.signal.aborted ? 503 : 200, {
      "Content-Type": "application/json",
    });
    response.end(
      JSON.stringify({ status: shutdown.signal.aborted ? "stopping" : "ok" }),
    );
  });
  server.listen(settings.PORT, "0.0.0.0");
  /** Route and send fairly until shutdown; transient DB errors back off without logging secrets. */
  const work = async (): Promise<void> => {
    while (!shutdown.signal.aborted) {
      try {
        const routed = await store.routeOne();
        const delivered = shutdown.signal.aborted
          ? false
          : await store.deliverOne();
        if (routed || delivered) continue;
      } catch {
        log("worker_database_error");
      }
      await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  };
  const worker = work();
  try {
    await consume(settings, (event) => store.enqueue(event), shutdown.signal);
  } finally {
    stop();
    await worker;
    server.close();
    await pool.end();
  }
}
void main().catch(() => {
  log("processor_fatal");
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000).unref();
});
