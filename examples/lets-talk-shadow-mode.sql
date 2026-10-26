-- Step 1 of the Let's talk AI rollout (docs/adr/0001, Decision 8): shadow mode.
-- Run after forms-api-v6 migration 20261022010000_lets_talk_classification, a
-- processor deployment with AI_API_URL set, and a check that the processor's M2M
-- client holds the tc-ai-api scope ai:letstalk:classify.
--
-- Effect: every new submission is classified and its label shows in the reports UI.
-- Nothing changes for submitters: the legacy email still goes out for everything,
-- and the label flows stay disabled. Stage 2 routes enabled flows only, so no
-- replies queue up for the cut-over.
BEGIN;

-- Keep the legacy email unconditional while labels are reviewed.
UPDATE forms."ProcessorFlow"
SET rules = '{"all":[]}', "updatedAt" = now()
WHERE id = 'lets-talk-sales-email' AND "formKey" = 'lets_talk';

UPDATE forms."ProcessorFlow"
SET enabled = true, "updatedAt" = now()
WHERE id = 'lets-talk-classify' AND "formKey" = 'lets_talk' AND action = 'ai-classify'
RETURNING id, enabled;

COMMIT;

-- Watch the labels and failures (no answers selected):
-- SELECT label, status, count(*) FROM forms."SubmissionClassification" GROUP BY 1, 2 ORDER BY 1, 2;
-- SELECT "submissionId", status, "lastError", attempts FROM forms."SubmissionClassification"
--   WHERE status <> 'CLASSIFIED' ORDER BY "updatedAt" DESC LIMIT 20;
