-- AI classification of form submissions, written by forms-processor-v6 (its ADR 0001).
-- One row per classified submission; a submission without a row reports as UNKNOWN.
-- label is VARCHAR, not an enum: the class set is configurable in tc-ai-api.
CREATE TABLE forms."SubmissionClassification" (
  "submissionId" UUID PRIMARY KEY REFERENCES forms."Submission"(id) ON DELETE CASCADE,
  label VARCHAR(40) NOT NULL DEFAULT 'UNKNOWN',
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  confidence DECIMAL(5, 4),
  "needsReview" BOOLEAN,
  "detectedLanguage" VARCHAR(8),
  rationale VARCHAR(500),
  "workflowId" VARCHAR(100) NOT NULL,
  "workflowRunId" UUID,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "lastError" VARCHAR(100),
  "classifiedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubmissionClassification_label_format" CHECK (label ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  CONSTRAINT "SubmissionClassification_status" CHECK (status IN ('PENDING', 'CLASSIFIED', 'FAILED')),
  CONSTRAINT "SubmissionClassification_confidence_range" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- A CLASSIFIED row always carries the model's verdict.
  CONSTRAINT "SubmissionClassification_classified_complete" CHECK (
    status <> 'CLASSIFIED' OR (confidence IS NOT NULL AND "needsReview" IS NOT NULL AND "classifiedAt" IS NOT NULL)
  )
);
CREATE INDEX "SubmissionClassification_label_idx" ON forms."SubmissionClassification" (label);

-- Let's talk flows, all disabled. Recipients, templates and the AI endpoint come
-- from processor SSM settings, so settings stay empty here. Flows with a
-- "classification" rule are routed only after the submission is classified.
-- lets-talk-sales-email is intentionally unchanged: it keeps emailing every
-- submission until the reviewed cut-over (processor examples/lets-talk-cutover.sql).
INSERT INTO forms."ProcessorFlow" (id, "formKey", action, rules) VALUES
  ('lets-talk-classify', 'lets_talk', 'ai-classify', '{"all":[]}'),
  ('lets-talk-community-opportunity-reply', 'lets_talk', 'sendgrid-email', '{"all":[],"classification":["COMMUNITY_OPPORTUNITY"]}'),
  ('lets-talk-community-skills-reply', 'lets_talk', 'sendgrid-email', '{"all":[],"classification":["COMMUNITY_SKILLS"]}'),
  ('lets-talk-community-general-reply', 'lets_talk', 'sendgrid-email', '{"all":[],"classification":["COMMUNITY_GENERAL"]}'),
  ('lets-talk-wipro-queries-reply', 'lets_talk', 'sendgrid-email', '{"all":[],"classification":["WIPRO_QUERIES"]}'),
  ('lets-talk-support-forward', 'lets_talk', 'sendgrid-email', '{"all":[],"classification":["COMMUNITY_SUPPORT"]}'),
  ('lets-talk-sales-reply', 'lets_talk', 'sendgrid-email', '{"all":[],"classification":["SALES_LEAD"]}')
ON CONFLICT (id) DO NOTHING;
