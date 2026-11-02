import type { Config } from "./config.js";

/** SpaceTech landing page flow id, as seeded by forms-api-v6 migration 20261102010000_space_tech_challenge_email. */
export const SPACE_TECH_CHALLENGE_FLOW = "space-tech-challenge-email";

/**
 * Settings for the SpaceTech challenge notification, from SSM-backed configuration. They replace
 * the flow's database settings: every submission goes to SPACE_TECH_CHALLENGE_RECIPIENTS with the
 * submitter's email as reply-to. An empty recipient list or template id leaves its deliveries
 * deferred with invalid_email_settings until set. Never throws.
 */
export function spaceTechFlowSettings(config: Config): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      SPACE_TECH_CHALLENGE_FLOW,
      {
        recipients: config.SPACE_TECH_CHALLENGE_RECIPIENTS,
        templateId: config.SPACE_TECH_CHALLENGE_TEMPLATE_ID,
        // Replies go straight to the submitter.
        replyToFromAnswer: "email",
      },
    ],
  ]);
}
