import { z } from "zod";
import type { Submission } from "./contracts.js";

export interface Action {
  execute(event: Submission, settings: unknown): Promise<void>;
}
/** An action failure represented by a stable code safe to persist and log. */
export class ActionError extends Error {}
export const emailSettingsSchema = z
  .object({
    recipients: z.array(z.email()).min(1).max(1000),
    templateId: z.string().regex(/^d-[a-f0-9]{32}$/),
    fromEmail: z.email(),
    fromName: z.string().max(200).optional(),
  })
  .strict();

/** Sends submission details through a configured SendGrid dynamic template. */
export class SendGridEmail implements Action {
  /** Accepts a secret API key, explicit sandbox toggle, and optional HTTP client for tests; never throws. */
  constructor(
    private readonly apiKey: string | undefined,
    private readonly sandbox = false,
    private readonly request: typeof fetch = fetch,
  ) {}

  /** Send one email to the configured list with nested answers/metadata; throws a sanitized ActionError on failure. */
  async execute(event: Submission, settings: unknown): Promise<void> {
    const parsed = emailSettingsSchema.safeParse(settings);
    if (!parsed.success) throw new ActionError("invalid_email_settings");
    if (!this.apiKey) throw new ActionError("missing_sendgrid_key");
    const { recipients, templateId, fromEmail, fromName } = parsed.data;
    let response: Response;
    try {
      response = await this.request("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { email: fromEmail, ...(fromName ? { name: fromName } : {}) },
          template_id: templateId,
          personalizations: [
            {
              to: [...new Set(recipients.map((x) => x.toLowerCase()))].map(
                (email) => ({ email }),
              ),
              dynamic_template_data: {
                ...event,
                fields: Object.entries(event.answers).map(([key, value]) => ({
                  key,
                  value: Array.isArray(value)
                    ? value.join(", ")
                    : String(value),
                })),
              },
              custom_args: {
                submissionId: event.submissionId,
                formKey: event.formKey,
              },
            },
          ],
          ...(this.sandbox
            ? { mail_settings: { sandbox_mode: { enable: true } } }
            : {}),
        }),
      });
    } catch {
      throw new ActionError("sendgrid_network_or_timeout");
    }
    // SendGrid returns 200 for sandbox validation and 202 for accepted mail.
    if (response.status !== 202 && !(this.sandbox && response.status === 200)) {
      await response.body?.cancel();
      throw new ActionError(`sendgrid_http_${response.status}`);
    }
    await response.body?.cancel();
  }
}
