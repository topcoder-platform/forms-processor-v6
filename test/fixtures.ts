import type { Submission } from "../src/contracts.js";
export const event: Submission = {
  submissionId: "25fa4e9d-b6bb-4013-983b-20d243a22ca2",
  formKey: "lets_talk",
  version: 1,
  submittedAt: "2026-09-28T00:00:00.000Z",
  memberId: null,
  sourcePage: "https://www.topcoder.com/lets-talk",
  answers: {
    firstname: "Test",
    lastname: "Example",
    email: "test@example.com",
    company: "Example",
    interested_in: "crowdsourcing",
    consent: false,
    count: 0,
    interests: ["design", "development"],
  },
};
export const envelope = {
  topic: "form.submitted",
  originator: "forms-api-v6",
  "mime-type": "application/json",
  timestamp: event.submittedAt,
  payload: event,
};
export const settings = {
  recipients: ["sales@example.com"],
  templateId: "d-" + "a".repeat(32),
  fromEmail: "noreply@example.com",
};
