-- SendGrid message IDs reported by email-service-v6 (external.action.email.sent) for
-- processor email deliveries; forms-processor-v6 matches them by <submissionId>:<flowId>.
ALTER TABLE forms."ProcessorDelivery"
  ADD COLUMN "sendgridMessageId" VARCHAR(255),
  ADD COLUMN "emailSentAt" TIMESTAMPTZ(3);
