import { z } from "zod";
import type { Submission } from "./contracts.js";
import { BusError, type EventPublisher } from "./bus.js";
import { submitterTemplateData } from "./lets-talk.js";

/** A submission's stored AI classification (forms."SubmissionClassification"). */
export interface StoredClassification {
  label: string;
  status: string;
  confidence: number | null;
  needsReview: boolean | null;
  detectedLanguage: string | null;
  rationale: string | null;
  workflowRunId: string | null;
  attempts: number;
  lastError: string | null;
}

/** A classification outcome an action asks the store to persist (ADR 0001, Decision 3). */
export interface ClassificationRecord {
  workflowId: string;
  status: "PENDING" | "CLASSIFIED" | "FAILED";
  label: string;
  confidence?: number;
  needsReview?: boolean;
  detectedLanguage?: string;
  rationale?: string;
  workflowRunId?: string;
  attempts: number;
  lastError?: string;
}

/** Per-delivery facts the store supplies to an action. */
export interface ActionContext {
  /** When the processor received the submission. */
  receivedAt: Date;
  /** The submission's stored classification, or null when there is none yet. */
  classification: StoredClassification | null;
  /** Deliveries of submitter-reply flows accepted for this address in the last 24 hours, other submissions only. */
  recentSubmitterSends(address: string): Promise<number>;
}

/** What a completed action reports back to the store. */
export interface ActionResult {
  /** A final classification: the store saves it and routes the flows waiting for its label. */
  classification?: ClassificationRecord;
  /** A stable code for a deliberate no-op (e.g. "reply_cap"); the delivery completes without sending. */
  skipped?: string;
}

export interface Action {
  execute(
    event: Submission,
    settings: unknown,
    context?: ActionContext,
  ): Promise<ActionResult | void>;
}
/** An action failure represented by a stable code safe to persist and log.
 * `classification` carries in-progress state (e.g. a timed-out run id) to save with the retry.
 */
export class ActionError extends Error {
  constructor(
    code: string,
    readonly classification?: ClassificationRecord,
  ) {
    super(code);
  }
}
export const emailSettingsSchema = z
  .object({
    /** Trusted recipients. Exactly one of recipients / recipientsFromAnswer is required. */
    recipients: z.array(z.email()).min(1).max(1000).optional(),
    /** Send to the address in this answer (the submitter). Template data is then reduced to
     * submitterTemplateData(), never the submission (ADR 0001, Decision 5). */
    recipientsFromAnswer: z.string().min(1).optional(),
    templateId: z.string().regex(/^d-[a-f0-9]{32}$/),
    fromEmail: z.email().nullish(),
    fromName: z.string().max(200).optional(),
    /** A trusted reply-to address, or the address in an answer (e.g. support forwards). */
    replyTo: z.email().optional(),
    replyToFromAnswer: z.string().min(1).optional(),
    /** Trusted copies, e.g. the sales team on a sales reply. */
    cc: z.array(z.email()).max(100).optional(),
    /** Submitter-reply cap per address per 24 hours; 0 or absent disables the check. */
    replyCapPerDay: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.recipients === undefined) !==
      (value.recipientsFromAnswer === undefined),
  )
  .refine((value) => !(value.replyTo && value.replyToFromAnswer));

const addressSchema = z.email();

/** The lower-cased email address in a string answer, or undefined. Never throws. */
function answerAddress(event: Submission, key: string): string | undefined {
  const value = Object.hasOwn(event.answers, key)
    ? event.answers[key]
    : undefined;
  if (typeof value !== "string") return undefined;
  const address = value.trim().toLowerCase();
  return addressSchema.safeParse(address).success ? address : undefined;
}

/** Requests email delivery through Bus API's external.action.email topic and email-service-v6. */
export class BusEmail implements Action {
  /** Accepts the authenticated event publisher; undefined permits disabled flows before configuration. Never throws. */
  constructor(private readonly publisher: EventPublisher | undefined) {}

  /** Publish one email using the shared v3 email contract. Recipients come from trusted settings,
   * or from the submission's own address for submitter replies (then with minimal template data
   * and a per-address cap). Resolves on Bus API acceptance, or with `skipped` when deliberately
   * not sent; throws a sanitized ActionError for invalid settings, absent configuration, or publication failure.
   */
  async execute(
    event: Submission,
    settings: unknown,
    context?: ActionContext,
  ): Promise<ActionResult | void> {
    const parsed = emailSettingsSchema.safeParse(settings);
    if (!parsed.success) throw new ActionError("invalid_email_settings");
    if (!this.publisher) throw new ActionError("missing_bus_configuration");
    const s = parsed.data;
    let recipients: string[];
    if (s.recipientsFromAnswer) {
      const address = answerAddress(event, s.recipientsFromAnswer);
      if (!address) return { skipped: "no_recipient_address" };
      if (
        s.replyCapPerDay &&
        context &&
        (await context.recentSubmitterSends(address)) >= s.replyCapPerDay
      )
        return { skipped: "reply_cap" };
      recipients = [address];
    } else {
      recipients = [
        ...new Set(s.recipients!.map((email) => email.toLowerCase())),
      ];
    }
    const replyTo =
      s.replyTo?.toLowerCase() ??
      (s.replyToFromAnswer
        ? answerAddress(event, s.replyToFromAnswer)
        : undefined);
    const cc = [
      ...new Set((s.cc ?? []).map((email) => email.toLowerCase())),
    ].filter((email) => !recipients.includes(email));
    try {
      await this.publisher.postEvent({
        topic: "external.action.email",
        originator: "forms-processor-v6",
        timestamp: new Date().toISOString(),
        "mime-type": "application/json",
        key: event.submissionId,
        payload: {
          recipients,
          sendgrid_template_id: s.templateId,
          version: "v3",
          ...(s.fromEmail
            ? {
                from: s.fromName
                  ? { email: s.fromEmail, name: s.fromName }
                  : s.fromEmail,
              }
            : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(cc.length ? { cc } : {}),
          data: s.recipientsFromAnswer
            ? submitterTemplateData(event)
            : internalTemplateData(event, context),
        },
      });
    } catch (error) {
      throw new ActionError(
        error instanceof BusError ? error.message : "bus_publish_failed",
      );
    }
  }
}

/** Template data for internal recipients: the full submission, plus its classification when known. */
function internalTemplateData(
  event: Submission,
  context?: ActionContext,
): Record<string, unknown> {
  const classification = context?.classification;
  return {
    ...event,
    fields: Object.entries(event.answers).map(([key, value]) => ({
      key,
      value: Array.isArray(value) ? value.join(", ") : String(value),
    })),
    ...(classification
      ? {
          classification: {
            label: classification.label,
            status: classification.status,
            confidence: classification.confidence,
            needsReview: classification.needsReview,
            rationale: classification.rationale,
            workflowRunId: classification.workflowRunId,
          },
        }
      : {}),
  };
}
