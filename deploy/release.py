#!/usr/bin/env python3
"""Apply pinned Forms API migrations before promoting the processor in dev/prod."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

sys.path.insert(0, '/tmp/tc-deploy-scripts')
import tcdeploy as d

APP = 'forms-processor-v6'
MIGRATION_FAMILY = APP + '-migrate'
MIGRATION_PARAMETER = '/config/forms-api-v6/appvar/MIGRATION_DATABASE_URL'


def migration_revision():
    revision = Path(__file__).with_name('forms-api-revision').read_text().strip()
    d.require(re.fullmatch(r'[a-f0-9]{40}', revision), 'Invalid Forms API migration source revision')
    return revision


def migration_request(m, task, tags, image):
    """Derive a one-shot task, retaining roles/resources and only the migration secret."""
    request = d.task_request(m, task, tags, {APP: image})
    containers = request['containerDefinitions']
    d.require(len(containers) == 1 and containers[0]['name'] == APP,
              'Expected a single processor container for migration')
    request['family'] = MIGRATION_FAMILY
    container = containers[0]
    container.pop('healthCheck', None)
    container['entryPoint'] = []
    container.pop('environmentFiles', None)
    container['workingDirectory'] = '/app'
    container['portMappings'] = []
    container['readonlyRootFilesystem'] = False
    container['environment'] = [{'name': 'NODE_ENV', 'value': 'production'}]
    container['secrets'] = [{'name': 'DATABASE_URL', 'valueFrom': MIGRATION_PARAMETER}]
    container['command'] = ['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy']
    return request


def migrate(aws, m, service, task, tags, image, release_tag):
    """Run the exact migration digest in the service network; fail closed on any failure."""
    request = migration_request(m, task, tags, image)
    definition = aws.call('ecs', 'register-task-definition', **request)['taskDefinition']['taskDefinitionArn']
    d.require(re.fullmatch(re.escape(d.arn(m, 'ecs', 'task-definition/' + MIGRATION_FAMILY)) + r':[0-9]+', definition),
              'Unexpected migration task definition')
    saved = aws.call('ecs', 'describe-task-definition', taskDefinition=definition, include=['TAGS'])
    actual = {k: v for k, v in saved['taskDefinition'].items() if k in d.TASK_FIELDS}
    actual['tags'] = sorted(saved.get('tags', []), key=lambda v: v['key'])
    expected = {**request, 'tags': sorted(request.get('tags', []), key=lambda v: v['key'])}
    d.require(actual == expected, 'Registered migration configuration differs')
    result = aws.call('ecs', 'run-task', cluster=m['cluster'], taskDefinition=definition,
                      launchType='FARGATE', networkConfiguration=service['networkConfiguration'],
                      count=1, startedBy='forms-processor-migrate',
                      clientToken=hashlib.sha256((release_tag + definition).encode()).hexdigest())
    d.require(not result.get('failures') and len(result.get('tasks', [])) == 1,
              'Migration task could not start; processor was not promoted')
    task_arn = result['tasks'][0]['taskArn']
    d.require(re.fullmatch(re.escape(d.arn(m, 'ecs', 'task/' + m['cluster'] + '/')) + r'[a-f0-9]{32}', task_arn),
              'Unexpected migration task ARN')
    print('Migration task: ' + task_arn, flush=True)
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        result = aws.call('ecs', 'describe-tasks', cluster=m['cluster'], tasks=[task_arn])
        # A newly launched task may not be visible immediately. Only retry MISSING.
        if not result.get('tasks') and all(f.get('reason') == 'MISSING' for f in result.get('failures', [])):
            time.sleep(10)
            continue
        d.require(not result.get('failures') and len(result.get('tasks', [])) == 1,
                  'Could not inspect migration task')
        current = result['tasks'][0]
        d.require(current.get('taskDefinitionArn') == definition and current.get('taskArn') == task_arn,
                  'Migration task identity differs')
        if current.get('lastStatus') == 'STOPPED':
            containers = current.get('containers', [])
            d.require(len(containers) == 1 and containers[0].get('name') == APP
                      and containers[0].get('exitCode') == 0
                      and containers[0].get('imageDigest') == image.rsplit('@', 1)[1],
                      'Migration failed or used an unexpected image; processor was not promoted')
            return task_arn
        time.sleep(10)
    raise d.DeployError('Migration timed out; processor was not promoted. Inspect task ' + task_arn + ' before retrying')


class PublishedRuntime:
    """Supply the already scanned runtime to the shared rollout implementation."""
    def __init__(self, image, release_tag):
        self.image, self.release_tag = image, release_tag

    def publish(self, name, local, tag):
        d.require((name, local, tag) == (APP, APP + ':candidate', self.release_tag),
                  'Unexpected runtime publication request')
        return self.image


def release(aws, m, publisher, release_tag):
    previous = d.read_service(aws, m)
    d.require(d.stable(previous, previous['taskDefinition']), 'Processor must be stable before migrating')
    response = aws.call('ecs', 'describe-task-definition', taskDefinition=previous['taskDefinition'], include=['TAGS'])
    task, tags = response['taskDefinition'], response.get('tags', [])
    migration_request(m, task, tags, 'preflight@sha256:' + '0' * 64)
    # Scan both images before any schema change, with an independent budget per image.
    runtime = publisher.publish(APP, APP + ':candidate', release_tag)
    # The shared publisher checks the image source label against the tag's first
    # 40 characters. Keep the API source identity, plus this processor release's
    # unique identity, rather than relabelling a different repository's image.
    source = migration_revision()
    migration = publisher.publish(APP, APP + ':migrate-candidate', source + '-' + release_tag + '-migrate')
    d.require(d.stable(d.read_service(aws, m), previous['taskDefinition']), 'Service changed before migration')
    task_arn = migrate(aws, m, previous, task, tags, migration, release_tag)
    d.require(d.stable(d.read_service(aws, m), previous['taskDefinition']), 'Service changed during migration')
    result = d.deploy(aws, m, {APP: APP + ':candidate'}, release_tag, PublishedRuntime(runtime, release_tag))
    result.update(migrationTask=task_arn, migrationImage=migration, migrationSourceRevision=source)
    return result


def main():
    m = d.read_manifest(sys.argv[1])
    d.require(m['service'] == APP and m['taskFamily'] == APP and m['images'] == {APP: APP},
              'Expected processor manifest')
    d.require(os.environ.get('CIRCLE_BRANCH') == m['branch'] and not os.environ.get('CIRCLE_TAG'),
              'Wrong deployment branch')
    repository = os.environ.get('CIRCLE_PROJECT_USERNAME', '') + '/' + os.environ.get('CIRCLE_PROJECT_REPONAME', '')
    d.require(repository == m['repository'].removeprefix('github.com/'), 'Wrong deployment repository')
    tag = os.environ.get('CIRCLE_SHA1', '') + '-' + os.environ.get('CIRCLE_BUILD_NUM', '')
    d.require(re.fullmatch(r'[a-f0-9]{40}-[0-9]{1,12}', tag), 'Invalid release identity')
    aws = d.authenticate(m, os.environ.get('CIRCLE_OIDC_TOKEN_V3'), ['ecs:RunTask'])
    with tempfile.TemporaryDirectory(prefix='processor-release-') as directory:
        result = release(aws, m, d.Publisher(aws, m, directory), tag)
    Path('deploy/release-' + m['environment'] + '.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except d.DeployError as error:
        print('Processor release stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
