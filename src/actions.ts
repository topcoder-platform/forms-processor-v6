import { z } from "zod";
import type { Submission } from "./contracts.js";
import { BusError, type EventPublisher } from "./bus.js";

export interface Action {
  execute(event: Submission, settings: unknown): Promise<void>;
}
/** An action failure represented by a stable code safe to persist and log. */
export class ActionError extends Error {}
export const emailSettingsSchema = z
  .object({
    recipients: z.array(z.email()).min(1).max(1000),
    templateId: z.string().regex(/^d-[a-f0-9]{32}$/),
    fromEmail: z.email().nullish(),
    fromName: z.string().max(200).optional(),
  })
  .strict();

/** Requests email delivery through Bus API's external.action.email topic and email-service-v6. */
export class BusEmail implements Action {
  /** Accepts the authenticated event publisher; undefined permits disabled flows before configuration. Never throws. */
  constructor(private readonly publisher: EventPublisher | undefined) {}

  /** Publish configured recipients, template, and submission data using the shared v3 email contract.
   * Optional sender overrides email-service-v6's default. Resolves on Bus API acceptance;
   * throws a sanitized ActionError for invalid settings, absent configuration, or publication failure.
   */
  async execute(event: Submission, settings: unknown): Promise<void> {
    const parsed = emailSettingsSchema.safeParse(settings);
    if (!parsed.success) throw new ActionError("invalid_email_settings");
    if (!this.publisher) throw new ActionError("missing_bus_configuration");
    const { recipients, templateId, fromEmail, fromName } = parsed.data;
    try {
      await this.publisher.postEvent({
        topic: "external.action.email",
        originator: "forms-processor-v6",
        timestamp: new Date().toISOString(),
        "mime-type": "application/json",
        key: event.submissionId,
        payload: {
          recipients: [
            ...new Set(recipients.map((email) => email.toLowerCase())),
          ],
          sendgrid_template_id: templateId,
          version: "v3",
          ...(fromEmail
            ? {
                from: fromName
                  ? { email: fromEmail, name: fromName }
                  : fromEmail,
              }
            : {}),
          data: {
            ...event,
            fields: Object.entries(event.answers).map(([key, value]) => ({
              key,
              value: Array.isArray(value) ? value.join(", ") : String(value),
            })),
          },
        },
      });
    } catch (error) {
      throw new ActionError(
        error instanceof BusError ? error.message : "bus_publish_failed",
      );
    }
  }
}
