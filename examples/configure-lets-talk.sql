-- Replace the three TBD settings, verify the SendGrid API key, then execute as an authorized DB admin.
-- Enabled remains false here deliberately. Enable with a separate UPDATE after configuration is complete.
UPDATE forms."ProcessorFlow"
SET settings = jsonb_build_object(
      'recipients', jsonb_build_array('TBD'),
      'templateId', 'TBD',
      'fromEmail', 'TBD',
      'fromName', 'Topcoder'
    ),
    "updatedAt" = now()
WHERE id = 'lets-talk-sales-email';

-- UPDATE forms."ProcessorFlow" SET enabled = true, "updatedAt" = now()
-- WHERE id = 'lets-talk-sales-email';
