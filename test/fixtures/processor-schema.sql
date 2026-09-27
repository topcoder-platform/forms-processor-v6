-- Workflow definitions and durable processing state belong to the forms API migration history.
CREATE TABLE forms."ProcessorFlow" (
  id VARCHAR(100) PRIMARY KEY,
  "formKey" VARCHAR(40) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  action VARCHAR(100) NOT NULL,
  rules JSONB NOT NULL DEFAULT '{"all":[]}',
  settings JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessorFlow_rules_object" CHECK (jsonb_typeof(rules) = 'object'),
  CONSTRAINT "ProcessorFlow_settings_object" CHECK (jsonb_typeof(settings) = 'object')
);
CREATE INDEX "ProcessorFlow_formKey_idx" ON forms."ProcessorFlow" ("formKey");

CREATE TABLE forms."ProcessorEvent" (
  "submissionId" UUID PRIMARY KEY,
  "formKey" VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "routedAt" TIMESTAMPTZ(3),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" VARCHAR(100),
  CONSTRAINT "ProcessorEvent_payload_object" CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX "ProcessorEvent_routedAt_nextAttemptAt_idx" ON forms."ProcessorEvent" ("routedAt", "nextAttemptAt");

CREATE TABLE forms."ProcessorDelivery" (
  "submissionId" UUID NOT NULL REFERENCES forms."ProcessorEvent"("submissionId") ON DELETE CASCADE,
  "flowId" VARCHAR(100) NOT NULL REFERENCES forms."ProcessorFlow"(id) ON DELETE RESTRICT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" VARCHAR(100),
  "deliveredAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("submissionId", "flowId")
);
CREATE INDEX "ProcessorDelivery_deliveredAt_nextAttemptAt_idx" ON forms."ProcessorDelivery" ("deliveredAt", "nextAttemptAt");
CREATE INDEX "ProcessorDelivery_flowId_idx" ON forms."ProcessorDelivery" ("flowId");

-- TBD values remain null/empty and the flow disabled until configured externally.
INSERT INTO forms."ProcessorFlow" (id, "formKey", action, settings)
VALUES ('lets-talk-sales-email', 'lets-talk', 'sendgrid-email',
        '{"recipients":[],"templateId":null,"fromEmail":null,"fromName":"Topcoder"}');
