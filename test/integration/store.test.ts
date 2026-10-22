import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { Store } from "../../src/store.js";
import {
  ActionError,
  type Action,
  type ActionContext,
  type ActionResult,
  type ClassificationRecord,
} from "../../src/actions.js";
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
  await pool.query(
    await readFile(
      new URL("../fixtures/lets-talk-key.sql", import.meta.url),
      "utf8",
    ),
  );
  // The classification table references forms-api's Submission table; a stub is enough here.
  await pool.query('CREATE TABLE forms."Submission" (id UUID PRIMARY KEY)');
  await pool.query(
    await readFile(
      new URL("../fixtures/lets-talk-classification.sql", import.meta.url),
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
    'TRUNCATE forms."ProcessorDelivery", forms."ProcessorEvent", forms."SubmissionClassification", forms."Submission"',
  );
  await pool.query(
    "DELETE FROM forms.\"ProcessorFlow\" WHERE id <> 'lets-talk-sales-email'",
  );
  // Two-stage tests remove the legacy flow; restore it as seeded.
  await pool.query(
    `INSERT INTO forms."ProcessorFlow" (id, "formKey", action, settings)
     VALUES ('lets-talk-sales-email', 'lets_talk', 'sendgrid-email',
             '{"recipients":[],"templateId":null,"fromEmail":null,"fromName":"Topcoder"}')
     ON CONFLICT (id) DO NOTHING`,
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
    "INSERT INTO forms.\"ProcessorFlow\" (id, \"formKey\", enabled, action) VALUES ('second', 'lets_talk', true, 'sendgrid-email')",
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
  // Make the retry overdue; TIMESTAMPTZ(3) can round now() ahead of the next transaction.
  await pool.query(
    'UPDATE forms."ProcessorDelivery" SET "nextAttemptAt" = now() - interval \'1 second\'',
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
  // Avoid the same timestamp rounding race when making a routing retry due.
  await pool.query(
    'UPDATE forms."ProcessorEvent" SET "nextAttemptAt" = now() - interval \'1 second\'',
  );
  assert.equal(await store.routeOne(), true);
});
test("re-routing preserves successful receipts and creates newly added matching flow receipts", async () => {
  await pool.query('UPDATE forms."ProcessorFlow" SET enabled = true');
  await store.enqueue(event);
  await store.routeOne();
  await store.deliverOne();
  await pool.query(
    "INSERT INTO forms.\"ProcessorFlow\" (id, \"formKey\", enabled, action) VALUES ('second', 'lets_talk', true, 'sendgrid-email')",
  );
  await pool.query('UPDATE forms."ProcessorEvent" SET "routedAt" = NULL');
  await store.routeOne();
  await store.deliverOne();
  assert.equal(calls, 2);
});

test("environment settings replace only the configured flow and missing settings never fall back to DB", async () => {
  const seen: unknown[] = [];
  const configured = new Store(
    pool,
    new Map([
      [
        "sendgrid-email",
        {
          execute: async (_event, settings) => {
            seen.push(settings);
          },
        },
      ],
    ]),
    new Map([["lets-talk-sales-email", { recipients: [], templateId: "" }]]),
  );
  await pool.query(
    'UPDATE forms."ProcessorFlow" SET enabled = true, settings = $1',
    [JSON.stringify({ recipients: ["stale@example.com"] })],
  );
  await pool.query(
    "INSERT INTO forms.\"ProcessorFlow\" (id, \"formKey\", enabled, action, settings) VALUES ('second', 'lets_talk', true, 'sendgrid-email', '{\"custom\":true}')",
  );
  await configured.enqueue(event);
  await configured.routeOne();
  await configured.deliverOne();
  await configured.deliverOne();
  assert.deepEqual(seen, [
    { recipients: [], templateId: "" },
    { custom: true },
  ]);
});

test("form-key migration reroutes missed website events and preserves configuration and accepted receipts", async () => {
  const second = {
    ...event,
    submissionId: "bf1d6716-26bf-4b66-aa23-9904f22d8b41",
  };
  await pool.query('UPDATE forms."ProcessorFlow" SET enabled = true');
  await store.enqueue(event);
  await store.routeOne();
  await store.deliverOne();
  await pool.query(
    'UPDATE forms."ProcessorFlow" SET "formKey" = \'lets-talk\'',
  );
  await store.enqueue(second);
  await store.routeOne();
  const before = (
    await pool.query(
      'SELECT enabled, settings, rules FROM forms."ProcessorFlow"',
    )
  ).rows[0];
  await pool.query(
    await readFile(
      new URL("../fixtures/lets-talk-key.sql", import.meta.url),
      "utf8",
    ),
  );
  const flow = (
    await pool.query(
      'SELECT "formKey", enabled, settings, rules FROM forms."ProcessorFlow"',
    )
  ).rows[0];
  assert.deepEqual(flow, { ...before, formKey: "lets_talk" });
  assert.equal(await store.routeOne(), true);
  assert.equal(await store.routeOne(), false);
  assert.equal(await store.deliverOne(), true);
  assert.equal(await store.deliverOne(), false);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// Two-stage routing with AI classification (ADR 0001)
// ---------------------------------------------------------------------------

const RUN_ID = "6f1c2a9e-6b7d-4e8f-9a01-2b3c4d5e6f70";
const classified = (label: string): ClassificationRecord => ({
  workflowId: "lets-talk-classification",
  status: "CLASSIFIED",
  label,
  confidence: 0.9,
  needsReview: false,
  detectedLanguage: "en",
  rationale: "Test rationale.",
  workflowRunId: RUN_ID,
  attempts: 1,
});

/** A store whose classify action follows `classify`; email calls are recorded with their context. */
function twoStage(
  classify: () => Promise<ActionResult>,
  options: { submitterFlowIds?: ReadonlySet<string> } = {},
) {
  const emails: { flowSettings: unknown; context?: ActionContext }[] = [];
  const twoStageStore = new Store(
    pool,
    new Map<string, Action>([
      ["ai-classify", { execute: classify }],
      [
        "sendgrid-email",
        {
          execute: async (_event, flowSettings, context) => {
            emails.push({ flowSettings, context });
            return undefined;
          },
        },
      ],
    ]),
    new Map(),
    options,
  );
  return { store: twoStageStore, emails };
}

/** Insert the submission row, the classify flow, and enabled label flows named after their label. */
async function setUpLetsTalk(
  labels: string[],
  submissionId = event.submissionId,
) {
  // Two-stage tests use only their own flows.
  await pool.query(
    "DELETE FROM forms.\"ProcessorFlow\" WHERE id = 'lets-talk-sales-email'",
  );
  await pool.query(
    'INSERT INTO forms."Submission" (id) VALUES ($1) ON CONFLICT DO NOTHING',
    [submissionId],
  );
  await pool.query(
    `INSERT INTO forms."ProcessorFlow" (id, "formKey", enabled, action, rules)
     VALUES ('classify', 'lets_talk', true, 'ai-classify', '{"all":[]}') ON CONFLICT DO NOTHING`,
  );
  for (const label of labels)
    await pool.query(
      `INSERT INTO forms."ProcessorFlow" (id, "formKey", enabled, action, rules, settings)
       VALUES ($1, 'lets_talk', true, 'sendgrid-email', $2, $3) ON CONFLICT DO NOTHING`,
      [
        `reply-${label}`,
        JSON.stringify({ all: [], classification: [label] }),
        JSON.stringify({ flow: label }),
      ],
    );
}

async function deliveries(): Promise<Record<string, string | null>> {
  const { rows } = await pool.query(
    'SELECT "flowId", "deliveredAt", "lastError" FROM forms."ProcessorDelivery" ORDER BY "flowId"',
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.flowId,
      r.deliveredAt ? (r.lastError ?? "delivered") : `pending:${r.lastError}`,
    ]),
  );
}

async function classification() {
  return (await pool.query('SELECT * FROM forms."SubmissionClassification"'))
    .rows[0];
}

test("stage 1 routes only the classify flow; the label then routes its own flows, atomically", async () => {
  const { store: s, emails } = twoStage(async () => ({
    classification: classified("SALES_LEAD"),
  }));
  await setUpLetsTalk(["SALES_LEAD", "JUNK"]);
  await s.enqueue(event);
  await s.routeOne();
  assert.deepEqual(await deliveries(), { classify: "pending:null" });

  assert.equal(await s.deliverOne(), true);
  assert.deepEqual(await deliveries(), {
    classify: "delivered",
    "reply-SALES_LEAD": "pending:null",
  });
  const row = await classification();
  assert.equal(row.label, "SALES_LEAD");
  assert.equal(row.status, "CLASSIFIED");
  assert.equal(row.confidence, "0.9000");
  assert.equal(row.workflowRunId, RUN_ID);
  assert.ok(row.classifiedAt);

  // The label flow sees the stored classification in its context.
  assert.equal(await s.deliverOne(), true);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].flowSettings, { flow: "SALES_LEAD" });
  assert.equal(emails[0].context?.classification?.label, "SALES_LEAD");
  assert.equal(emails[0].context?.classification?.confidence, 0.9);
  assert.equal(await s.deliverOne(), false);
});

test("JUNK has no flow, so nothing is sent; disabled label flows get no queued delivery", async () => {
  const { store: s, emails } = twoStage(async () => ({
    classification: classified("JUNK"),
  }));
  await setUpLetsTalk(["SALES_LEAD"]);
  await s.enqueue(event);
  await s.routeOne();
  await s.deliverOne();
  assert.deepEqual(await deliveries(), { classify: "delivered" });
  assert.equal((await classification()).label, "JUNK");

  // Shadow mode: a flow for the label exists but is disabled. It must not queue a reply
  // that would go out when the flow is enabled later.
  await pool.query(
    'TRUNCATE forms."ProcessorDelivery", forms."ProcessorEvent", forms."SubmissionClassification"',
  );
  await setUpLetsTalk(["JUNK"]);
  await pool.query(
    `UPDATE forms."ProcessorFlow" SET enabled = false WHERE id = 'reply-JUNK'`,
  );
  await s.enqueue(event);
  await s.routeOne();
  await s.deliverOne();
  assert.deepEqual(await deliveries(), { classify: "delivered" });
  await pool.query(
    `UPDATE forms."ProcessorFlow" SET enabled = true WHERE id = 'reply-JUNK'`,
  );
  assert.equal(await s.deliverOne(), false);
  assert.equal(emails.length, 0);
});

test("a retryable failure saves the in-progress run with the deferred delivery", async () => {
  const { store: s } = twoStage(async () => {
    throw new ActionError("ai_timeout", {
      workflowId: "lets-talk-classification",
      status: "PENDING",
      label: "UNKNOWN",
      workflowRunId: RUN_ID,
      attempts: 1,
      lastError: "ai_timeout",
    });
  });
  await setUpLetsTalk(["SALES_LEAD"]);
  await s.enqueue(event);
  await s.routeOne();
  await s.deliverOne();
  assert.deepEqual(await deliveries(), { classify: "pending:ai_timeout" });
  const row = await classification();
  assert.deepEqual(
    {
      label: row.label,
      status: row.status,
      runId: row.workflowRunId,
      attempts: row.attempts,
      lastError: row.lastError,
    },
    {
      label: "UNKNOWN",
      status: "PENDING",
      runId: RUN_ID,
      attempts: 1,
      lastError: "ai_timeout",
    },
  );
});

test("a final failure records FAILED/UNKNOWN and routes the UNKNOWN fallback", async () => {
  const { store: s, emails } = twoStage(async () => ({
    classification: {
      workflowId: "lets-talk-classification",
      status: "FAILED",
      label: "UNKNOWN",
      attempts: 5,
      lastError: "ai_run_failed",
    },
  }));
  await setUpLetsTalk(["UNKNOWN", "SALES_LEAD"]);
  await s.enqueue(event);
  await s.routeOne();
  await s.deliverOne();
  await s.deliverOne();
  assert.deepEqual(await deliveries(), {
    classify: "delivered",
    "reply-UNKNOWN": "delivered",
  });
  assert.equal((await classification()).status, "FAILED");
  assert.equal(emails[0].context?.classification?.lastError, "ai_run_failed");
});

test("a submission deleted before classification completes the delivery without a row or actions", async () => {
  const { store: s } = twoStage(async () => ({
    classification: classified("SALES_LEAD"),
  }));
  await setUpLetsTalk(["SALES_LEAD"]);
  await pool.query('DELETE FROM forms."Submission"');
  await s.enqueue(event);
  await s.routeOne();
  assert.equal(await s.deliverOne(), true);
  assert.deepEqual(await deliveries(), {
    classify: "skipped_submission_missing",
  });
  assert.equal(await classification(), undefined);
});

test("the reply-cap counter counts other submissions' accepted replies to the same address", async () => {
  const replyFlows = new Set(["reply-SALES_LEAD"]);
  const counts: number[] = [];
  const counting = new Store(
    pool,
    new Map<string, Action>([
      [
        "ai-classify",
        { execute: async () => ({ classification: classified("SALES_LEAD") }) },
      ],
      [
        "sendgrid-email",
        {
          execute: async (_event, _settings, context) => {
            counts.push(
              await context!.recentSubmitterSends("TEST@example.com"),
            );
            return undefined;
          },
        },
      ],
    ]),
    new Map(),
    { submitterFlowIds: replyFlows },
  );
  const second = {
    ...event,
    submissionId: "bf1d6716-26bf-4b66-aa23-9904f22d8b41",
  };
  for (const submission of [event, second]) {
    await setUpLetsTalk(["SALES_LEAD"], submission.submissionId);
    await counting.enqueue(submission);
    await counting.routeOne();
    await counting.deliverOne();
    await counting.deliverOne();
  }
  // First reply: nothing before it. Second: the first submission's accepted reply.
  assert.deepEqual(counts, [0, 1]);
  // Skipped sends and replies older than 24 hours don't count.
  await pool.query(
    `UPDATE forms."ProcessorDelivery" SET "deliveredAt" = now() - interval '25 hours'`,
  );
  const third = {
    ...event,
    submissionId: "0b8f7c3e-5a2d-4c6b-9e1f-7a3d2c1b0e9f",
  };
  await setUpLetsTalk(["SALES_LEAD"], third.submissionId);
  await counting.enqueue(third);
  await counting.routeOne();
  await counting.deliverOne();
  await counting.deliverOne();
  assert.deepEqual(counts, [0, 1, 0]);
});

test("the migration seeds the Let's talk flows disabled, and stage 1 ignores the label flows", async () => {
  await pool.query('DELETE FROM forms."ProcessorFlow"');
  await pool.query('INSERT INTO forms."Submission" (id) VALUES ($1)', [
    event.submissionId,
  ]);
  await pool.query(
    await readFile(
      new URL("../fixtures/processor-schema.sql", import.meta.url),
      "utf8",
    ).then((sql) =>
      sql.slice(sql.indexOf('INSERT INTO forms."ProcessorFlow"')),
    ),
  );
  await pool.query(
    await readFile(
      new URL("../fixtures/lets-talk-key.sql", import.meta.url),
      "utf8",
    ).then((sql) => sql.slice(0, sql.indexOf("-- Retry routing"))),
  );
  const migration = await readFile(
    new URL("../fixtures/lets-talk-classification.sql", import.meta.url),
    "utf8",
  );
  await pool.query(
    migration.slice(migration.indexOf('INSERT INTO forms."ProcessorFlow"')),
  );
  const { rows } = await pool.query(
    'SELECT id, enabled FROM forms."ProcessorFlow" ORDER BY id',
  );
  assert.equal(rows.length, 8);
  assert.ok(rows.every((flow) => !flow.enabled));
  await pool.query('UPDATE forms."ProcessorFlow" SET enabled = true');
  await store.enqueue(event);
  await store.routeOne();
  assert.deepEqual(Object.keys(await deliveries()), [
    "lets-talk-classify",
    "lets-talk-sales-email",
  ]);
});
