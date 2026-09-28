# Deployment

`service.yaml` owns ECR, CloudWatch, execution/task roles, a private security group,
database/Kafka ingress rules, task definition, and the `forms-processor-v6` Fargate
service in `topcoder-infrastructure`. There is no ALB, API Gateway, or public ingress.
The default task is 0.25 vCPU / 512 MiB with a read-only filesystem and graceful stop.

1. Apply the forms-api-v6 `20260928020000_processor_flows` migration using that API's
   normal migration deployment. It adds three tables and a disabled lets-talk flow.
2. Ensure `form.submitted` exists on MSK before starting the service. Dev uses two
   partitions and replication factor two. The worker disables topic auto-creation.
   Provision the topic using your Kafka administration tooling inside the VPC;
   retain the broker's normal retention policy.
3. Bootstrap the CloudFormation stack in each account at DesiredCount=0, passing
   its VPC, private subnets, database SG, and MSK SG. Dev values are checked in as
   `parameters-dev.json`; supply production's own values, never reuse dev IDs.
4. Verify these existing SSM values are present: forms API DATABASE_URL, shared
   KAFKA_URL, shared AUTH0_URL/AUTH0_AUDIENCE/AUTH0_PROXY_SERVER_URL, and the
   forms API AUTH0_CLIENT_ID/AUTH0_CLIENT_SECRET. `BusCredentialsPrefix` defaults
   to `/config/forms-api-v6/appvar` to reuse its Bus-authorized M2M identity; point
   it to processor-specific credentials when provisioned. That client needs
   `write:bus_api`. The task receives the environment's `/v6` Bus API base.
   The execution role permits only the named SSM values and no SendGrid key.
   Set SecretsKmsKeyArn if these parameters use a customer-managed KMS key.
5. Build and release. The script pushes an immutable image tag and updates the
   checked-in CloudFormation template while preserving existing stack parameters.
   It waits for CloudFormation stabilization/circuit-breaker rollback and verifies
   the retained ECS task definition. Startup checks ensure migration tables exist.

```sh
aws cloudformation create-stack --stack-name forms-processor-v6-dev \
  --template-body file://deploy/service.yaml \
  --parameters file://deploy/parameters-dev.json --capabilities CAPABILITY_IAM
aws cloudformation wait stack-create-complete --stack-name forms-processor-v6-dev

docker build -t forms-processor-v6:candidate .
python3 deploy/release.py dev dev-UNIQUE-RELEASE-ID
```

The release script requires Python 3 with boto3, Docker, and an existing stable
stack. Use inherited temporary AWS credentials; never write them into images or
the repo.
Production release requires `PRODUCTION_AWS_ACCOUNT_ID` in the CircleCI project or
context as an explicit account guard. Dev is restricted to account 811668436784.
CloudFormation parameters intentionally have no dev-network defaults. Each AWS
account gets one fixed service/repository name; do not bootstrap two environments
in the same account under these names.

CircleCI uses `org-global`, the pinned `tc-deploy-scripts` v1.4.20 credential helper,
and serial deployments per environment. The GitHub repository must be connected
to CircleCI and permitted to use the context. Deployment does not auto-enable any
email flow. Update the database settings and enable explicitly when ready.

To roll back application code, update ImageTag to a previously verified ECR tag in
CloudFormation, preserving the other parameters. Keep additive DB migrations.
Do not deploy through the shared master_deploy.sh after adopting this stack, because
that would change the ECS service outside CloudFormation. Changes to new template
parameters without defaults require explicit bootstrap values. Removed parameters
are filtered when updating the template; new parameters with defaults use those defaults.

API migration source is in the sibling forms-api-v6 repository, not owned or
silently rerun by this worker. The two repository changes must be released in order.
