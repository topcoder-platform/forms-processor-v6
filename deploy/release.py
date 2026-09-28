#!/usr/bin/env python3
"""Push a prebuilt image and update the existing CloudFormation stack.

Usage: release.py dev|production IMAGE_TAG [LOCAL_IMAGE]. Uses inherited AWS
credentials and Docker. Run the forms-api-v6 migration before the first release.
"""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import boto3


def main():
    """Validate arguments/account, push an immutable tag, promote the stack, and record verified ECS state.

    Returns None; raises on AWS/Docker failure, unstable stacks, or failed promotion.
    Passwords are passed on stdin and never logged. Existing network parameters are preserved.
    """
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ('dev', 'production'):
        raise RuntimeError(__doc__)
    environment, tag = sys.argv[1:3]
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,110}', tag):
        raise RuntimeError('Invalid image tag')
    local_image = sys.argv[3] if len(sys.argv) == 4 else 'forms-processor-v6:candidate'
    session = boto3.Session(region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    expected = '811668436784' if environment == 'dev' else os.environ.get('PRODUCTION_AWS_ACCOUNT_ID')
    if not expected or session.client('sts').get_caller_identity()['Account'] != expected:
        raise RuntimeError('AWS account mismatch; production requires PRODUCTION_AWS_ACCOUNT_ID')
    cfn, ecr, ecs = [session.client(name) for name in ('cloudformation', 'ecr', 'ecs')]
    stack_name = f'forms-processor-v6-{environment}'
    stack = cfn.describe_stacks(StackName=stack_name)['Stacks'][0]
    if stack['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'):
        raise RuntimeError('Stack is not stable; inspect before retrying')
    settings = {p['ParameterKey']: p['ParameterValue'] for p in stack['Parameters']}
    if settings['Environment'] != environment:
        raise RuntimeError('Stack environment mismatch')
    outputs = {o['OutputKey']: o['OutputValue'] for o in stack['Outputs']}
    repository = outputs['RepositoryUri']
    authorization = ecr.get_authorization_token()['authorizationData'][0]
    user, password = base64.b64decode(authorization['authorizationToken']).decode().split(':', 1)
    subprocess.run(['docker', 'login', '--username', user, '--password-stdin', authorization['proxyEndpoint']], input=password, text=True, check=True, stdout=subprocess.DEVNULL)
    image = f'{repository}:{tag}'
    subprocess.run(['docker', 'tag', local_image, image], check=True)
    subprocess.run(['docker', 'push', image], check=True)
    template = Path('deploy/service.yaml').read_text()
    # Preserve only parameters still declared by the new template; additions use defaults.
    declared = {p['ParameterKey'] for p in cfn.validate_template(TemplateBody=template)['Parameters']}
    parameters = [{'ParameterKey': key, 'UsePreviousValue': True} for key in settings if key in declared and key not in ('ImageTag', 'DesiredCount')]
    parameters += [{'ParameterKey': 'ImageTag', 'ParameterValue': tag}, {'ParameterKey': 'DesiredCount', 'ParameterValue': str(max(1, int(settings['DesiredCount'])))}]
    cfn.update_stack(StackName=stack_name, TemplateBody=template, Parameters=parameters, Capabilities=['CAPABILITY_IAM'])
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        state = cfn.describe_stacks(StackName=stack_name)['Stacks'][0]['StackStatus']
        if state == 'UPDATE_COMPLETE':
            break
        if state not in ('UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'):
            raise RuntimeError('Deployment failed or rolled back: ' + state)
        print('Waiting for CloudFormation: ' + state, flush=True)
        time.sleep(15)
    else:
        raise RuntimeError('Deployment timed out; inspect existing operation before retrying')
    service = ecs.describe_services(cluster=settings['ClusterName'], services=['forms-processor-v6'])['services'][0]
    task = ecs.describe_task_definition(taskDefinition=service['taskDefinition'])['taskDefinition']
    if task['containerDefinitions'][0]['image'] != image or service['runningCount'] != service['desiredCount']:
        raise RuntimeError('ECS did not retain the requested release')
    evidence = {'stack': stack_name, 'image': image, 'taskDefinition': service['taskDefinition'], 'runningCount': service['runningCount']}
    Path(f'deploy/release-{environment}.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
