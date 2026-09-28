import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { Store } from "../../src/store.js";
import { ActionError } from "../../src/actions.js";
import { event } from "../fixtures.js";

// This suite intentionally requires a disposable database, separate from DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("/forms_processor_test"))
  throw new Error(
    "TEST_DATABASE_URL must name a disposable forms_processor_test database",
  );
const pool = new Pool({ connectionString: url });
let calls = 0;
let fail = false;
const store = new Store(
  pool,
  new Map([
    [
      "sendgrid-email",
      {
        execute: async () => {
          calls++;
          if (fail) throw new ActionError("bus_http_429");
        },
      },
    ],
  ]),
);
before(async () => {
  await pool.query("DROP SCHEMA IF EXISTS forms CASCADE; CREATE SCHEMA forms");
  await pool.query(
    await readFile(
      new URL("../fixtures/processor-schema.sql", import.meta.url),
      "utf8",
    ),
  );
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  calls = 0;
  fail = false;
  await pool.query(
    'TRUNCATE forms."ProcessorDelivery", forms."ProcessorEvent"',
  );
  await pool.query(
    "DELETE FROM forms.\"ProcessorFlow\" WHERE id <> 'lets-talk-sales-email'",
  );
  await pool.query(
    'UPDATE forms."ProcessorFlow" SET enabled = false, rules = \'{"all":[]}\'',
  );
});
test("disabled flows queue; enabling later sends once despite duplicate Kafka delivery", async () => {
  await Promise.all([store.enqueue(event), store.enqueue(event)]);
  assert.equal(await store.routeOne(), true);
  assert.equal(await store.routeOne(), false);
  assert.equal(await store.deliverOne(), false);
  await pool.query('UPDATE forms."ProcessorFlow" SET enabled = true');
  assert.equal(await store.deliverOne(), true);
  await store.enqueue(event);
  assert.equal(await store.routeOne(), false);
  assert.equal(await store.deliverOne(), false);
  assert.equal(calls, 1);
});
test("concurrent workers claim each delivery only once", async () => {
  await store.enqueue(event);
  await store.routeOne();
  await pool.query('UPDATE forms."ProcessorFlow" SET enabled = true');
  await Promise.all([
    store.deliverOne(),
    store.deliverOne(),
    store.deliverOne(),
  ]);
  assert.equal(calls, 1);
});
test("failed delivery retries later and preserves successful per-flow receipts", async () => {
  await pool.query('UPDATE forms."ProcessorFlow" SET enabled = true');
  await pool.query(
    "INSERT INTO forms.\"ProcessorFlow\" (id, \"formKey\", enabled, action) VALUES ('second', 'lets-talk', true, 'sendgrid-email')",
  );
  await store.enqueue(event);
  await store.routeOne();
  await store.deliverOne();
  fail = true;
  await store.deliverOne();
  const { rows } = await pool.query(
    'SELECT * FROM forms."ProcessorDelivery" ORDER BY "flowId"',
  );
  assert.ok(rows[0].deliveredAt);
  assert.equal(rows[1].lastError, "bus_http_429");
  assert.equal(await store.deliverOne(), false);
  fail = false;
  await pool.query(
    'UPDATE forms."ProcessorDelivery" SET "nextAttemptAt" = now()',
  );
  await store.deliverOne();
  assert.equal(calls, 3);
});
test("routes on form key and content without affecting unknown forms", async () => {
  await pool.query('UPDATE forms."ProcessorFlow" SET rules = $1', [
    JSON.stringify({
      all: [{ field: "interested_in", operator: "equals", value: "member" }],
    }),
  ]);
  await store.enqueue(event);
  await store.routeOne();
  await store.enqueue({
    ...event,
    submissionId: "bf1d6716-26bf-4b66-aa23-9904f22d8b41",
    formKey: "another-form",
  });
  await store.routeOne();
  assert.equal(
    (await pool.query('SELECT count(*) FROM forms."ProcessorDelivery"')).rows[0]
      .count,
    "0",
  );
});
test("invalid routing rules defer without dropping the inbox event", async () => {
  await pool.query(
    'UPDATE forms."ProcessorFlow" SET rules = \'{"unknown":true}\'',
  );
  await store.enqueue(event);
  await store.routeOne();
  const {
    rows: [row],
  } = await pool.query('SELECT * FROM forms."ProcessorEvent"');
  assert.equal(row.routedAt, null);
  assert.equal(row.lastError, "invalid_routing_configuration");
  await pool.query('UPDATE forms."ProcessorFlow" SET rules = \'{"all":[]}\'');
  await pool.query('UPDATE forms."ProcessorEvent" SET "nextAttemptAt" = now()');
  assert.equal(await store.routeOne(), true);
});
test("re-routing preserves successful receipts and creates newly added matching flow receipts", async () => {
  await pool.query('UPDATE forms."ProcessorFlow" SET enabled = true');
  await store.enqueue(event);
  await store.routeOne();
  await store.deliverOne();
  await pool.query(
    "INSERT INTO forms.\"ProcessorFlow\" (id, \"formKey\", enabled, action) VALUES ('second', 'lets-talk', true, 'sendgrid-email')",
  );
  await pool.query('UPDATE forms."ProcessorEvent" SET "routedAt" = NULL');
  await store.routeOne();
  await store.deliverOne();
  assert.equal(calls, 2);
});
