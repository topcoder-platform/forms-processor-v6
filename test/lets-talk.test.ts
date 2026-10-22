import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  safeFirstName,
  submitterTemplateData,
  toClassificationInput,
} from "../src/lets-talk.js";
import {
  LETS_TALK_FLOWS,
  LETS_TALK_SUBMITTER_FLOWS,
  letsTalkFlowSettings,
} from "../src/lets-talk-flows.js";
import { event } from "./fixtures.js";

const withAnswers = (answers: Record<string, string>) => ({
  ...event,
  answers: { ...event.answers, ...answers },
});

test("maps a submission to the classification input with option labels and no UTM fields", () => {
  const input = toClassificationInput({
    ...event,
    submittedAt: "2026-09-28T02:00:00.000+02:00",
    memberId: "88774411",
    answers: {
      interested_in: "app_design_development",
      firstname: " Ana ",
      lastname: "García",
      email: "ana@acme.es",
      company: "Acme S.L.",
      briefly_describe_your_inquiry: "  Buscamos un equipo React. ",
      utm_source__c: "google",
      leadsource: "landing_page",
    },
  });
  assert.deepEqual(input, {
    submissionId: event.submissionId,
    submittedAt: "2026-09-28T00:00:00.000Z",
    memberId: "88774411",
    interestedIn: "App Design and Development",
    firstName: "Ana",
    lastName: "García",
    workEmail: "ana@acme.es",
    companyName: "Acme S.L.",
    message: "Buscamos un equipo React.",
  });
});

test("omits an empty message and an anonymous member, and keeps unknown option keys", () => {
  const input = toClassificationInput(
    withAnswers({
      briefly_describe_your_inquiry: "   ",
      interested_in: "new_option",
    }),
  );
  assert.equal(Object.hasOwn(input, "message"), false);
  assert.equal(Object.hasOwn(input, "memberId"), false);
  assert.equal(input.interestedIn, "new_option");
});

test("keeps only a first name that can't carry a link or markup", () => {
  const name = (firstname: string) => safeFirstName(withAnswers({ firstname }));
  assert.equal(name("  Mary   Jane "), "Mary Jane");
  assert.equal(name("O'Brien"), "O'Brien");
  assert.equal(name("José-Luis"), "José-Luis");
  assert.equal(name("x".repeat(60)), "x".repeat(40));
  for (const unsafe of [
    "visit evil.com",
    "http://evil.example",
    "www evil",
    "a@b.co",
    "Win 1000$",
    "<b>Ana</b>",
    "{{admin}}",
    "Ana / Bob",
    "   ",
  ])
    assert.equal(name(unsafe), undefined, unsafe);
});

test("submitter template data holds only the first name and the interest label", () => {
  assert.deepEqual(
    submitterTemplateData(
      withAnswers({
        firstname: "Ana",
        interested_in: "crowdsourcing",
        briefly_describe_your_inquiry: "Click https://evil.example",
      }),
    ),
    { firstName: "Ana", interestArea: "Crowdsourced Innovation" },
  );
  assert.deepEqual(
    submitterTemplateData({ ...event, answers: { firstname: "http://x.io" } }),
    {},
  );
});

const base = {
  DATABASE_URL: "postgresql://localhost/test",
  KAFKA_URL: "localhost:9092",
};

test("flow settings: the sales reply's first address is reply-to and the rest are copied", () => {
  const settings = letsTalkFlowSettings(
    config({
      ...base,
      LETS_TALK_SALES_REPLY_TEMPLATE_ID: "d-" + "b".repeat(32),
      LETS_TALK_SALES_REPLY_TO:
        "Kiril@topcoder.com, ramzy@topcoder.com, sales@topcoder.com",
    }),
  );
  assert.deepEqual(settings.get(LETS_TALK_FLOWS.salesReply), {
    recipientsFromAnswer: "email",
    templateId: "d-" + "b".repeat(32),
    replyCapPerDay: 1,
    replyTo: "kiril@topcoder.com",
    cc: ["ramzy@topcoder.com", "sales@topcoder.com"],
  });
});

test("flow settings: defaults, support forward and classification", () => {
  const settings = letsTalkFlowSettings(config(base));
  assert.deepEqual(settings.get(LETS_TALK_FLOWS.salesReply), {
    recipientsFromAnswer: "email",
    templateId: "",
    replyCapPerDay: 1,
    replyTo: "kiril.kartunov@topcoder.com",
    cc: ["ramzy@topcoder.com"],
  });
  assert.deepEqual(settings.get(LETS_TALK_FLOWS.supportForward), {
    recipients: ["support@topcoder.com"],
    templateId: "",
    replyToFromAnswer: "email",
  });
  assert.deepEqual(settings.get(LETS_TALK_FLOWS.classify), {
    workflowId: "lets-talk-classification",
    maxAttempts: 5,
    maxAgeMinutes: 30,
  });
  for (const flow of LETS_TALK_SUBMITTER_FLOWS)
    assert.equal(
      (settings.get(flow) as { recipientsFromAnswer?: string })
        .recipientsFromAnswer,
      "email",
      flow,
    );
  assert.equal(
    LETS_TALK_SUBMITTER_FLOWS.has(LETS_TALK_FLOWS.supportForward),
    false,
  );
});
