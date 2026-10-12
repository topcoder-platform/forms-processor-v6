-- The published form key is lets_talk; preserve the flow's settings and enabled state.
UPDATE forms."ProcessorFlow"
SET "formKey" = 'lets_talk', "updatedAt" = CURRENT_TIMESTAMP
WHERE id = 'lets-talk-sales-email' AND "formKey" = 'lets-talk';

-- Retry routing retained submissions that previously missed this flow. Existing
-- delivery receipts stay intact, so already accepted emails are not replayed.
UPDATE forms."ProcessorEvent" e
SET "routedAt" = NULL, "nextAttemptAt" = CURRENT_TIMESTAMP
WHERE e."formKey" = 'lets_talk'
  AND EXISTS (SELECT 1 FROM forms."ProcessorFlow" f
              WHERE f.id = 'lets-talk-sales-email' AND f."formKey" = 'lets_talk')
  AND NOT EXISTS (SELECT 1 FROM forms."ProcessorDelivery" d
                  WHERE d."submissionId" = e."submissionId"
                    AND d."flowId" = 'lets-talk-sales-email');
