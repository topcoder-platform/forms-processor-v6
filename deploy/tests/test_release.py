"""Offline integration tests against the pinned shared deployer, without AWS calls."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SUITE = Path(os.environ.get('TEST_DEPLOY_SUITE', '/tmp/tc-deploy-scripts'))
spec = importlib.util.spec_from_file_location('tcdeploy', SUITE / 'tcdeploy.py')
d = importlib.util.module_from_spec(spec)
sys.modules['tcdeploy'] = d
spec.loader.exec_module(d)
spec = importlib.util.spec_from_file_location('processor_release', ROOT / 'deploy/release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
TAG = 'a' * 40 + '-300'
RUNTIME_DIGEST = 'sha256:' + '1' * 64
MIGRATION_DIGEST = 'sha256:' + '2' * 64


class AWS:
    def __init__(self, environment='dev'):
        self.m = d.read_manifest(ROOT / 'deploy' / (environment + '.json'))
        m = self.m
        self.calls = []
        self.definition = d.arn(m, 'ecs', 'task-definition/' + r.APP + ':10')
        self.task_arn = d.arn(m, 'ecs', 'task/' + m['cluster'] + '/' + 'a' * 32)
        self.task = {
            'family': r.APP, 'status': 'ACTIVE', 'taskDefinitionArn': self.definition,
            'taskRoleArn': m['taskRoleArn'], 'executionRoleArn': m['executionRoleArn'],
            'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'], 'cpu': '256', 'memory': '512',
            'containerDefinitions': [{'name': r.APP, 'image': 'old', 'essential': True,
                'healthCheck': {'command': ['CMD', 'node', '-e', 'process.exit(0)']},
                'environment': [{'name': 'NODE_ENV', 'value': 'production'}, {'name': 'KAFKA_GROUP_ID', 'value': 'forms'}],
                'secrets': [{'name': 'DATABASE_URL', 'valueFrom': '/runtime/url'}, {'name': 'AUTH0_CLIENT_SECRET', 'valueFrom': '/runtime/auth'}],
                'entryPoint': ['old-entrypoint'], 'readonlyRootFilesystem': True,
                'portMappings': [{'containerPort': 3000}]}],
        }
        self.service = {
            'serviceArn': d.arn(m, 'ecs', 'service/' + m['cluster'] + '/' + r.APP),
            'status': 'ACTIVE', 'taskDefinition': self.definition, 'desiredCount': 1,
            'runningCount': 1, 'pendingCount': 0,
            'deploymentConfiguration': {'deploymentCircuitBreaker': {'enable': True, 'rollback': True}},
            'deployments': [{'taskDefinition': self.definition, 'rolloutState': 'COMPLETED'}],
            'networkConfiguration': {'awsvpcConfiguration': {'subnets': ['private'], 'securityGroups': ['processor'], 'assignPublicIp': 'DISABLED'}},
        }
        self.saved = {self.definition: deepcopy(self.task)}
        self.saved_tags = {self.definition: []}
        self.exit_code = 0
        self.migration_digest = MIGRATION_DIGEST
        self.launch_failure = False
        self.missing_once = False
        self.never_stop = False
        self.change_after_migration = False
        self.tamper_definition = False

    def call(self, api, operation, **kwargs):
        assert api == 'ecs', api
        self.calls.append((operation, deepcopy(kwargs)))
        if operation == 'describe-services':
            return {'services': [deepcopy(self.service)]}
        if operation == 'describe-task-definition':
            arn = kwargs['taskDefinition']
            task = deepcopy(self.saved[arn])
            if self.tamper_definition and '-migrate:' in arn:
                task['containerDefinitions'][0]['command'] = ['wrong']
            return {'taskDefinition': task, 'tags': self.saved_tags[arn]}
        if operation == 'register-task-definition':
            request = deepcopy(kwargs)
            tags = request.pop('tags', [])
            arn = d.arn(self.m, 'ecs', 'task-definition/' + request['family'] + ':11')
            request.update(taskDefinitionArn=arn, status='ACTIVE')
            self.saved[arn] = request
            self.saved_tags[arn] = tags
            return {'taskDefinition': deepcopy(request)}
        if operation == 'run-task':
            self.migration_definition = kwargs['taskDefinition']
            if self.launch_failure:
                return {'failures': [{'reason': 'RESOURCE:MEMORY'}], 'tasks': []}
            return {'tasks': [{'taskArn': self.task_arn}]}
        if operation == 'describe-tasks':
            if self.service['taskDefinition'] == self.definition:
                if self.missing_once:
                    self.missing_once = False
                    return {'tasks': [], 'failures': [{'reason': 'MISSING'}]}
                if self.change_after_migration:
                    self.service['taskDefinition'] = 'another-deployment'
                return {'tasks': [{'taskArn': self.task_arn, 'taskDefinitionArn': self.migration_definition,
                    'lastStatus': 'RUNNING' if self.never_stop else 'STOPPED',
                    'containers': [{'name': r.APP, 'exitCode': self.exit_code, 'imageDigest': self.migration_digest}]}]}
            return {'tasks': [{'taskDefinitionArn': self.service['taskDefinition'], 'lastStatus': 'RUNNING',
                'healthStatus': 'HEALTHY', 'containers': [{'name': r.APP, 'imageDigest': RUNTIME_DIGEST, 'lastStatus': 'RUNNING'}]}]}
        if operation == 'update-service':
            self.service['taskDefinition'] = kwargs['taskDefinition']
            self.service['deployments'] = [{'taskDefinition': kwargs['taskDefinition'], 'rolloutState': 'COMPLETED'}]
            return {'service': deepcopy(self.service)}
        if operation == 'list-tasks':
            return {'taskArns': [self.task_arn]}
        raise AssertionError(operation)


class Publisher:
    def __init__(self, aws, fail=None):
        self.aws, self.fail = aws, fail

    def publish(self, name, local, tag):
        self.aws.calls.append(('publish', {'local': local, 'tag': tag}))
        if local == self.fail:
            raise d.DeployError('Image scan exceeds the release threshold')
        digest = MIGRATION_DIGEST if local.endswith(':migrate-candidate') else RUNTIME_DIGEST
        return self.aws.m['accountId'] + '.dkr.ecr.us-east-1.amazonaws.com/' + r.APP + '@' + digest


class MigrationTests(unittest.TestCase):
    def release(self, aws, publisher=None):
        return r.release(aws, aws.m, publisher or Publisher(aws), TAG)

    def assert_not_promoted(self, aws):
        self.assertFalse(any(op == 'update-service' for op, _ in aws.calls))
        self.assertFalse(any(op == 'register-task-definition' and args['family'] == r.APP for op, args in aws.calls))

    def test_both_environments_migrate_before_runtime_update(self):
        for env in ('dev', 'prod'):
            with self.subTest(environment=env):
                aws = AWS(env)
                result = self.release(aws)
                ops = [op for op, _ in aws.calls]
                self.assertLess(ops.index('run-task'), ops.index('update-service'))
                self.assertEqual(ops.count('publish'), 2)
                migration_tag = [args['tag'] for op, args in aws.calls if op == 'publish'][1]
                self.assertEqual(migration_tag, r.migration_revision() + '-' + TAG + '-migrate')
                self.assertLessEqual(len(migration_tag), 128)
                self.assertEqual(result['migrationTask'], aws.task_arn)
                self.assertTrue(result['migrationImage'].endswith(MIGRATION_DIGEST))
                self.assertEqual(aws.saved[result['taskDefinition']]['containerDefinitions'][0]['secrets'], aws.task['containerDefinitions'][0]['secrets'])
                run = next(args for op, args in aws.calls if op == 'run-task')
                self.assertEqual(run['networkConfiguration'], aws.service['networkConfiguration'])
                self.assertEqual(run['launchType'], 'FARGATE')
                self.assertEqual(len(run['clientToken']), 64)

    def test_migration_task_uses_only_migration_secret(self):
        aws = AWS()
        original = deepcopy(aws.task)
        request = r.migration_request(aws.m, aws.task, [], 'repo@' + MIGRATION_DIGEST)
        c = request['containerDefinitions'][0]
        self.assertEqual(c['secrets'], [{'name': 'DATABASE_URL', 'valueFrom': r.MIGRATION_PARAMETER}])
        self.assertEqual(c['command'], ['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'])
        self.assertNotIn('healthCheck', c)
        self.assertEqual(c['entryPoint'], [])
        self.assertFalse(c['readonlyRootFilesystem'])
        self.assertEqual(request['executionRoleArn'], aws.m['executionRoleArn'])
        self.assertEqual(aws.task, original)

    def test_failed_or_missing_exit_code_blocks_both_environments(self):
        for env in ('dev', 'prod'):
            for code in (1, 137, None):
                with self.subTest(environment=env, code=code):
                    aws = AWS(env)
                    aws.exit_code = code
                    with self.assertRaisesRegex(d.DeployError, 'Migration failed'):
                        self.release(aws)
                    self.assert_not_promoted(aws)

    def test_wrong_migration_digest_blocks_rollout(self):
        aws = AWS()
        aws.migration_digest = RUNTIME_DIGEST
        with self.assertRaisesRegex(d.DeployError, 'unexpected image'):
            self.release(aws)
        self.assert_not_promoted(aws)

    def test_failed_scan_prevents_any_migration(self):
        for local in (r.APP + ':candidate', r.APP + ':migrate-candidate'):
            aws = AWS()
            with self.assertRaisesRegex(d.DeployError, 'scan'):
                self.release(aws, Publisher(aws, fail=local))
            self.assertFalse(any(op == 'register-task-definition' for op, _ in aws.calls))

    def test_failed_task_launch_blocks_rollout(self):
        aws = AWS()
        aws.launch_failure = True
        with self.assertRaisesRegex(d.DeployError, 'could not start'):
            self.release(aws)
        self.assert_not_promoted(aws)

    def test_registration_readback_rejects_changed_command(self):
        aws = AWS()
        aws.tamper_definition = True
        with self.assertRaisesRegex(d.DeployError, 'configuration differs'):
            self.release(aws)
        self.assertFalse(any(op == 'run-task' for op, _ in aws.calls))

    def test_temporarily_missing_task_is_retried(self):
        aws = AWS()
        aws.missing_once = True
        with patch.object(r.time, 'sleep'):
            self.release(aws)

    def test_timeout_blocks_rollout(self):
        aws = AWS()
        aws.never_stop = True
        with patch.object(r.time, 'monotonic', side_effect=[0, 0, 901]), patch.object(r.time, 'sleep'):
            with self.assertRaisesRegex(d.DeployError, 'timed out'):
                self.release(aws)
        self.assert_not_promoted(aws)

    def test_concurrent_service_change_blocks_rollout(self):
        aws = AWS()
        aws.change_after_migration = True
        with self.assertRaisesRegex(d.DeployError, 'another deployment'):
            self.release(aws)
        self.assert_not_promoted(aws)

    def test_unexpected_roles_or_sidecars_fail_before_publication(self):
        for change in ('role', 'sidecar'):
            aws = AWS()
            if change == 'role':
                aws.saved[aws.definition]['executionRoleArn'] = 'unexpected'
            else:
                aws.saved[aws.definition]['containerDefinitions'].append({'name': 'sidecar'})
            with self.assertRaises(d.DeployError):
                self.release(aws)
            self.assertFalse(any(op == 'publish' for op, _ in aws.calls))

    def test_source_is_an_immutable_commit(self):
        self.assertRegex((ROOT / 'deploy/forms-api-revision').read_text().strip(), r'^[a-f0-9]{40}$')

    def test_wrong_branch_rejected_before_authentication(self):
        with patch.dict(os.environ, {'CIRCLE_BRANCH': 'feature/test'}, clear=True), patch.object(sys, 'argv', ['release.py', str(ROOT / 'deploy/prod.json')]), patch.object(d, 'authenticate') as auth:
            with self.assertRaisesRegex(d.DeployError, 'branch'):
                r.main()
            auth.assert_not_called()


if __name__ == '__main__':
    unittest.main()
