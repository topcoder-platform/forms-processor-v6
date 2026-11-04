import { test } from "node:test";
import assert from "node:assert/strict";
import { emailSettingsSchema } from "../src/actions.js";
import { config } from "../src/config.js";
import {
  SPACE_TECH_CHALLENGE_FLOW,
  spaceTechFlowSettings,
} from "../src/space-tech-flows.js";

const base = {
  DATABASE_URL: "postgresql://localhost/test",
  KAFKA_URL: "localhost:9092",
};

test("space tech settings: recipients come from the environment, replies go to the submitter", () => {
  const settings = spaceTechFlowSettings(
    config({
      ...base,
      SPACE_TECH_CHALLENGE_RECIPIENTS:
        " Test-Support@topcoder.com, test2-support@topcoder.com,test-support@topcoder.com",
      SPACE_TECH_CHALLENGE_TEMPLATE_ID: "d-" + "c".repeat(32),
    }),
  ).get(SPACE_TECH_CHALLENGE_FLOW);
  assert.deepEqual(settings, {
    recipients: ["test-support@topcoder.com", "test2-support@topcoder.com"],
    templateId: "d-" + "c".repeat(32),
    replyToFromAnswer: "email",
  });
  assert.equal(emailSettingsSchema.safeParse(settings).success, true);
});

test("space tech settings: unset variables defer delivery and malformed ones fail startup", () => {
  const settings = spaceTechFlowSettings(config(base)).get(
    SPACE_TECH_CHALLENGE_FLOW,
  );
  assert.deepEqual(settings, {
    recipients: [],
    templateId: "",
    replyToFromAnswer: "email",
  });
  assert.equal(emailSettingsSchema.safeParse(settings).success, false);
  for (const [key, value] of [
    ["SPACE_TECH_CHALLENGE_RECIPIENTS", "test-support@topcoder.com,"],
    ["SPACE_TECH_CHALLENGE_TEMPLATE_ID", "d-123"],
  ])
    assert.throws(
      () => config({ ...base, [key!]: value }),
      new RegExp(`^Error: Invalid configuration: ${key}(?:\\.\\d+)?$`),
    );
});
