import { test } from "node:test";
import assert from "node:assert/strict";
import { BusEmail } from "../src/actions.js";
import { BusError, type BusEvent } from "../src/bus.js";
import { event, settings } from "./fixtures.js";

test("publishes the standard v3 email envelope with trusted settings and nested answers", async () => {
  let published: BusEvent | undefined;
  await new BusEmail({
    postEvent: async (value) => {
      published = value;
    },
  }).execute(event, {
    ...settings,
    fromName: "Topcoder",
    recipients: ["sales@example.com", "SALES@example.com"],
  });
  assert.ok(published);
  assert.equal(published.topic, "external.action.email");
  assert.equal(published.originator, "forms-processor-v6");
  assert.equal(published["mime-type"], "application/json");
  assert.equal(published.key, event.submissionId);
  assert.ok(Number.isFinite(Date.parse(published.timestamp)));
  assert.deepEqual(published.payload, {
    recipients: ["sales@example.com"],
    sendgrid_template_id: settings.templateId,
    version: "v3",
    from: { email: settings.fromEmail, name: "Topcoder" },
    data: {
      ...event,
      fields: Object.entries(event.answers).map(([key, value]) => ({
        key,
        value: Array.isArray(value) ? value.join(", ") : String(value),
      })),
    },
  });
});
test("null/omitted sender uses email-service-v6's default sender", async () => {
  for (const fromEmail of [undefined, null]) {
    await new BusEmail({
      postEvent: async (value) => {
        assert.equal(Object.hasOwn(value.payload, "from"), false);
      },
    }).execute(event, { ...settings, fromEmail });
  }
});
test("TBD recipients/template never publish and missing Bus config is retryable", async () => {
  const action = new BusEmail({
    postEvent: async () => {
      assert.fail("must not publish");
    },
  });
  await assert.rejects(
    action.execute(event, {
      recipients: [],
      templateId: null,
      fromEmail: null,
    }),
    /invalid_email_settings/,
  );
  await assert.rejects(
    new BusEmail(undefined).execute(event, settings),
    /missing_bus_configuration/,
  );
});
test("awaits publication acknowledgement before completing", async () => {
  let release!: () => void;
  let completed = false;
  const pending = new BusEmail({
    postEvent: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  })
    .execute(event, settings)
    .then(() => {
      completed = true;
    });
  await Promise.resolve();
  assert.equal(completed, false);
  release();
  await pending;
  assert.equal(completed, true);
});
test("preserves safe Bus failure codes but withholds raw publisher errors", async () => {
  for (const error of [
    new BusError("bus_http_503"),
    new Error("secret body"),
  ]) {
    await assert.rejects(
      new BusEmail({
        postEvent: async () => {
          throw error;
        },
      }).execute(event, settings),
      error instanceof BusError ? /bus_http_503/ : /bus_publish_failed/,
    );
  }
});
