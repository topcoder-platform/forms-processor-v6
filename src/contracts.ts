import { z } from "zod";

/** forms-api-v6's fixed submission topic. */
export const SUBMISSIONS_TOPIC = "form.submitted";
/** The only producer of email-sent reports. */
export const EMAIL_SENT_ORIGINATOR = "tc-email-service";

const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
export const answerSchema = z.union([scalarSchema, z.array(z.string())]);
export const submissionSchema = z.object({
  submissionId: z.uuid(),
  formKey: z.string().min(1).max(40),
  version: z.number().int().positive(),
  submittedAt: z.iso.datetime({ offset: true }),
  memberId: z.string().nullable(),
  sourcePage: z.string().nullable(),
  answers: z.record(z.string(), answerSchema),
});
export type Submission = z.infer<typeof submissionSchema>;
const envelopeSchema = z.object({
  topic: z.literal(SUBMISSIONS_TOPIC),
  originator: z.literal("forms-api-v6"),
  "mime-type": z.literal("application/json"),
  timestamp: z.iso.datetime({ offset: true }),
  payload: submissionSchema,
});

/** Identifies invalid input without including potentially sensitive submitted values. */
export class InvalidEvent extends Error {
  /** Creates a fixed safe message; takes no input and never throws. */
  constructor() {
    super("invalid_form_event");
  }
}

/** Parse a Bus API JSON buffer into a submission; throws InvalidEvent without input data. */
export function parseEvent(value: Buffer | null | undefined): Submission {
  try {
    return envelopeSchema.parse(JSON.parse(value?.toString("utf8") ?? ""))
      .payload;
  } catch {
    throw new InvalidEvent();
  }
}

/** A SendGrid send reported by email-service-v6 for an email this processor published. */
export interface EmailSent {
  submissionId: string;
  flowId: string;
  /** SendGrid's X-Message-Id; null when SendGrid returned none. */
  sendgridMessageId: string | null;
  sentAt: Date;
}
const emailSentEnvelopeSchema = z.object({
  topic: z.string().min(1),
  // Another producer on the topic must not be able to write message IDs onto deliveries.
  originator: z.literal(EMAIL_SENT_ORIGINATOR),
  "mime-type": z.literal("application/json"),
  timestamp: z.iso.datetime({ offset: true }),
  payload: z.object({
    // `<submissionId>:<flowId>`, as set by BusEmail.
    correlationId: z.string().regex(/^[0-9a-fA-F-]{36}:[^\s:]{1,100}$/),
    sendgridMessageId: z.string().min(1).max(255).nullable(),
    templateId: z.string().min(1).max(255),
    sentAt: z.iso.datetime({ offset: true }),
  }),
});

/** Parse an email-sent Bus envelope; throws InvalidEvent without input data for malformed or foreign correlation IDs. */
export function parseEmailSent(value: Buffer | null | undefined): EmailSent {
  try {
    const { payload } = emailSentEnvelopeSchema.parse(
      JSON.parse(value?.toString("utf8") ?? ""),
    );
    const separator = payload.correlationId.indexOf(":");
    return {
      submissionId: z.uuid().parse(payload.correlationId.slice(0, separator)),
      flowId: payload.correlationId.slice(separator + 1),
      sendgridMessageId: payload.sendgridMessageId,
      sentAt: new Date(payload.sentAt),
    };
  } catch {
    throw new InvalidEvent();
  }
}

/** An AI classification label, as stored in forms."SubmissionClassification".label. */
export const labelSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/);
/** The label of a submission that was never classified, or whose classification failed. */
export const UNKNOWN_LABEL = "UNKNOWN";

export const rulesSchema = z
  .object({
    all: z
      .array(
        z.discriminatedUnion("operator", [
          z
            .object({
              field: z.string().min(1),
              operator: z.literal("equals"),
              value: scalarSchema,
            })
            .strict(),
          z
            .object({
              field: z.string().min(1),
              operator: z.literal("in"),
              values: z
                .array(z.union([z.string(), z.number(), z.boolean()]))
                .min(1),
            })
            .strict(),
          z
            .object({
              field: z.string().min(1),
              operator: z.literal("contains"),
              value: z.string(),
            })
            .strict(),
          z
            .object({ field: z.string().min(1), operator: z.literal("exists") })
            .strict(),
        ]),
      )
      .default([]),
    /** Stage-2 flows: routed only after classification, for these labels (ADR 0001). */
    classification: z.array(labelSchema).min(1).optional(),
  })
  .strict();

/** True for stage-2 flows, which wait for the submission's classification. Throws on invalid admin rules. */
export function awaitsClassification(rules: unknown): boolean {
  return rulesSchema.parse(rules).classification !== undefined;
}

/** True when a stage-2 flow lists the label and its answer predicates match. Throws on invalid admin rules. */
export function matchesLabel(
  rules: unknown,
  event: Submission,
  label: string,
): boolean {
  const parsed = rulesSchema.parse(rules);
  return !!parsed.classification?.includes(label) && matches(parsed, event);
}

/** Match all configured answer predicates; empty rules match all. Throws on invalid admin rules. */
export function matches(rules: unknown, event: Submission): boolean {
  return rulesSchema.parse(rules).all.every((rule) => {
    const value = Object.hasOwn(event.answers, rule.field)
      ? event.answers[rule.field]
      : undefined;
    switch (rule.operator) {
      case "equals":
        return value === rule.value;
      case "in":
        return rule.values.some((candidate) => candidate === value);
      case "contains":
        return Array.isArray(value) && value.includes(rule.value);
      case "exists":
        return value !== undefined;
    }
  });
}
