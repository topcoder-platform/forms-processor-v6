> Keycloak migration branch only. `/config/common/global-appvar/USE_KEYCLOAK` selects Keycloak (`true`) or Auth0 (`false` or absent) M2M for the worker. Existing verification/status JSON files describe historical Auth0 deployments. No service is deployed by these source changes.

# Deployment to the existing ECS service

CircleCI checks all branches. After the quality job passes, `develop` deploys to dev and
`master` to production with `org-global`, exactly like the other v6 services: the pinned
tc-deploy-scripts (v1.4.20, commit `5f3745c`) `master_deploy.sh`.

```sh
./psvar-processor.sh -t appenv -p /config/forms-processor-v6/deployvar
source deployvar_env
./master_deploy.sh -d ECS -e $DEPLOY_ENV -t latest \
  -j /config/forms-processor-v6/appvar,/config/common/global-appvar -i forms-processor-v6 -p FARGATE
```

The script pushes the image to the `forms-processor-v6` ECR repository (tagged with the
CircleCI build number), registers a new task definition and updates **forms-processor-v6**
on **topcoder-infrastructure**. It runs the task with the shared `ecsTaskExecutionRole`,
which can read the parameters below, and logs to `/aws/ecs/topcoder-infrastructure`.
It does not create or update CloudFormation stacks, networking, IAM roles, topics or
databases.

## Parameters

Every parameter directly under `/config/forms-processor-v6/appvar` and
`/config/common/global-appvar` becomes an ECS secret with the parameter's name; when both
define a name, the appvar value wins. A new parameter is picked up by the next deploy;
a changed value by the next task start (force a new deployment).

| Path | Holds |
| --- | --- |
| `/config/forms-processor-v6/deployvar` | `AWS_ECS_CLUSTER`, `AWS_ECS_SERVICE`, `AWS_ECS_TASK_FAMILY`, `AWS_ECS_CONTAINER_NAME`, `AWS_REPOSITORY`, `AWS_ECS_FARGATE_CPU`/`MEMORY` (256/512), `AWS_ECS_CONTAINER_CPU`, `AWS_ECS_CONTAINER_MEMORY_RESERVATION`, `AWS_ECS_READONLY_ROOTFILESYSTEM`, `AWS_ECS_TASK_ROLE_ARN` (role name) and `AWS_ECS_CONTAINER_HEALTH_CMD` (`/health` on `PORT`, default 3000) |
| `/config/forms-processor-v6/appvar` | `BUSAPI_URL`, `DATABASE_URL` (the Forms API database), `AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET` (the Forms API's Auth0 machine client, used when `USE_KEYCLOAK` is not true), `KEYCLOAK_CLIENT_ID`/`KEYCLOAK_CLIENT_SECRET` (`m2m-forms-processor-v6`), `KAFKA_GROUP_ID`, `KAFKA_FROM_BEGINNING`, `KAFKA_SSL_ENABLED`, `NODE_ENV`, and optional `LETS_TALK_RECIPIENTS`/`LETS_TALK_SENDGRID_TEMPLATE_ID` |
| `/config/common/global-appvar` | Shared values, including `USE_KEYCLOAK`, `KEYCLOAK_ISSUER`, `KEYCLOAK_AUDIENCE`, `KEYCLOAK_TOKEN_URL`, `AUTH0_URL`, `AUTH0_AUDIENCE`, `AUTH0_PROXY_SERVER_URL` and `KAFKA_URL` |

`DATABASE_URL` and the Auth0 client are copies of the Forms API values (the worker shares
its database and machine identity); update both services when they rotate. The two
Let's Talk parameters may be absent during initial deployment. Their absence produces
empty runtime email settings; enabling the flow then defers email delivery with
`invalid_email_settings`. Malformed nonempty values fail startup without exposing values.
There are no processor SendGrid credentials: email-service-v6 owns delivery.

**Switching providers:** set `USE_KEYCLOAK` to `true` (Keycloak) or `false` (Auth0, the
rollback) and force a new deployment so tasks re-read SSM. Both credential sets above stay
in SSM, so no code, release or parameter-wiring change is needed. Production needs the
same `deployvar` and appvar parameters (created in DEV on 23 October) before its first
release from `master`.

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
   and deploys it with `master_deploy.sh` (see above).
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

Rollback a bad image by updating the service to the previous task definition revision.
Keep additive API migrations. Disable the flow first if recipient or template settings
need correction; a send already in progress may finish.

## Historical CloudFormation bootstrap

`service.yaml` and `parameters-dev.json` describe the original dev bootstrap, retained for
reference; CI/CD does not apply them. `master_deploy.sh` owns the task definition, so
applying the old stack template would revert the service to its bootstrap image and
settings.
