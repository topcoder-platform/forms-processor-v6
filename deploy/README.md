# Deployment to existing ECS services

CircleCI checks all branches. After quality, deployment tests and image builds pass,
`develop` releases to dev and `master` releases to production (after manual approval).
Both use repository-bound OIDC and the pinned shared deployment suite.

Every release scans the processor image and a separate Forms API migration image,
runs `prisma migrate deploy` in the existing ECS service network, then promotes the
processor only after the migration task exits successfully with the expected digest.
The migration source is pinned in `forms-api-revision`; it includes
`20261104010000_processor_delivery_sendgrid_message`.
See [migration execution and infrastructure prerequisites](MIGRATIONS.md).

The existing service and ECR repository must already exist. Runtime task roles,
resources, health checks, networking and secret references are preserved by the
shared deployer. The service must have positive capacity and a stable deployment.
Circuit-breaker rollback and healthy tasks of the requested revision are required.
Successful release artifacts record runtime/migration digests, task ARNs and the
Forms API source commit. Rollbacks retain applied additive database migrations.

## Runtime parameter sources

ECS resolves the task's existing SSM references at startup. CI never fetches secret
values or discovers optional parameters. Add or remove references through the
infrastructure that owns the task definition, then redeploy. The migration task
receives only `DATABASE_URL` from `/config/forms-api-v6/appvar/MIGRATION_DATABASE_URL`;
the processor runtime retains its existing references.

| Settings | SSM source |
| --- | --- |
| `BUSAPI_URL` | `/config/forms-processor-v6/appvar/BUSAPI_URL` (required SecureString; prod `https://api.topcoder.com/v6`, dev `https://api.topcoder-dev.com/v6`) |
| `LETS_TALK_RECIPIENTS` | `/config/forms-processor-v6/appvar/LETS_TALK_RECIPIENTS` (SecureString; comma-separated addresses) |
| `LETS_TALK_SENDGRID_TEMPLATE_ID` | `/config/forms-processor-v6/appvar/LETS_TALK_SENDGRID_TEMPLATE_ID` (SecureString; active `d-` dynamic-template ID) |
| `AI_API_URL`, `AI_AUTH0_AUDIENCE` | `/config/forms-processor-v6/appvar/` (optional SecureStrings; tc-ai-api base ending in `/v6/ai`, e.g. `https://api.topcoder.com/v6/ai`; the audience defaults to `AUTH0_AUDIENCE`) |
| `LETS_TALK_OPPORTUNITY_TEMPLATE_ID`, `LETS_TALK_SKILLS_TEMPLATE_ID`, `LETS_TALK_GENERAL_TEMPLATE_ID`, `LETS_TALK_WIPRO_TEMPLATE_ID`, `LETS_TALK_SALES_REPLY_TEMPLATE_ID`, `LETS_TALK_SUPPORT_TEMPLATE_ID` | `/config/forms-processor-v6/appvar/` (optional SecureStrings; one SendGrid template per label flow, see `docs/emails/README.md`) |
| `LETS_TALK_SUPPORT_RECIPIENTS`, `LETS_TALK_SALES_REPLY_TO`, `LETS_TALK_REPLY_CAP_PER_DAY`, `LETS_TALK_CLASSIFY_MAX_ATTEMPTS`, `LETS_TALK_CLASSIFY_MAX_AGE_MINUTES` | `/config/forms-processor-v6/appvar/` (optional SecureStrings; defaults `support@topcoder.com`, `support@topcoder.com,test1@topcoder.com`, `1`, `5`, `30`) |
| `SPACE_TECH_CHALLENGE_RECIPIENTS`, `SPACE_TECH_CHALLENGE_TEMPLATE_ID` | `/config/forms-processor-v6/appvar/` (optional SecureStrings; comma-separated addresses and the active `d-` template ID for the SpaceTech challenge notification; unset defers it) |
| `DATABASE_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | `/config/forms-api-v6/appvar/` |
| `AUTH0_URL`, `AUTH0_AUDIENCE`, optional `AUTH0_PROXY_SERVER_URL` | Forms API appvars when present, otherwise `/config/common/global-appvar/` |
| `KAFKA_URL`, optional `KAFKA_SSL_ENABLED` | `/config/common/global-appvar/` |

Processor-owned settings are SecureStrings. Runtime email settings may be absent
while their flows are disabled. Malformed configured values can fail startup;
redeploy after changing parameters so the new task reads the updated values.

## CircleCI alignment

Builds run without deployment credentials and produce two prebuilt images. The
migration image uses the canonical Forms API Dockerfile's `migrate` target at an
immutable source commit. Both images pass the same ECR digest and scan checks.
Deployment runs no package installation and cannot read SSM/Secrets Manager values.
ECS injects the migration database URL using the task execution role.

Dev and production use the same `deploy/release.py deploy/<environment>.json` adapter,
with branch-filtered, serialized deployments and explicit production approval.
Required deployment IAM and execution-role grants live in `v6-services-iac` and must
be applied before enabling this migration gate in each environment.

## Release and enable Let's Talk

1. Ensure the pinned Forms API revision includes migrations `20260928020000_processor_flows` and
   `20261013010000_lets_talk_processor_key`. The second fixes the seed's `lets-talk`
   mismatch to the website's `lets_talk` key and reroutes retained unmatched events,
   preserving existing delivery receipts and configuration.
2. Verify the global brokers are reachable from the existing processor security group,
   the forms database permits the service, and `form.submitted` exists. The worker
   disables Kafka topic auto-creation. Its group defaults to `forms-processor-v6`.
3. Set the processor SecureStrings above. The reused API M2M identity needs
   `write:bus_api`. Configure an active SendGrid template using
   [lets-talk-email.json](../examples/lets-talk-email.json) and the README variables.
4. Merge reviewed changes to develop, then master. The repository must be connected
   to CircleCI with the environment-specific deployment context. CircleCI builds
   both tested images, applies pending migrations, then promotes the processor.
5. Once healthy, inspect the pending-delivery query in the README. Enabling releases
   matching queued submissions as well as future ones. Run the reviewed update in
   [configure-lets-talk.sql](../examples/configure-lets-talk.sql) to enable the flow.
6. Publish the production form using the API's `scripts/publish-lets-talk.ts`, with
   `FORMS_API_BASE_URL=https://api.topcoder.com/v6` and a production admin token. Release
   the website migration only after the public schema and website CORS origin pass.
7. Submit one clearly identified test through `/lets-talk`. Follow its `submissionId`
   from the API receipt into `form.submitted`, `ProcessorEvent`, `ProcessorDelivery`,
   and the `external.action.email` envelope. Verify email-service-v6 accepts the
   SendGrid request and the designated recipients receive correctly filled emails.
   `deliveredAt` alone proves only Bus API acceptance, not inbox delivery.

Run releases through CircleCI so the repository/branch-bound OIDC checks and the
production approval gate apply. Local ambient AWS credentials are not a deployment
fallback.

Rollback by updating the existing service to the prior task ARN recorded in the
release artifact. Keep additive API migrations. Disable the flow first if recipient
or template settings need correction; a send already in progress may finish.

## Release Let's talk AI classification (docs/adr/0001)

1. Deploy tc-ai-api with the raised Let's talk input limits, and confirm the
   processor's M2M client (the forms-api identity) has the scope `ai:letstalk:classify`.
2. The pinned migration image applies `20261022010000_lets_talk_classification`. It adds
   `forms."SubmissionClassification"` and seven **disabled** flows, and leaves
   `lets-talk-sales-email` unchanged.
3. Set `AI_API_URL` (and `AI_AUTH0_AUDIENCE` if needed) in SSM and release this
   service. The task fails startup if the new table is missing.
4. Shadow mode: run `examples/lets-talk-shadow-mode.sql`. Check labels in the reports UI
   and the `SubmissionClassification` queries in that file for 1–2 weeks.
5. Create the SendGrid templates (`docs/emails/README.md`), set their ids and the
   recipient settings above, and release again so the task reads them.
6. Cut over with `examples/lets-talk-cutover.sql`, then send one test submission per
   label in dev before production.

## Historical CloudFormation bootstrap

`service.yaml` and `parameters-dev.json` describe the original dev bootstrap, retained
for reference. They are no longer applied by CI/CD. Subsequent infrastructure changes
must preserve the live task reference and desired count: applying an old stack image
or the old `release.py` procedure can revert a newer ECS release. The dev execution
role from that bootstrap needs access to the new processor SSM paths before its first
new release. Provision infrastructure separately if the production service is missing.
