-- Replace TBD recipients/template, verify Bus API M2M configuration, then execute as an authorized DB admin.
-- fromEmail is optional: use null for the email-service-v6 default, or a verified sender override.
-- Enabled remains false here deliberately. Enable with a separate UPDATE after configuration is complete.
UPDATE forms."ProcessorFlow"
SET settings = jsonb_build_object(
      'recipients', jsonb_build_array('TBD'),
      'templateId', 'TBD',
      'fromEmail', NULL,
      'fromName', 'Topcoder'
    ),
    "updatedAt" = now()
WHERE id = 'lets-talk-sales-email';

-- UPDATE forms."ProcessorFlow" SET enabled = true, "updatedAt" = now()
-- WHERE id = 'lets-talk-sales-email';
