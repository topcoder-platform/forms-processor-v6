import { test } from "node:test";
import assert from "node:assert/strict";
import { SendGridEmail } from "../src/actions.js";
import { event, settings } from "./fixtures.js";

test("sends configured recipients/template and typed answers without allowing answers to replace metadata", async () => {
  let body: Record<string, unknown> = {};
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.sendgrid.com/v3/mail/send");
    body = JSON.parse(String(init?.body));
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer test-key",
    );
    return new Response(null, { status: 202 });
  };
  await new SendGridEmail("test-key", false, request).execute(event, settings);
  assert.equal(body.template_id, settings.templateId);
  const personalizations = body.personalizations as {
    to: { email: string }[];
    dynamic_template_data: typeof event;
  }[];
  assert.deepEqual(personalizations[0].to, [{ email: "sales@example.com" }]);
  assert.deepEqual(
    personalizations[0].dynamic_template_data.answers,
    event.answers,
  );
  assert.equal(body.mail_settings, undefined);
});
test("TBD settings and missing key never perform network requests", async () => {
  const request: typeof fetch = async () => {
    assert.fail("must not send");
  };
  await assert.rejects(
    new SendGridEmail("key", false, request).execute(event, {
      recipients: [],
      templateId: null,
      fromEmail: null,
    }),
    /invalid_email_settings/,
  );
  await assert.rejects(
    new SendGridEmail(undefined, false, request).execute(event, settings),
    /missing_sendgrid_key/,
  );
});
for (const status of [400, 401, 429, 500]) {
  test(`sanitizes SendGrid ${status} responses`, async () => {
    const request: typeof fetch = async () =>
      new Response("secret provider response", { status });
    await assert.rejects(
      new SendGridEmail("key", false, request).execute(event, settings),
      new RegExp(`^Error: sendgrid_http_${status}$`),
    );
  });
}
test("sanitizes network errors", async () => {
  const request: typeof fetch = async () => {
    throw new Error("secret");
  };
  await assert.rejects(
    new SendGridEmail("key", false, request).execute(event, settings),
    /sendgrid_network_or_timeout/,
  );
});
test("sandbox explicitly sets mail_settings and accepts validation status", async () => {
  const request: typeof fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).mail_settings, {
      sandbox_mode: { enable: true },
    });
    return new Response(null, { status: 200 });
  };
  await new SendGridEmail("key", true, request).execute(event, settings);
});
