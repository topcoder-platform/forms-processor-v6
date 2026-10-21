#!/usr/bin/env python3
"""Release a prebuilt image to an existing ECS service, without provisioning infrastructure.

Usage: release.py dev|production IMAGE_TAG [LOCAL_IMAGE]. Uses inherited temporary
AWS credentials, boto3 and Docker. API migrations must precede this release.
"""
import base64
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

import boto3
from botocore.config import Config

APP = 'forms-processor-v6'
CLUSTER = 'topcoder-infrastructure'
ACCOUNTS = {'dev': '811668436784', 'production': '409275337247'}
SSM_CLIENT_CONFIG = Config(retries={'mode': 'standard', 'total_max_attempts': 10})


def read_service(ecs):
    """Read the fixed ECS service using ecs; return active service or raise on missing/invalid state."""
    result = ecs.describe_services(cluster=CLUSTER, services=[APP])
    if result.get('failures') or len(result.get('services', [])) != 1:
        raise RuntimeError('Existing forms-processor-v6 ECS service is required')
    service = result['services'][0]
    if service['status'] != 'ACTIVE':
        raise RuntimeError('Existing ECS service must be active')
    return service


def secret_references(ssm):
    """Resolve named SSM references in batches of ten, without decrypting SecureStrings.

    Takes an SSM client; returns name/valueFrom pairs. Keycloak settings use the dedicated workload prefix with no Auth0/shared credential
    fallback. Kafka uses globals. Missing optional sales
    settings permit a disabled-flow deployment. Raises for absent required values
    or sales/Bus parameters that are not SecureStrings; AWS errors propagate after
    client retries. GetParameters values are discarded; only names/types are used.
    Avoids the low-throughput DescribeParameters scan of whole parameter prefixes.
    """
    prefixes = {'api': '/config/forms-api-v6/appvar',
                'app': f'/config/{APP}/appvar',
                'keycloak': f'/config/{APP}/keycloak-m2m',
                'common': '/config/common/global-appvar'}
    sources = {'DATABASE_URL': ['api'], 'BUSAPI_URL': ['app'],
               'KEYCLOAK_CLIENT_ID': ['keycloak'], 'KEYCLOAK_CLIENT_SECRET': ['keycloak'],
               'KEYCLOAK_ISSUER': ['keycloak'], 'KEYCLOAK_TOKEN_URL': ['keycloak'],
               'KEYCLOAK_AUDIENCE': ['keycloak'], 'KEYCLOAK_SCOPE': ['keycloak'],
               'KAFKA_URL': ['common'], 'KAFKA_SSL_ENABLED': ['common'],
               'LETS_TALK_RECIPIENTS': ['app'], 'LETS_TALK_SENDGRID_TEMPLATE_ID': ['app']}
    names = [prefixes[source] + '/' + name
             for name, candidates in sources.items() for source in candidates]
    available = {}
    for start in range(0, len(names), 10):
        response = ssm.get_parameters(Names=names[start:start + 10], WithDecryption=False)
        available.update({p['Name']: p['Type'] for p in response['Parameters']})
    optional = {'KEYCLOAK_SCOPE', 'KAFKA_SSL_ENABLED',
                'LETS_TALK_RECIPIENTS', 'LETS_TALK_SENDGRID_TEMPLATE_ID'}
    references = []
    for name, candidates in sources.items():
        path = next((prefixes[source] + '/' + name for source in candidates
                     if prefixes[source] + '/' + name in available), None)
        if path is None:
            if name not in optional:
                raise RuntimeError('Missing required SSM parameter: ' + name)
            continue
        if name in ('BUSAPI_URL', 'KEYCLOAK_CLIENT_SECRET', 'LETS_TALK_RECIPIENTS', 'LETS_TALK_SENDGRID_TEMPLATE_ID'):
            if available[path] != 'SecureString':
                raise RuntimeError('SecureString required: ' + path)
        references.append({'name': name, 'valueFrom': path})
    return references


def task_request(ecs, current, image, references):
    """Clone the live task fields, select Keycloak, remove legacy credentials and replace image/secrets.

    Inputs are the ECS client, described task, ECR image URI and SSM references.
    Returns a register-task-definition request, preserving roles/resources/sidecars.
    Raises if family or application container identity differs from the fixed service.
    """
    if current['family'] != APP:
        raise RuntimeError('Unexpected task family')
    allowed = ecs.meta.service_model.operation_model('RegisterTaskDefinition').input_shape.members
    request = {key: deepcopy(value) for key, value in current.items() if key in allowed}
    containers = [c for c in request['containerDefinitions'] if c['name'] == APP]
    if len(containers) != 1:
        raise RuntimeError('Expected one forms-processor-v6 container')
    container = containers[0]
    managed = {'M2M_PROVIDER', 'KEYCLOAK_CLIENT_ID', 'KEYCLOAK_CLIENT_SECRET',
               'KEYCLOAK_ISSUER', 'KEYCLOAK_TOKEN_URL', 'KEYCLOAK_AUDIENCE', 'KEYCLOAK_SCOPE',
               'DATABASE_URL', 'BUSAPI_URL', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET',
               'AUTH0_URL', 'AUTH0_AUDIENCE', 'AUTH0_PROXY_SERVER_URL', 'KAFKA_URL',
               'LETS_TALK_RECIPIENTS', 'LETS_TALK_SENDGRID_TEMPLATE_ID'}
    # Preserve an existing TLS setting if the global store does not define it.
    managed.update(ref['name'] for ref in references)
    container['environment'] = [e for e in container.get('environment', []) if e['name'] not in managed]
    container['environment'].append({'name': 'M2M_PROVIDER', 'value': 'keycloak'})
    container['secrets'] = [s for s in container.get('secrets', []) if s['name'] not in managed] + references
    container['image'] = image
    container['healthCheck'] = {
        'command': ['CMD', 'node', '-e',
                    "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
        'interval': 30, 'timeout': 5, 'retries': 3, 'startPeriod': 60,
    }
    return request


def verify_service(ecs, definition_arn):
    """Observe one rollout using ecs and the requested ARN; return service when tasks are healthy.

    Returns None while converging; raises on rollback/replacement/failed rollout or
    AWS errors. Used by the bounded release waiter, including activation from zero.
    """
    service = read_service(ecs)
    if service['taskDefinition'] != definition_arn:
        raise RuntimeError('ECS rolled back or replaced the requested task definition')
    deployments = service['deployments']
    if any(d.get('rolloutState') == 'FAILED' for d in deployments):
        raise RuntimeError('ECS deployment failed')
    if (len(deployments) != 1 or deployments[0].get('rolloutState') != 'COMPLETED'
            or service['runningCount'] != service['desiredCount'] or service['desiredCount'] < 1
            or service['pendingCount']):
        return None
    arns = []
    for page in ecs.get_paginator('list_tasks').paginate(
            cluster=CLUSTER, serviceName=APP, desiredStatus='RUNNING'):
        arns.extend(page['taskArns'])
    tasks = []
    for start in range(0, len(arns), 100):
        tasks.extend(ecs.describe_tasks(cluster=CLUSTER, tasks=arns[start:start + 100])['tasks'])
    healthy = [t for t in tasks if t['taskDefinitionArn'] == definition_arn
               and t.get('healthStatus') == 'HEALTHY' and t['lastStatus'] == 'RUNNING']
    return service if len(healthy) >= service['desiredCount'] else None


def main():
    """Read CLI arguments, verify account/service, push image, register a revision and update ECS.

    Returns None after verified deployment and a non-secret release artifact. Raises
    on invalid arguments/account, missing existing infrastructure, AWS/Docker errors,
    concurrent service change, rollback or a 30-minute timeout. Never updates stacks,
    creates services, modifies networking/IAM, runs migrations, or enables email flows.
    """
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ACCOUNTS:
        raise RuntimeError(__doc__)
    environment, tag = sys.argv[1:3]
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,110}', tag):
        raise RuntimeError('Invalid image tag')
    session = boto3.Session(region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    account = session.client('sts').get_caller_identity()['Account']
    if account != ACCOUNTS[environment]:
        raise RuntimeError('AWS account does not match requested environment')
    ecs, ecr = [session.client(name) for name in ('ecs', 'ecr')]
    ssm = session.client('ssm', config=SSM_CLIENT_CONFIG)
    service = read_service(ecs)
    if len(service['deployments']) != 1 or service['deployments'][0].get('rolloutState') != 'COMPLETED':
        raise RuntimeError('Existing ECS deployment must be stable before releasing')
    current = ecs.describe_task_definition(taskDefinition=service['taskDefinition'])['taskDefinition']
    references = secret_references(ssm)
    repository = ecr.describe_repositories(repositoryNames=[APP])['repositories'][0]['repositoryUri']
    image = f'{repository}:{tag}'
    request = task_request(ecs, current, image, references)
    authorization = ecr.get_authorization_token()['authorizationData'][0]
    user, password = base64.b64decode(authorization['authorizationToken']).decode().split(':', 1)
    subprocess.run(['docker', 'login', '--username', user, '--password-stdin', authorization['proxyEndpoint']],
                   input=password, text=True, check=True, stdout=subprocess.DEVNULL)
    local_image = sys.argv[3] if len(sys.argv) == 4 else APP + ':candidate'
    subprocess.run(['docker', 'tag', local_image, image], check=True)
    subprocess.run(['docker', 'push', image], check=True)
    if read_service(ecs)['taskDefinition'] != service['taskDefinition']:
        raise RuntimeError('Service changed during image push; retry after inspecting concurrent release')
    definition_arn = ecs.register_task_definition(**request)['taskDefinition']['taskDefinitionArn']
    ecs.update_service(cluster=CLUSTER, service=APP, taskDefinition=definition_arn,
                       desiredCount=max(1, service['desiredCount']))
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        retained = verify_service(ecs, definition_arn)
        if retained:
            break
        print('Waiting for healthy requested ECS revision', flush=True)
        time.sleep(15)
    else:
        raise RuntimeError('ECS deployment timed out; inspect before retrying')
    evidence = {'environment': environment, 'cluster': CLUSTER, 'service': APP, 'image': image,
                'taskDefinition': definition_arn, 'previousTaskDefinition': service['taskDefinition'],
                'runningCount': retained['runningCount']}
    Path(f'deploy/release-{environment}.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
