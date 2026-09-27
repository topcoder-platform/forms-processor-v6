import { test } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../src/consumer.js";
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
