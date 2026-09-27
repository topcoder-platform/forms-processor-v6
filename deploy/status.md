# Verified deployment — 2026-09-28 (Australia/Hobart)

Dev is deployed and healthy in account `811668436784`, region `us-east-1`:

- CloudFormation stack: `forms-processor-v6-dev`, `UPDATE_COMPLETE`.
- ECS cluster/service: `topcoder-infrastructure` / `forms-processor-v6`.
- Task definition: `forms-processor-v6:3`, one running HEALTHY task.
- Image: `forms-processor-v6:dev-initial-20260928-1`.
- Digest: `sha256:374788f17caac29a7d3feb9001c68d1595bad5c1ef5aa0a068222d9e164d714b`.
- Kafka topic `form.submitted` exists with two partitions and replication factor two.
- The forms API migration `20260928020000_processor_flows` was applied successfully
  through a one-off ECS migration task, using the API's migration history.
- `lets-talk-sales-email` is disabled. Recipients are empty, template/sender are null
  (TBD). It will queue matching events until configured and enabled.

`verification-dev.json` records AWS handles, image digest, and live checks. Two
copies of a synthetic Kafka event produced one matching disabled-flow delivery,
with zero email attempts. Temporary test flows/deliveries were removed; synthetic
inbox receipts remain for replay deduplication and contain no personal data.
No real emails were sent. The first deployment failed because the new topic did
not yet exist; it was rolled back to zero tasks, the topic was provisioned, and
the same tested image was redeployed successfully through CloudFormation.

Validation passed:

- Processor lint, type-check, build, 25 unit tests, and six PostgreSQL integration tests.
- Forms API lint, build, and all 36 unit tests.
- Docker runtime build, official CircleCI config validation, AWS template validation.
- Actual MSK ingestion, duplicate handling, content routing, disabled queue, ECS health.

CircleCI configuration maps develop to dev and master to production using the
`org-global` context. Pipeline execution and project activation were **not** verified:
this session has no CircleCI API token. Production was not provisioned or deployed;
follow `deploy/README.md` with its own account/network parameters, migrations,
topic, SSM settings, and `PRODUCTION_AWS_ACCOUNT_ID`.

Source changes remain local and uncommitted in forms-processor-v6 and forms-api-v6.
Retain the applied API migration unchanged when committing/releasing these changes.
The API runtime was not redeployed as part of this work.
