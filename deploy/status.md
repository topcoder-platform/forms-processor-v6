# Verified Bus API deployment — 2026-09-28 (Australia/Hobart)

Dev is deployed and healthy in account `811668436784`, region `us-east-1`:

- CloudFormation stack: `forms-processor-v6-dev`, `UPDATE_COMPLETE`.
- ECS cluster/service: `topcoder-infrastructure` / `forms-processor-v6`.
- Task definition: `forms-processor-v6:4`, one running HEALTHY task.
- Image: `forms-processor-v6:dev-bus-email-20260928-1`.
- Digest: `sha256:5bccf5bc1bce44c2f1ecf392b3c9dcf1f7888451726b70d809979cbd28ca43bf`.
- Kafka topic `form.submitted` exists with two partitions and replication factor two.
- The forms API migration `20260928020000_processor_flows` was applied successfully
  through a one-off ECS migration task, using the API's migration history.
- `lets-talk-sales-email` is disabled. Recipients are empty, template/sender are null
  (TBD). It will queue matching events until configured and enabled.

`verification-bus-dev.json` records the current AWS handles, digest, and live checks.
The new client authenticated through the shared M2M proxy and published two copies
of a synthetic form event via Bus API. They produced one matching disabled-flow delivery,
with zero email attempts. Temporary test flows/deliveries were removed; synthetic
inbox receipts remain for replay deduplication and contain no personal data.
No real emails were sent. The first deployment failed because the new topic did
not yet exist; it was rolled back to zero tasks, the topic was provisioned, and
the same tested image was redeployed successfully through CloudFormation.

Validation passed:

- Processor lint, type-check, build, 29 unit tests, and six PostgreSQL integration tests.
- Email envelope matches email-service-v6: recipients, data, sendgrid_template_id, version v3.
- Live M2M token includes write:bus_api; the ECS task no longer receives a SendGrid key.
- Forms API lint/build after documentation updates (36 unit tests passed in the initial implementation).
- Docker runtime build, official CircleCI config validation, AWS template validation.
- Actual MSK ingestion, duplicate handling, content routing, disabled queue, ECS health.

CircleCI configuration maps develop to dev and master to production using the
`org-global` context. Pipeline execution and project activation were **not** verified:
this session has no CircleCI API token. Production was not provisioned or deployed;
follow `deploy/README.md` with its own account/network parameters, migrations,
topic, SSM settings, and `PRODUCTION_AWS_ACCOUNT_ID`.

The Bus API transport changes remain local and uncommitted in forms-processor-v6;
related model/documentation edits remain in forms-api-v6.
Retain the applied API migration unchanged when committing/releasing these changes.
The API runtime was not redeployed as part of this work.

Email requests now publish through Bus API to `external.action.email`; email-service-v6
owns provider delivery/retries. Recipients/template remain database-configured.
The stored `sendgrid-email` action identifier is preserved for existing flow records,
so this transport change requires no schema migration or queued-record rewrite.
`deliveredAt` now records Bus API acceptance. Sender override is optional; null uses
the email service default. No real email event was published during verification;
the v3 email envelope was tested with a mock publisher, and live transport was
verified safely on `form.submitted` with a synthetic disabled flow.
