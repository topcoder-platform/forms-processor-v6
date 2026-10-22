import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseEvent,
  InvalidEvent,
  matches,
  awaitsClassification,
  matchesLabel,
} from "../src/contracts.js";
import { config } from "../src/config.js";
import { retrySeconds } from "../src/store.js";
import { event, envelope } from "./fixtures.js";

test("accepts the forms-api Bus API envelope with false/zero/multi-select answers", () => {
  assert.deepEqual(parseEvent(Buffer.from(JSON.stringify(envelope))), event);
});
for (const invalid of [
  null,
  "",
  "{",
  JSON.stringify(event),
  JSON.stringify({ ...envelope, originator: "other" }),
  JSON.stringify({ ...envelope, topic: "other" }),
  JSON.stringify({ ...envelope, payload: { ...event, submissionId: "bad" } }),
  JSON.stringify({
    ...envelope,
    payload: { ...event, answers: { nested: {} } },
  }),
]) {
  test(`rejects malformed envelope ${String(invalid).slice(0, 25)}`, () =>
    assert.throws(
      () => parseEvent(invalid === null ? null : Buffer.from(invalid)),
      InvalidEvent,
    ));
}
test("empty rules match every submission", () =>
  assert.equal(matches({ all: [] }, event), true));
test("combines typed equality, membership, contains, and existence with AND", () => {
  assert.equal(
    matches(
      {
        all: [
          { field: "consent", operator: "equals", value: false },
          { field: "count", operator: "equals", value: 0 },
          {
            field: "interested_in",
            operator: "in",
            values: ["crowdsourcing", "freelancers"],
          },
          { field: "interests", operator: "contains", value: "design" },
          { field: "firstname", operator: "exists" },
        ],
      },
      event,
    ),
    true,
  );
  assert.equal(
    matches(
      { all: [{ field: "count", operator: "equals", value: "0" }] },
      event,
    ),
    false,
  );
  assert.equal(
    matches({ all: [{ field: "missing", operator: "exists" }] }, event),
    false,
  );
  assert.equal(
    matches({ all: [{ field: "toString", operator: "exists" }] }, event),
    false,
  );
});
test("invalid rules never silently match", () =>
  assert.throws(() => matches({ any: [] }, event)));
test("retry delay increases to a one-hour cap", () =>
  assert.deepEqual([0, 1, 50].map(retrySeconds), [5, 10, 3600]));
test("configuration defaults to retained-event replay and rejects invalid boolean settings", () => {
  const env = {
    DATABASE_URL: "postgresql://user:secret@localhost/db",
    KAFKA_URL: "one:9092, two:9092",
  };
  assert.equal(config(env).KAFKA_FROM_BEGINNING, true);
  assert.deepEqual(config(env).KAFKA_URL, ["one:9092", "two:9092"]);
  assert.throws(
    () => config({ ...env, KAFKA_SSL_ENABLED: "yes" }),
    /KAFKA_SSL_ENABLED/,
  );
  assert.throws(
    () => config({ ...env, DATABASE_URL: "secret" }),
    (error) => error instanceof Error && !error.message.includes("secret"),
  );
});
test("classification rules mark stage-2 flows and match their labels and answers", () => {
  assert.equal(awaitsClassification({ all: [] }), false);
  const sales = { all: [], classification: ["SALES_LEAD"] };
  assert.equal(awaitsClassification(sales), true);
  assert.equal(matchesLabel(sales, event, "SALES_LEAD"), true);
  assert.equal(matchesLabel(sales, event, "JUNK"), false);
  // A stage-1 flow never matches a label.
  assert.equal(matchesLabel({ all: [] }, event, "SALES_LEAD"), false);
  // Answer predicates still apply on top of the label.
  const crowdsourcingOnly = {
    all: [{ field: "interested_in", operator: "equals", value: "freelancers" }],
    classification: ["SALES_LEAD", "UNKNOWN"],
  };
  assert.equal(matchesLabel(crowdsourcingOnly, event, "UNKNOWN"), false);
  for (const invalid of [
    { all: [], classification: [] },
    { all: [], classification: ["sales_lead"] },
    { all: [], classification: "SALES_LEAD" },
  ])
    assert.throws(() => awaitsClassification(invalid));
});
