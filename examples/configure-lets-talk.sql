-- Run only after the API form-key migration, processor deployment, and SSM setup.
-- Recipients/template come exclusively from these SecureStrings at task startup:
-- /config/forms-processor-v6/appvar/LETS_TALK_RECIPIENTS
-- /config/forms-processor-v6/appvar/LETS_TALK_SENDGRID_TEMPLATE_ID
-- Redeploy after setting them. The sender comes from email-service-v6's default.
-- Review queued deliveries before enabling: they will also be sent.
UPDATE forms."ProcessorFlow"
SET enabled = true, "updatedAt" = now()
WHERE id = 'lets-talk-sales-email' AND "formKey" = 'lets_talk'
  AND action = 'sendgrid-email'
RETURNING id, "formKey", enabled;

-- Pause pending sends when necessary (in-progress sends may complete):
-- UPDATE forms."ProcessorFlow" SET enabled = false, "updatedAt" = now()
-- WHERE id = 'lets-talk-sales-email';
