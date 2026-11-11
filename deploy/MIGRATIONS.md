# Migrations before processor rollout

Both `develop` (dev) and `master` (production, after approval) use this order:

1. In the credential-free build job, build the processor at the CircleCI commit and
   the Forms API `migrate` image at the commit in `forms-api-revision`.
2. Upload both images to the environment's existing `forms-processor-v6` ECR
   repository. Verify image source labels, registry digests and scan results.
3. Register a `forms-processor-v6-migrate` task using the existing processor's
   execution/task roles and resources, without a health check or port mappings.
   Run it on Fargate in the processor service's existing private network.
4. Run `node node_modules/prisma/build/index.js migrate deploy`, receiving only
   `DATABASE_URL` from `/config/forms-api-v6/appvar/MIGRATION_DATABASE_URL`.
5. Wait up to 15 minutes for exit code zero and the exact migration image digest.
   Only then use the shared deployer to update and verify the processor runtime.

The deploy principal never reads database credentials. ECS uses the execution role
for secret injection. The runtime task's secret references are unchanged. No SQL is
copied into this repository: Prisma uses the canonical Forms API schema, migration
files and `forms._prisma_migrations` history. Already applied migrations are skipped;
Prisma's advisory lock protects against concurrent migration runners, including a
Forms API release. A lock timeout fails this release and requires a later retry.

## Source pin and future schema changes

The initial pin is Forms API commit
`b1bbc5b7e0653d290982dc24a24c5121e94fc2ea`, which contains
`20261104010000_processor_delivery_sendgrid_message` and its preceding migrations.
Update `forms-api-revision` in the same processor PR that requires newer schema.
Review all pending migrations in that Forms API commit for compatibility with both
running applications. Dev and production build the same pinned source; neither
fetches a moving branch or the latest deployed API image.

Migration image tags start with the Forms API commit (matching the shared publisher's
source-label check), followed by the processor commit, CircleCI build number and
`-migrate`. Runtime tags retain the processor commit and build number.

## Infrastructure prerequisite in each environment

Apply the companion changes in the private
[v6-services-iac service directory](https://github.com/topcoder-platform/v6-services-iac/tree/main/services/forms-processor-v6)
before merging/enabling the application change for that environment:

- Grant the processor deployment role **and its permissions boundary** registration
  and tag operations on `forms-processor-v6-migrate:*`, plus `ecs:RunTask` on only
  that family in `topcoder-infrastructure`. Runtime `UpdateService` remains restricted
  to `forms-processor-v6:*`. No additional roles may be passed.
- Grant the existing processor **execution role** `ssm:GetParameters` on the exact
  Forms API `MIGRATION_DATABASE_URL` parameter. The deployment role retains explicit
  denies on SSM, Secrets Manager, KMS decryption and role chaining.
- If this parameter uses a customer-managed KMS key, supply `MigrationKmsKeyArn`
  when updating the IAM stack and ensure its key policy permits the execution role.
  The additional decrypt grant is restricted to SSM and this parameter's encryption
  context. Leave the parameter empty for the AWS-managed SSM key.
- Ensure the migration parameter points at the existing Forms database with a login
  that can apply its migrations. Existing processor network access must reach it.

Application CI does not install IAM, create a database, or change networking.

## Failure and recovery

A failed scan, task launch, migration, digest check or concurrent service change
prevents runtime promotion. The migration task ARN is printed immediately; inspect
its stream under the processor's existing CloudWatch log group for Prisma errors.
After a timeout, inspect the task before retrying: it may still be running. A failed
Prisma migration requires operator investigation; the pipeline does not reset the
database, resolve migration history, or automatically retry schema changes.

A runtime rollback does not undo applied migrations. Successful releases save
`deploy/release-dev.json` or `deploy/release-prod.json` as CircleCI artifacts, including
the runtime/migration digests, migration task ARN and migration source commit.

## Verification

With the pinned deployment suite checked out at `/tmp/tc-deploy-scripts`:

```sh
python3 -m unittest discover -s /tmp/tc-deploy-scripts/tests -q
python3 -m unittest discover -s deploy/tests -v
```

For a different local suite path, set `TEST_DEPLOY_SUITE`. Tests use fake AWS responses
and exercise successful dev/prod ordering plus scan, launch, exit-code, digest,
registration, timeout and concurrent-deployment failures without touching AWS.
