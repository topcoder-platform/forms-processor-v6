import { test } from "node:test";
import assert from "node:assert/strict";
import { ingest, ingestEmailSent } from "../src/consumer.js";
import { envelope } from "./fixtures.js";

test("acknowledges only after durable persistence", async () => {
  const order: string[] = [];
  await ingest(
    {
      value: Buffer.from(JSON.stringify(envelope)),
      topic: "form.submitted",
      partition: 0,
      offset: 0n,
      commit: async () => {
        order.push("commit");
      },
    },
    async () => {
      order.push("persist");
    },
  );
  assert.deepEqual(order, ["persist", "commit"]);
});
test("database failure leaves offset uncommitted", async () => {
  await assert.rejects(
    ingest(
      {
        value: Buffer.from(JSON.stringify(envelope)),
        topic: "form.submitted",
        partition: 0,
        offset: 0n,
        commit: async () => {
          assert.fail("must not commit");
        },
      },
      async () => {
        throw new Error("DB failure");
      },
    ),
    /DB failure/,
  );
});
test("malformed events are acknowledged without executing any action", async () => {
  let committed = false;
  await ingest(
    {
      value: Buffer.from("{"),
      topic: "form.submitted",
      partition: 0,
      offset: 0n,
      commit: async () => {
        committed = true;
      },
    },
    async () => {
      assert.fail("must not enqueue");
    },
  );
  assert.equal(committed, true);
});

const emailSent = (payload: Record<string, unknown>) =>
  Buffer.from(
    JSON.stringify({
      topic: "external.action.email.sent",
      originator: "tc-email-service",
      timestamp: "2026-11-04T10:00:00.000Z",
      "mime-type": "application/json",
      payload: {
        correlationId: `${envelope.payload.submissionId}:lets-talk-sales-email`,
        sendgridMessageId: "sg-message-1",
        templateId: "d-" + "a".repeat(32),
        sentAt: "2026-11-04T10:00:01.000Z",
        ...payload,
      },
    }),
  );
const sentMessage = (value: Buffer, commit: () => Promise<void>) => ({
  value,
  topic: "external.action.email.sent",
  partition: 0,
  offset: 0n,
  commit,
});

test("email-sent reports are recorded on their delivery before the offset is committed", async () => {
  const order: string[] = [];
  await ingestEmailSent(
    sentMessage(emailSent({}), async () => {
      order.push("commit");
    }),
    async (sent) => {
      order.push("record");
      assert.deepEqual(sent, {
        submissionId: envelope.payload.submissionId,
        flowId: "lets-talk-sales-email",
        sendgridMessageId: "sg-message-1",
        sentAt: new Date("2026-11-04T10:00:01.000Z"),
      });
      return true;
    },
  );
  assert.deepEqual(order, ["record", "commit"]);
});

test("email-sent reports without a message ID, or for unknown deliveries, still commit", async () => {
  let committed = 0;
  const seen: (string | null)[] = [];
  const record = async (sent: { sendgridMessageId: string | null }) => {
    seen.push(sent.sendgridMessageId);
    return false;
  };
  await ingestEmailSent(
    sentMessage(emailSent({ sendgridMessageId: null }), async () => {
      committed++;
    }),
    record,
  );
  assert.deepEqual(seen, [null]);
  assert.equal(committed, 1);
});

test("malformed or foreign email-sent reports are discarded without recording", async () => {
  for (const value of [
    Buffer.from("{"),
    emailSent({ correlationId: "not-a-submission" }),
    emailSent({ correlationId: "00000000-0000-0000-0000-00000000000g:flow" }),
    emailSent({ correlationId: `${envelope.payload.submissionId}:` }),
    emailSent({ sentAt: "yesterday" }),
  ]) {
    let committed = false;
    await ingestEmailSent(
      sentMessage(value, async () => {
        committed = true;
      }),
      async () => assert.fail("must not record"),
    );
    assert.equal(committed, true);
  }
});

test("a failed email-sent write leaves the offset uncommitted", async () => {
  await assert.rejects(
    ingestEmailSent(
      sentMessage(emailSent({}), async () => assert.fail("must not commit")),
      async () => {
        throw new Error("DB failure");
      },
    ),
    /DB failure/,
  );
});
