import type { Submission } from "./contracts.js";

/** Answer keys of the published Let's talk form (forms-api-v6 examples/lets-talk.json). */
export const LETS_TALK_ANSWERS = {
  interestedIn: "interested_in",
  firstName: "firstname",
  lastName: "lastname",
  email: "email",
  company: "company",
  message: "briefly_describe_your_inquiry",
} as const;

/**
 * Display labels of the "What are you interested in?" options. The AI workflow was
 * evaluated on these labels, and reply templates may show them (`interestArea`):
 * they come from the form's fixed option list, never from free text.
 */
export const INTEREST_LABELS: Readonly<Record<string, string>> = {
  crowdsourcing: "Crowdsourced Innovation",
  app_design_development: "App Design and Development",
  freelancers: "Flexible Talent Access",
};

const FIRST_NAME_MAX = 40;

/** Return a trimmed string answer, or undefined for absent/non-string/blank values. Never throws. */
function text(event: Submission, key: string): string | undefined {
  const value = Object.hasOwn(event.answers, key)
    ? event.answers[key]
    : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** The display label of the selected interest; an unknown option key is returned as-is. Never throws. */
export function interestArea(event: Submission): string | undefined {
  const key = text(event, LETS_TALK_ANSWERS.interestedIn);
  return key === undefined ? undefined : (INTEREST_LABELS[key] ?? key);
}

/**
 * A first name that is safe to show in an email to the address typed into the form (ADR 0001, Decision 5).
 * Whitespace is collapsed and the result capped at 40 characters. Anything that could
 * carry a link or markup — a URL, "@", digits, or markup/template characters — makes it
 * undefined, and templates then greet "there". Never throws.
 */
export function safeFirstName(event: Submission): string | undefined {
  const name = text(event, LETS_TALK_ANSWERS.firstName)?.replace(/\s+/g, " ");
  if (!name) return undefined;
  if (
    /[@\d<>{}[\]\\/|`"=:;]/.test(name) ||
    /\b(?:https?|www)\b|\.[a-z]{2,}\b/i.test(name)
  )
    return undefined;
  return [...name].slice(0, FIRST_NAME_MAX).join("").trim() || undefined;
}

/** The only data submitter-facing templates receive: no message, company or other free text. Never throws. */
export function submitterTemplateData(
  event: Submission,
): Record<string, string> {
  const firstName = safeFirstName(event);
  const interest = interestArea(event);
  return {
    ...(firstName ? { firstName } : {}),
    ...(interest ? { interestArea: interest } : {}),
  };
}

/**
 * Maps a Let's talk submission to the tc-ai-api `lets-talk-classification` input.
 * UTM and campaign answers are not sent. Never throws; the workflow validates the
 * result and reports invalid input as a failed run.
 */
export function toClassificationInput(
  event: Submission,
): Record<string, unknown> {
  const message = text(event, LETS_TALK_ANSWERS.message);
  return {
    submissionId: event.submissionId,
    submittedAt: new Date(event.submittedAt).toISOString(),
    ...(event.memberId ? { memberId: event.memberId } : {}),
    interestedIn: interestArea(event) ?? "",
    firstName: text(event, LETS_TALK_ANSWERS.firstName) ?? "",
    lastName: text(event, LETS_TALK_ANSWERS.lastName) ?? "",
    workEmail: text(event, LETS_TALK_ANSWERS.email) ?? "",
    companyName: text(event, LETS_TALK_ANSWERS.company) ?? "",
    ...(message ? { message } : {}),
  };
}
