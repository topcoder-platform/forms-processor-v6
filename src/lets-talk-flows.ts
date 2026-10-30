import type { Config } from "./config.js";
import { LETS_TALK_ANSWERS } from "./lets-talk.js";

/** The tc-ai-api workflow that classifies Let's talk submissions. */
export const LETS_TALK_WORKFLOW_ID = "lets-talk-classification";

/** Let's talk flow ids, as seeded by forms-api-v6 migration 20261022010000_lets_talk_classification. */
export const LETS_TALK_FLOWS = {
  legacySalesEmail: "lets-talk-sales-email",
  classify: "lets-talk-classify",
  opportunityReply: "lets-talk-community-opportunity-reply",
  skillsReply: "lets-talk-community-skills-reply",
  generalReply: "lets-talk-community-general-reply",
  wiproReply: "lets-talk-wipro-queries-reply",
  supportForward: "lets-talk-support-forward",
  salesReply: "lets-talk-sales-reply",
} as const;

/** Flows that email the submitter; they share the per-address reply cap. */
export const LETS_TALK_SUBMITTER_FLOWS: ReadonlySet<string> = new Set([
  LETS_TALK_FLOWS.opportunityReply,
  LETS_TALK_FLOWS.skillsReply,
  LETS_TALK_FLOWS.generalReply,
  LETS_TALK_FLOWS.wiproReply,
  LETS_TALK_FLOWS.salesReply,
]);

/**
 * Settings for every Let's talk flow, from SSM-backed configuration. They replace the
 * database settings of these flow ids (as for the existing sales email). An empty template id
 * or recipient list leaves its flow's deliveries deferred with invalid_email_settings until set.
 * Never throws.
 */
export function letsTalkFlowSettings(config: Config): Map<string, unknown> {
  const reply = (templateId: string) => ({
    recipientsFromAnswer: LETS_TALK_ANSWERS.email,
    templateId,
    replyCapPerDay: config.LETS_TALK_REPLY_CAP_PER_DAY,
  });
  return new Map<string, unknown>([
    [
      LETS_TALK_FLOWS.legacySalesEmail,
      {
        recipients: config.LETS_TALK_RECIPIENTS,
        templateId: config.LETS_TALK_SENDGRID_TEMPLATE_ID,
      },
    ],
    [
      LETS_TALK_FLOWS.classify,
      {
        workflowId: LETS_TALK_WORKFLOW_ID,
        maxAttempts: config.LETS_TALK_CLASSIFY_MAX_ATTEMPTS,
        maxAgeMinutes: config.LETS_TALK_CLASSIFY_MAX_AGE_MINUTES,
      },
    ],
    [
      LETS_TALK_FLOWS.opportunityReply,
      reply(config.LETS_TALK_OPPORTUNITY_TEMPLATE_ID),
    ],
    [LETS_TALK_FLOWS.skillsReply, reply(config.LETS_TALK_SKILLS_TEMPLATE_ID)],
    [LETS_TALK_FLOWS.generalReply, reply(config.LETS_TALK_GENERAL_TEMPLATE_ID)],
    [LETS_TALK_FLOWS.wiproReply, reply(config.LETS_TALK_WIPRO_TEMPLATE_ID)],
    [
      LETS_TALK_FLOWS.salesReply,
      {
        ...reply(config.LETS_TALK_SALES_REPLY_TEMPLATE_ID),
        // Every address is a reply-to: a prospect's reply goes to all of them,
        // and none of them gets a copy of the reply itself.
        ...(config.LETS_TALK_SALES_REPLY_TO.length
          ? { replyTo: config.LETS_TALK_SALES_REPLY_TO }
          : {}),
      },
    ],
    [
      LETS_TALK_FLOWS.supportForward,
      {
        recipients: config.LETS_TALK_SUPPORT_RECIPIENTS,
        templateId: config.LETS_TALK_SUPPORT_TEMPLATE_ID,
        // Support replies go straight to the submitter.
        replyToFromAnswer: LETS_TALK_ANSWERS.email,
      },
    ],
  ]);
}
