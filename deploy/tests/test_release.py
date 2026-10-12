"""Exercise rollout guards and secret-reference selection without contacting AWS."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import boto3

spec = importlib.util.spec_from_file_location('release', Path(__file__).parents[1] / 'release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    """Verify that releases update existing ECS tasks and cannot cross environment boundaries."""

    def test_missing_service_is_rejected(self):
        """A missing service raises before release can provision anything; no inputs or return value."""
        ecs = Mock()
        ecs.describe_services.return_value = {'services': [], 'failures': [{'reason': 'MISSING'}]}
        with self.assertRaisesRegex(RuntimeError, 'Existing'):
            release.read_service(ecs)
        ecs.update_service.assert_not_called()

    def test_secret_sources_and_types(self):
        """Select API identity, global Kafka and processor Bus/email SecureStrings; rejects invalid metadata."""
        entries = {
            '/config/forms-api-v6/appvar': ['DATABASE_URL', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'AUTH0_URL'],
            '/config/forms-processor-v6/appvar': ['BUSAPI_URL', 'LETS_TALK_RECIPIENTS', 'LETS_TALK_SENDGRID_TEMPLATE_ID'],
            '/config/common/global-appvar': ['AUTH0_URL', 'AUTH0_AUDIENCE', 'AUTH0_PROXY_SERVER_URL', 'KAFKA_URL', 'KAFKA_SSL_ENABLED'],
        }
        ssm = Mock()
        pages = [[{'Parameters': [{'Name': path + '/' + name, 'Type': 'SecureString'} for name in names]}]
                 for path, names in entries.items()]
        ssm.get_paginator.return_value.paginate.side_effect = pages
        refs = {r['name']: r['valueFrom'] for r in release.secret_references(ssm)}
        self.assertEqual(refs['AUTH0_URL'], '/config/forms-api-v6/appvar/AUTH0_URL')
        self.assertEqual(refs['KAFKA_URL'], '/config/common/global-appvar/KAFKA_URL')
        self.assertEqual(refs['BUSAPI_URL'], '/config/forms-processor-v6/appvar/BUSAPI_URL')
        self.assertEqual(len(refs), 11)
        ssm.get_parameter.assert_not_called()
        pages[1][0]['Parameters'][0]['Type'] = 'String'
        ssm.get_paginator.return_value.paginate.side_effect = pages
        with self.assertRaisesRegex(RuntimeError, 'SecureString'):
            release.secret_references(ssm)
        ssm.get_paginator.return_value.paginate.side_effect = [[{'Parameters': []}]] * 3
        with self.assertRaisesRegex(RuntimeError, 'Missing required'):
            release.secret_references(ssm)

    def test_clone_preserves_roles_resources_and_removes_stale_literals(self):
        """Cloning returns a registerable copy with exact secret overrides and unchanged sidecars/roles."""
        ecs = boto3.client('ecs', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
        current = {'family': release.APP, 'taskDefinitionArn': 'old', 'revision': 7,
                   'executionRoleArn': 'execution', 'taskRoleArn': 'task', 'cpu': '256', 'memory': '512',
                   'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'],
                   'containerDefinitions': [{'name': release.APP, 'image': 'old', 'readonlyRootFilesystem': True,
                       'environment': [{'name': 'BUSAPI_URL', 'value': 'old'}, {'name': 'KAFKA_SSL_ENABLED', 'value': 'true'}],
                       'secrets': [{'name': 'LETS_TALK_RECIPIENTS', 'valueFrom': 'old'}, {'name': 'OTHER', 'valueFrom': '/other'}]},
                       {'name': 'sidecar', 'image': 'sidecar'}]}
        refs = [{'name': 'BUSAPI_URL', 'valueFrom': '/config/forms-processor-v6/appvar/BUSAPI_URL'}]
        result = release.task_request(ecs, current, 'new', refs)
        self.assertNotIn('revision', result)
        self.assertNotIn('taskDefinitionArn', result)
        for key in ['executionRoleArn', 'taskRoleArn', 'cpu', 'memory', 'networkMode', 'requiresCompatibilities']:
            self.assertEqual(result[key], current[key])
        container = result['containerDefinitions'][0]
        self.assertEqual(container['environment'], [{'name': 'KAFKA_SSL_ENABLED', 'value': 'true'}])
        self.assertEqual(container['secrets'], [{'name': 'OTHER', 'valueFrom': '/other'}] + refs)
        self.assertEqual(container['image'], 'new')
        self.assertEqual(current['containerDefinitions'][0]['image'], 'old')
        self.assertEqual(result['containerDefinitions'][1], current['containerDefinitions'][1])
        self.assertIn('healthCheck', container)

    def test_rollback_and_unhealthy_tasks_are_not_success(self):
        """Only healthy tasks of the requested revision finish verification; rollback raises."""
        ecs = Mock()
        service = {'status': 'ACTIVE', 'taskDefinition': 'new', 'desiredCount': 1, 'runningCount': 1,
                   'pendingCount': 0, 'deployments': [{'rolloutState': 'COMPLETED'}]}
        ecs.describe_services.return_value = {'services': [service]}
        ecs.get_paginator.return_value.paginate.return_value = [{'taskArns': ['task']}]
        task = {'taskDefinitionArn': 'new', 'healthStatus': 'UNHEALTHY', 'lastStatus': 'RUNNING'}
        ecs.describe_tasks.return_value = {'tasks': [task]}
        self.assertIsNone(release.verify_service(ecs, 'new'))
        task['healthStatus'] = 'HEALTHY'
        self.assertEqual(release.verify_service(ecs, 'new'), service)
        service['deployments'][0]['rolloutState'] = 'FAILED'
        with self.assertRaisesRegex(RuntimeError, 'failed'):
            release.verify_service(ecs, 'new')
        service['taskDefinition'] = 'old'
        with self.assertRaisesRegex(RuntimeError, 'rolled back'):
            release.verify_service(ecs, 'new')

    def test_wrong_account_stops_before_mutation(self):
        """Production with dev credentials raises before ECR, ECS, SSM or Docker are called."""
        session = Mock(region_name='us-east-1')
        session.client.return_value.get_caller_identity.return_value = {'Account': release.ACCOUNTS['dev']}
        with patch.object(release.boto3, 'Session', return_value=session), \
                patch.object(release.sys, 'argv', ['release.py', 'production', 'candidate']), \
                patch.object(release.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'account'):
                release.main()
        session.client.assert_called_once_with('sts')
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
