import { test } from "node:test";
import assert from "node:assert/strict";
import { BusEmail, type ActionContext } from "../src/actions.js";
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

// ---------------------------------------------------------------------------
// Submitter replies and internal forwards (ADR 0001, Decisions 5 and 7)
// ---------------------------------------------------------------------------

const replySettings = {
  recipientsFromAnswer: "email",
  templateId: settings.templateId,
  replyCapPerDay: 1,
};
const context = (overrides: Partial<ActionContext> = {}): ActionContext => ({
  receivedAt: new Date(),
  classification: null,
  recentSubmitterSends: async () => 0,
  ...overrides,
});
function capture() {
  const published: BusEvent[] = [];
  return {
    published,
    action: new BusEmail({
      postEvent: async (value) => {
        published.push(value);
      },
    }),
  };
}

test("a submitter reply goes to the submitted address with only the first name and interest label", async () => {
  const { published, action } = capture();
  const submission = {
    ...event,
    answers: {
      ...event.answers,
      email: " Submitter@Example.com ",
      firstname: "Ana",
      briefly_describe_your_inquiry: "Visit https://evil.example now",
    },
  };
  await action.execute(submission, replySettings, context());
  assert.deepEqual(published[0].payload, {
    recipients: ["submitter@example.com"],
    sendgrid_template_id: settings.templateId,
    version: "v3",
    data: { firstName: "Ana", interestArea: "Crowdsourced Innovation" },
  });
});

test("the sales reply sets the trusted reply-to and copies the rest, never the recipient twice", async () => {
  const { published, action } = capture();
  await action.execute(
    event,
    {
      ...replySettings,
      replyTo: "Kiril.Kartunov@topcoder.com",
      cc: ["ramzy@topcoder.com", "TEST@example.com"],
    },
    context(),
  );
  assert.equal(published[0].payload.replyTo, "kiril.kartunov@topcoder.com");
  // The fixture submitter is test@example.com, so it is not also copied.
  assert.deepEqual(published[0].payload.cc, ["ramzy@topcoder.com"]);
});

test("the per-address cap skips a reply without publishing; a missing address is skipped too", async () => {
  const { published, action } = capture();
  const seen: string[] = [];
  assert.deepEqual(
    await action.execute(
      event,
      replySettings,
      context({
        recentSubmitterSends: async (address) => {
          seen.push(address);
          return 1;
        },
      }),
    ),
    { skipped: "reply_cap" },
  );
  assert.deepEqual(seen, ["test@example.com"]);
  assert.deepEqual(
    await action.execute(
      { ...event, answers: { email: "not an email" } },
      replySettings,
      context(),
    ),
    { skipped: "no_recipient_address" },
  );
  assert.equal(published.length, 0);
  // A cap of 0 disables the check.
  await action.execute(
    event,
    { ...replySettings, replyCapPerDay: 0 },
    context({
      recentSubmitterSends: async () => assert.fail("must not count"),
    }),
  );
  assert.equal(published.length, 1);
});

test("an internal forward replies to the submitter and carries the full submission and its classification", async () => {
  const { published, action } = capture();
  await action.execute(
    event,
    {
      recipients: ["support@topcoder.com"],
      templateId: settings.templateId,
      replyToFromAnswer: "email",
    },
    context({
      classification: {
        label: "COMMUNITY_SUPPORT",
        status: "CLASSIFIED",
        confidence: 0.8,
        needsReview: false,
        detectedLanguage: "en",
        rationale: "Payment not received.",
        workflowRunId: "6f1c2a9e-6b7d-4e8f-9a01-2b3c4d5e6f70",
        attempts: 1,
        lastError: null,
      },
    }),
  );
  const payload = published[0].payload as Record<
    string,
    Record<string, unknown>
  >;
  assert.deepEqual(payload.recipients, ["support@topcoder.com"]);
  assert.equal(payload.replyTo, "test@example.com");
  assert.equal(payload.data.submissionId, event.submissionId);
  assert.deepEqual(payload.data.answers, event.answers);
  assert.deepEqual(payload.data.classification, {
    label: "COMMUNITY_SUPPORT",
    status: "CLASSIFIED",
    confidence: 0.8,
    needsReview: false,
    rationale: "Payment not received.",
    workflowRunId: "6f1c2a9e-6b7d-4e8f-9a01-2b3c4d5e6f70",
  });
});

test("recipient settings must name exactly one source, and one reply-to", async () => {
  const { action } = capture();
  for (const bad of [
    { templateId: settings.templateId },
    { ...replySettings, recipients: ["a@example.com"] },
    { ...replySettings, replyTo: "a@example.com", replyToFromAnswer: "email" },
    { ...replySettings, templateId: "" },
    { ...replySettings, cc: ["not-an-email"] },
  ])
    await assert.rejects(
      action.execute(event, bad, context()),
      /invalid_email_settings/,
    );
});
