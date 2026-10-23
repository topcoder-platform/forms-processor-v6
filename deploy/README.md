> Keycloak migration branch only: do not run release.py or deploy this template before rollout approval. Releases reference each provider's settings that exist (Keycloak, Auth0 or both); `/config/common/global-appvar/USE_KEYCLOAK` selects which one the worker uses. Existing verification/status JSON files describe historical Auth0 deployments. No service is deployed by these source changes.

# Deployment to existing ECS services

CircleCI checks all branches. After quality and deployment tests pass, `develop`
releases to dev and `master` releases to production using `org-global` and the pinned
Topcoder AWS credential helper. The deployment registers a new task revision and
updates **forms-processor-v6** on **topcoder-infrastructure**. It does not create or
update CloudFormation stacks, services, networking, IAM roles, topics or databases.

The existing service and ECR repository must already exist. `release.py` clones
registerable fields from the service's current task, preserving its roles, resource
limits, sidecars and other runtime configuration. It replaces the processor image,
managed SSM references and health check. Existing nonzero replica counts are kept;
a service at zero is started at one. A service with an in-progress rollout is rejected.
The script waits for healthy tasks of the requested revision and fails on rollback,
failed rollout or timeout. It records current/previous task ARNs in a release artifact.

## Runtime parameter sources

Values are injected by ECS at task startup. The release script resolves the 21
allowlisted candidate names using three `GetParameters` requests (at most ten names
per request), with `WithDecryption=false`. It uses only names and types, discarding
returned values, and never scans parameter prefixes with `DescribeParameters`.
The SSM client uses standard exponential-backoff retries, capped at ten total
attempts per request, including for manual releases. No account-wide throughput
setting change is required. The task execution role must have `ssm:GetParameters` access to the selected
parameters and `kms:Decrypt` when a customer-managed key is used.

| Settings | SSM source |
| --- | --- |
| `BUSAPI_URL` | `/config/forms-processor-v6/appvar/BUSAPI_URL` (required SecureString; prod `https://api.topcoder.com/v6`, dev `https://api.topcoder-dev.com/v6`) |
| `LETS_TALK_RECIPIENTS` | `/config/forms-processor-v6/appvar/LETS_TALK_RECIPIENTS` (SecureString; comma-separated addresses) |
| `LETS_TALK_SENDGRID_TEMPLATE_ID` | `/config/forms-processor-v6/appvar/LETS_TALK_SENDGRID_TEMPLATE_ID` (SecureString; active `d-` dynamic-template ID) |
| `DATABASE_URL` | `/config/forms-api-v6/appvar/` |
| `USE_KEYCLOAK` | `/config/common/global-appvar/USE_KEYCLOAK` (optional; `true` = Keycloak, `false` or absent = Auth0) |
| `KEYCLOAK_ISSUER`, `KEYCLOAK_TOKEN_URL`, `KEYCLOAK_AUDIENCE`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, optional `KEYCLOAK_SCOPE` | `/config/forms-processor-v6/keycloak-m2m/`; no fallback to Forms API or Auth0 credentials |
| `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | `/config/forms-api-v6/appvar/` (as before the Keycloak migration) |
| `AUTH0_URL`, `AUTH0_AUDIENCE`, optional `AUTH0_PROXY_SERVER_URL` | Forms API appvars when present, otherwise `/config/common/global-appvar/` |
| `KAFKA_URL`, optional `KAFKA_SSL_ENABLED` | `/config/common/global-appvar/` |

Only these named references are imported. The processor does not receive the API's
migration URL or unrelated shared secrets. If global Kafka TLS is absent, the current
task setting is preserved (runtime default false); ensure it matches the global broker
listeners. There are no processor SendGrid credentials: email-service-v6 owns delivery.

The two email parameters may be absent during initial deployment. Their absence
produces empty runtime email settings; enabling the flow then defers email delivery
with `invalid_email_settings`. It never falls back to stale database recipients.
Malformed nonempty values fail startup without exposing values. Create both parameters
before the email release. **Redeploy after every parameter change** so new tasks read
new values and newly created parameters are included in the task definition.

The CI role needs ECR push/read, ECS describe/list/register/update, `ssm:GetParameters`
on the candidate names above (including API/shared fallback names), and permission
to pass the existing task roles. It does not need `ssm:DescribeParameters` or KMS
decryption for this lookup. No CloudFormation permissions are
needed. Accounts are guarded explicitly: dev `811668436784`, production `409275337247`.

## CircleCI alignment

Like forms-api-v6, email-service-v6 and bus-api-v6, the worker uses the Python
deployment executor, remote Docker with `buildx --load`, the pinned Topcoder
credential helper, `org-global`, and branch-filtered, serialized dev/prod releases.
Credentials are obtained immediately before deployment and the temporary helper
and credentials file are removed on success or failure. AWS CLI/SDK calls use
standard retry mode with ten total attempts.

The worker retains `release.py` for task registration instead of the shared
`master_deploy.sh` template generator: it preserves the live task's execution role,
resources and sidecars, and imports only the named API/shared parameters above.
It still follows the same ECR push, new task-definition revision, existing-service
update and health-verification sequence. It neither loads whole API/global appvar
paths nor requires a new `/deployvar` configuration for the fixed service target.

## Release and enable Let's Talk

1. Deploy forms-api-v6 migrations, including `20260928020000_processor_flows` and
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
   to CircleCI with access to `org-global`. CircleCI builds the tested runtime image
   and invokes `deploy/release.py production production-COMMIT-BUILD`.
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

For a manual release of a reviewed image with temporary credentials:

```sh
docker build -t forms-processor-v6:candidate .
python3 deploy/release.py production production-UNIQUE-RELEASE-ID
```

Rollback by updating the existing service to the prior task ARN recorded in the
release artifact. Keep additive API migrations. Disable the flow first if recipient
or template settings need correction; a send already in progress may finish.

## Historical CloudFormation bootstrap

`service.yaml` and `parameters-dev.json` describe the original dev bootstrap, retained
for reference. They are no longer applied by CI/CD. Subsequent infrastructure changes
must preserve the live task reference and desired count: applying an old stack image
or the old `release.py` procedure can revert a newer ECS release. The dev execution
role from that bootstrap needs access to the new processor SSM paths before its first
new release. Provision infrastructure separately if the production service is missing.

The release builder references each provider's settings as a complete set: a set that is entirely absent is skipped (for example production before Keycloak is provisioned), a partial set or no complete set stops the release, and `USE_KEYCLOAK` is referenced when it exists. It removes stale literal copies of these names from the task environment and requires a SecureString Keycloak client secret. Provision the dedicated workload parameters and `write:bus_api` grant before rollout. No shared Auth0 parameter is modified.

**Switching providers:** set `/config/common/global-appvar/USE_KEYCLOAK` to `true` (Keycloak) or `false` (Auth0, the rollback) and force a new deployment of the service so tasks re-read SSM; no release or code change is needed as long as both providers' settings existed at the last release. If one set was skipped, run a release after creating it. The CloudFormation template (used only to create the stack) references both sets, so both must exist when it is applied.

An existing ECS execution role must be allowed to read the dedicated Keycloak SSM prefix, `/config/common/global-appvar/USE_KEYCLOAK` and the Auth0 parameters above (and decrypt their KMS key). `release.py` preserves role assignments; the branch template (`BusCredentialsPrefix` for Keycloak, `Auth0CredentialsPrefix` for Auth0) includes the required parameter paths. Prepare those permissions before releasing the branch.
