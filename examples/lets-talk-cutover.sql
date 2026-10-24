-- Step 2 of the Let's talk AI rollout (docs/adr/0001, Decision 8): cut-over.
-- Run after the shadow-mode review, once each label flow's SendGrid template id is
-- set in SSM and the processor has been redeployed (docs/emails/README.md).
-- A flow whose template id is missing doesn't send: its deliveries wait and retry.
--
-- Effect: label actions start for new classifications. The legacy email only goes
-- out for submissions whose classification failed (label UNKNOWN). Submissions
-- classified during shadow mode get no reply.
BEGIN;

UPDATE forms."ProcessorFlow"
SET rules = '{"all":[],"classification":["UNKNOWN"]}', "updatedAt" = now()
WHERE id = 'lets-talk-sales-email' AND "formKey" = 'lets_talk';

UPDATE forms."ProcessorFlow"
SET enabled = true, "updatedAt" = now()
WHERE "formKey" = 'lets_talk' AND id IN (
  'lets-talk-community-opportunity-reply',
  'lets-talk-community-skills-reply',
  'lets-talk-community-general-reply',
  'lets-talk-wipro-queries-reply',
  'lets-talk-support-forward',
  'lets-talk-sales-reply'
)
RETURNING id, enabled;

COMMIT;

-- Rollback to shadow mode (a send already in progress may finish):
-- BEGIN;
-- UPDATE forms."ProcessorFlow" SET enabled = false, "updatedAt" = now()
--   WHERE "formKey" = 'lets_talk' AND rules ? 'classification' AND id <> 'lets-talk-sales-email';
-- UPDATE forms."ProcessorFlow" SET rules = '{"all":[]}', "updatedAt" = now()
--   WHERE id = 'lets-talk-sales-email';
-- COMMIT;
