import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
const base = {
  DATABASE_URL: "postgresql://localhost/test",
  KAFKA_URL: "localhost:9092",
};

test("sales settings normalize comma-separated recipients and leave unconfigured delivery empty", () => {
  assert.deepEqual(config(base).LETS_TALK_RECIPIENTS, []);
  assert.equal(config(base).LETS_TALK_SENDGRID_TEMPLATE_ID, "");
  const settings = config({
    ...base,
    LETS_TALK_RECIPIENTS:
      " sales@example.com,OTHER@example.com,SALES@example.com ",
  });
  assert.deepEqual(settings.LETS_TALK_RECIPIENTS, [
    "sales@example.com",
    "other@example.com",
  ]);
});
test("invalid sales settings fail startup without disclosing values", () => {
  for (const [key, value] of [
    ["LETS_TALK_RECIPIENTS", "private@example.com,"],
    ["LETS_TALK_RECIPIENTS", "private@example.com,invalid"],
    ["LETS_TALK_SENDGRID_TEMPLATE_ID", "private-template"],
  ]) {
    assert.throws(
      () => config({ ...base, [key!]: value }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`^Invalid configuration: ${key}(?:\\.\\d+)?$`));
        return true;
      },
    );
  }
});
