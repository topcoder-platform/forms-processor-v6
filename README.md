# forms-processor-v6

A small TypeScript Kafka worker for the HubSpot forms replacement. Consumes the
`forms-api-v6` Bus API envelope on `form.submitted`, saves a durable inbox record,
then routes each submission to independently retried actions. The first action
publishes `lets-talk` email requests through Bus API to `external.action.email`;
`email-service-v6` delivers them using the configured SendGrid dynamic template.

The initial `lets-talk-sales-email` flow is **disabled**. Recipients and template ID
are TBD (empty/null in the seed). The optional sender is also unset; email-service-v6
uses its configured default when no sender override is supplied. Matching submissions queue
until you configure and enable the flow. No email is sent by a disabled flow.

The form integration must include `"kafka": true` in the forms API submission
**body**, alongside `version` and `answers`. It is not an answer or query parameter.
Submissions that do not opt in stay in the API and do not reach this processor.

## Local development

```sh
nvm use
npm ci
cp .env.example .env
# Apply forms-api-v6 migrations to your local forms database first.
npm run dev
```

`DATABASE_URL` uses the existing forms API PostgreSQL database/schema.
`KAFKA_URL` is a comma-separated broker list. The consumer group defaults to
`forms-processor-v6`; the topic is the API's fixed `form.submitted` contract.
`KAFKA_FROM_BEGINNING=true` reads retained events when the group has no valid
committed offset. `KAFKA_SSL_ENABLED` enables broker TLS. The dev MSK cluster uses
9092; TLS deployments use 9094. SASL/IAM Kafka authentication is not implemented.
Production database connections should verify TLS; the image includes the RDS CA.
Email publishing requires `BUSAPI_URL` (the API base ending in `/v6`), `AUTH0_URL`,
`AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`, and `AUTH0_CLIENT_SECRET`. Optionally set
`AUTH0_PROXY_SERVER_URL` for the shared token proxy. These settings are all-or-none;
a disabled flow can run without any of them. The M2M identity needs `write:bus_api`.
The client uses the same client-credentials and `auth0_url` proxy contract as
`tc-core-library-js`, caches tokens until 60 seconds before `expires_in`, and shares
an abortable 15-second deadline across authentication and Bus API publication.
Native fetch keeps this worker's database lock bounded; the shared Bus API wrapper
currently does not provide a request deadline. PORT defaults to 3000 (private health).
There are no direct SendGrid credentials or sandbox settings in this processor.

Quality checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
For actual SQL/locking/retry tests, create a **disposable** PostgreSQL database named
`forms_processor_test`, then run:

```sh
TEST_DATABASE_URL=postgresql://postgres:forms_local@localhost:5547/forms_processor_test npm run test:integration
```

The integration suite replaces its `forms` schema. It never uses DATABASE_URL.
`test/fixtures/processor-schema.sql` is a test-only copy of the API migration
`20260928020000_processor_flows`; keep them identical when changing the schema.

## Configure the first flow

The canonical Prisma models/migration live in **forms-api-v6**. Deploy migration
`20260928020000_processor_flows` before deploying the worker; the worker fails
startup if tables are missing. It does not run migrations or modify form schemas.

Run a parameterized update using your database administration tooling:

```sql
UPDATE forms."ProcessorFlow"
SET settings = jsonb_build_object(
      'recipients', jsonb_build_array('sales@example.com', 'associate@example.com'),
      'templateId', 'd-00000000000000000000000000000000',
      'fromEmail', 'verified-sender@example.com',
      'fromName', 'Topcoder'
    ), "updatedAt" = now()
WHERE id = 'lets-talk-sales-email';
-- Replace all sample values before enabling:
UPDATE forms."ProcessorFlow" SET enabled = true, "updatedAt" = now()
WHERE id = 'lets-talk-sales-email';
```

Use an active SendGrid dynamic template. A sender override must be verified; omit
`fromEmail` or set it to null to use email-service-v6's configured sender. Changes are read
for each delivery attempt; no restart is needed for recipients/template/sender.
The full recipient list is visible in the email's To field. Recipients always
come from trusted flow settings, never the submission. The template defines the
subject and content; use escaped Handlebars expressions for submitted answers.
The published payload is `{ recipients, sendgrid_template_id, version: "v3", data,
from? }` inside the standard Bus API envelope. `data` holds the template variables;
`from` is emitted only when a sender override is configured. The existing stored
action name `sendgrid-email` is retained for compatibility, but always uses Bus API.
No migration or settings rewrite is needed for existing flows or pending receipts.

Template data includes `submissionId`, `formKey`, `version`, `submittedAt`,
`memberId`, `sourcePage`, `answers`, and `fields` (array of `{key,value}` strings).
For lets-talk, use `{{answers.firstname}}`, `{{answers.lastname}}`,
`{{answers.email}}`, `{{answers.company}}`, `{{answers.interested_in}}`, and
`{{answers.briefly_describe_your_inquiry}}`. `{{#each fields}}` can render arbitrary
forms. Submitted data is nested and cannot overwrite event metadata.

## More forms and content-based flows

`forms."ProcessorFlow"` stores a stable ID, form key, enabled flag, action name,
rules, and action settings. Add rows to reuse the email action for other forms.
All matching flows execute, so give each intended action a separate stable ID.
Rules are AND predicates on stable answer keys, with strict typed comparisons:

```json
{"all":[{"field":"interested_in","operator":"in","values":["crowdsourcing","app_design_development","freelancers"]}]}
```

Supported operators: `equals` (string/number/boolean), `in` (one of scalar values),
`contains` (multi-select array includes a string), and `exists` (including false/0).
`{"all":[]}` matches all answers. The seeded flow matches every lets-talk
submission, as requested for the first implementation. Changing the rules can
restrict it to sales interests when additional member options exist.

Implement `Action.execute(event, settings)` in `src/actions.ts` or another module
and register it in `src/main.ts` for a new action type. Rule validation lives in
`src/contracts.ts`; database queue/receipts live in `src/store.ts`. The Kafka layer
only validates and persists events. No browser redirects occur in this async worker;
a future member signup redirect belongs in the website's form response flow.

## Reliability and operations

* Kafka commits only after PostgreSQL persists the event. Duplicate submission IDs
  do not create another inbox record. Invalid envelopes are discarded with a log
  of topic/partition/offset, without logging personal data. There is no raw-message DLQ.
* Routing creates a unique delivery per submission/flow, including disabled flows.
  Unmatched events are retained with no delivery. Rules are evaluated once at routing;
  configuration edits do not retroactively change existing routing decisions.
* Workers use `FOR UPDATE SKIP LOCKED` to allow multiple ECS tasks safely. Each
  delivery holds its row lock through the bounded 15-second authentication/Bus API request.
* Failed actions retry indefinitely, starting at 5 seconds and capped at one hour.
  This includes missing settings, unknown actions, 4xx, rate limits, and timeouts.
  Fix configuration or disable the flow; other deliveries continue. Monitor
  `lastError`, attempts, oldest pending records, and CloudWatch deferred/fatal logs.
* Bus API acceptance and PostgreSQL commit cannot be atomic. A crash or ambiguous
  timeout after acceptance can send a duplicate. This is **at-least-once**, not
  exactly-once email delivery. `deliveredAt` means Bus API acceptance, not SendGrid
  or inbox delivery. After acceptance, email-service-v6 owns delivery and provider
  retries. A Kafka key is a correlation/partitioning key, not a deduplication guarantee.
* Disabling a flow pauses pending work; an already-running send may finish.
  Settings/rule changes must set `updatedAt` explicitly. No management HTTP API is added.

```sql
-- Inspect queued or failed deliveries (does not select answers).
SELECT d."submissionId", d."flowId", f.enabled, d.attempts,
       d."nextAttemptAt", d."lastError"
FROM forms."ProcessorDelivery" d JOIN forms."ProcessorFlow" f ON f.id = d."flowId"
WHERE d."deliveredAt" IS NULL ORDER BY d."createdAt";

-- Retry a flow immediately after correcting its settings.
UPDATE forms."ProcessorDelivery" SET "nextAttemptAt" = now()
WHERE "flowId" = 'lets-talk-sales-email' AND "deliveredAt" IS NULL;

-- Explicitly reroute a selected event after adding/changing rules.
-- Existing successful delivery receipts remain intact.
UPDATE forms."ProcessorEvent" SET "routedAt" = NULL, "nextAttemptAt" = now()
WHERE "submissionId" = '00000000-0000-0000-0000-000000000000';
```

The inbox duplicates personal data from the API event. Include it in retention
and erasure procedures. Deleting an inbox row cascades its receipts and removes
deduplication protection; retain records through your Kafka retention/replay window.
There is no automatic deletion policy. The service needs only SELECT on flows,
SELECT/INSERT/UPDATE on inbox/deliveries; the initial deployment reuses the existing
forms API database login, so a dedicated restricted login is an optional later step.

## Deployment

See [deploy/README.md](deploy/README.md). CircleCI checks every branch and deploys
`develop` → dev, `master` → production using `org-global` credentials and the same
pinned Topcoder AWS credential helper as forms-api-v6. Each environment needs its
one-time CloudFormation bootstrap and API migration before its first deployment.
