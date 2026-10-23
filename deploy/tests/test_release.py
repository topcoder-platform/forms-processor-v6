"""Exercise rollout guards and secret-reference selection without contacting AWS."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import boto3
from botocore.awsrequest import AWSResponse
from botocore.exceptions import ClientError

spec = importlib.util.spec_from_file_location('release', Path(__file__).parents[1] / 'release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    """Verify that releases update existing ECS tasks and cannot cross environment boundaries."""

    def setUp(self):
        """Build named-parameter fixtures for each test; takes no arguments and returns nothing."""
        entries = {
            '/config/forms-api-v6/appvar': ['DATABASE_URL', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'AUTH0_URL'],
            '/config/forms-processor-v6/keycloak-m2m': ['KEYCLOAK_ISSUER', 'KEYCLOAK_TOKEN_URL', 'KEYCLOAK_AUDIENCE', 'KEYCLOAK_CLIENT_ID', 'KEYCLOAK_CLIENT_SECRET', 'KEYCLOAK_SCOPE'],
            '/config/forms-processor-v6/appvar': ['BUSAPI_URL', 'LETS_TALK_RECIPIENTS', 'LETS_TALK_SENDGRID_TEMPLATE_ID'],
            '/config/common/global-appvar': ['USE_KEYCLOAK', 'AUTH0_URL', 'AUTH0_AUDIENCE', 'AUTH0_PROXY_SERVER_URL', 'KAFKA_URL', 'KAFKA_SSL_ENABLED'],
        }
        self.parameters = {
            path + '/' + name: {'Name': path + '/' + name, 'Type': 'SecureString', 'Value': 'unused-ciphertext'}
            for path, names in entries.items() for name in names
        }
        self.ssm = Mock()
        self.ssm.get_parameters.side_effect = self.parameter_response

    def parameter_response(self, *, Names, WithDecryption):
        """Return the requested fixture parameters and absent names; rejects oversized/decrypting reads.

        Called by the SSM mock with AWS request arguments. Reverses result order to
        verify lookup by name, and raises AssertionError for unsafe request options.
        """
        self.assertFalse(WithDecryption)
        self.assertGreater(len(Names), 0)
        self.assertLessEqual(len(Names), 10)
        return {'Parameters': [self.parameters[name] for name in reversed(Names) if name in self.parameters],
                'InvalidParameters': [name for name in Names if name not in self.parameters]}

    def test_missing_service_is_rejected(self):
        """A missing service raises before release can provision anything; no inputs or return value."""
        ecs = Mock()
        ecs.describe_services.return_value = {'services': [], 'failures': [{'reason': 'MISSING'}]}
        with self.assertRaisesRegex(RuntimeError, 'Existing'):
            release.read_service(ecs)
        ecs.update_service.assert_not_called()

    def test_secret_sources_and_types(self):
        """Three bounded non-decrypting reads return only named references with the intended precedence.

        When both providers are configured, both sets and the shared USE_KEYCLOAK flag are
        referenced, so the provider can be switched by the flag alone.
        """
        refs = {r['name']: r['valueFrom'] for r in release.secret_references(self.ssm)}
        self.assertEqual(refs['USE_KEYCLOAK'], '/config/common/global-appvar/USE_KEYCLOAK')
        self.assertEqual(refs['KEYCLOAK_TOKEN_URL'], '/config/forms-processor-v6/keycloak-m2m/KEYCLOAK_TOKEN_URL')
        self.assertEqual(refs['KEYCLOAK_AUDIENCE'], '/config/forms-processor-v6/keycloak-m2m/KEYCLOAK_AUDIENCE')
        self.assertEqual(refs['AUTH0_CLIENT_ID'], '/config/forms-api-v6/appvar/AUTH0_CLIENT_ID')
        self.assertEqual(refs['AUTH0_URL'], '/config/forms-api-v6/appvar/AUTH0_URL')
        self.assertEqual(refs['AUTH0_AUDIENCE'], '/config/common/global-appvar/AUTH0_AUDIENCE')
        self.assertEqual(refs['DATABASE_URL'], '/config/forms-api-v6/appvar/DATABASE_URL')
        self.assertEqual(refs['KAFKA_URL'], '/config/common/global-appvar/KAFKA_URL')
        self.assertEqual(refs['BUSAPI_URL'], '/config/forms-processor-v6/appvar/BUSAPI_URL')
        self.assertEqual(len(refs), 18)
        self.assertNotIn('unused-ciphertext', json.dumps(refs))
        self.assertEqual(self.ssm.get_parameters.call_count, 3)
        requested = [name for call in self.ssm.get_parameters.call_args_list for name in call.kwargs['Names']]
        self.assertEqual(len(requested), 21)
        self.assertEqual(len(set(requested)), 21)
        self.assertNotIn('/config/forms-api-v6/appvar/MIGRATION_DATABASE_URL', requested)
        self.ssm.get_paginator.assert_not_called()
        self.ssm.describe_parameters.assert_not_called()

    def test_optional_parameters_and_no_auth_fallback(self):
        """Optional sales/scope/proxy settings may be absent; absent API Auth0 settings use shared defaults;
        required Keycloak settings never fall back to Auth0."""
        for name in ['LETS_TALK_RECIPIENTS', 'LETS_TALK_SENDGRID_TEMPLATE_ID']:
            del self.parameters['/config/forms-processor-v6/appvar/' + name]
        for name in ['KAFKA_SSL_ENABLED', 'AUTH0_PROXY_SERVER_URL']:
            del self.parameters['/config/common/global-appvar/' + name]
        del self.parameters['/config/forms-processor-v6/keycloak-m2m/KEYCLOAK_SCOPE']
        del self.parameters['/config/forms-api-v6/appvar/AUTH0_URL']
        refs = {r['name']: r['valueFrom'] for r in release.secret_references(self.ssm)}
        self.assertEqual(refs['AUTH0_URL'], '/config/common/global-appvar/AUTH0_URL')
        self.assertEqual(len(refs), 13)
        del self.parameters['/config/forms-processor-v6/keycloak-m2m/KEYCLOAK_TOKEN_URL']
        with self.assertRaisesRegex(RuntimeError, 'KEYCLOAK_TOKEN_URL'):
            release.secret_references(self.ssm)

    def test_provider_sets_are_all_or_nothing_and_the_flag_is_optional(self):
        """USE_KEYCLOAK comes only from the shared global path and may be absent (Auth0 mode).

        Each provider's settings are referenced when complete and skipped when absent; a
        partial set or no complete set raises. Takes no arguments and returns nothing.
        """
        flag = self.parameters.pop('/config/common/global-appvar/USE_KEYCLOAK')
        refs = {r['name'] for r in release.secret_references(self.ssm)}
        self.assertNotIn('USE_KEYCLOAK', refs)
        self.assertIn('KEYCLOAK_CLIENT_SECRET', refs)
        self.parameters['/config/common/global-appvar/USE_KEYCLOAK'] = flag
        for path in ['/config/forms-api-v6/appvar/AUTH0_CLIENT_SECRET',
                     '/config/forms-processor-v6/keycloak-m2m/KEYCLOAK_CLIENT_SECRET']:
            with self.subTest(path=path):
                saved = self.parameters.pop(path)
                with self.assertRaisesRegex(RuntimeError, 'Incomplete .* missing SSM parameter: ' + path.rsplit('/', 1)[1]):
                    release.secret_references(self.ssm)
                self.parameters[path] = saved
        keycloak = {path: self.parameters.pop(path) for path in list(self.parameters)
                    if path.startswith('/config/forms-processor-v6/keycloak-m2m/')}
        refs = {r['name'] for r in release.secret_references(self.ssm)}
        self.assertFalse(any(name.startswith('KEYCLOAK_') for name in refs))
        self.assertTrue({'AUTH0_CLIENT_ID', 'AUTH0_URL', 'USE_KEYCLOAK'} <= refs)
        for name in ['AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET']:
            del self.parameters['/config/forms-api-v6/appvar/' + name]
        for name in ['AUTH0_URL', 'AUTH0_AUDIENCE']:
            self.parameters.pop('/config/forms-api-v6/appvar/' + name, None)
            del self.parameters['/config/common/global-appvar/' + name]
        with self.assertRaisesRegex(RuntimeError, 'no complete Keycloak or Auth0'):
            release.secret_references(self.ssm)
        self.parameters.update(keycloak)
        refs = {r['name'] for r in release.secret_references(self.ssm)}
        self.assertFalse(any(name.startswith('AUTH0_') for name in refs))
        self.parameters['/config/forms-processor-v6/appvar/USE_KEYCLOAK'] = {
            'Name': '/config/forms-processor-v6/appvar/USE_KEYCLOAK', 'Type': 'String'}
        refs = {r['name']: r['valueFrom'] for r in release.secret_references(self.ssm)}
        self.assertEqual(refs['USE_KEYCLOAK'], '/config/common/global-appvar/USE_KEYCLOAK')

    def test_required_parameter_missing_fails(self):
        """A missing required database reference raises instead of publishing a broken task."""
        del self.parameters['/config/forms-api-v6/appvar/DATABASE_URL']
        with self.assertRaisesRegex(RuntimeError, 'Missing required'):
            release.secret_references(self.ssm)

    def test_sales_parameters_must_remain_secure_strings(self):
        """Wrong types for each required Bus or optional sales value raise without exposing its value."""
        for name in ['BUSAPI_URL', 'LETS_TALK_RECIPIENTS', 'LETS_TALK_SENDGRID_TEMPLATE_ID']:
            parameter = self.parameters['/config/forms-processor-v6/appvar/' + name]
            with self.subTest(name=name):
                parameter['Type'] = 'String'
                with self.assertRaisesRegex(RuntimeError, 'SecureString') as raised:
                    release.secret_references(self.ssm)
                self.assertNotIn('unused-ciphertext', str(raised.exception))
                parameter['Type'] = 'SecureString'

    def test_ssm_failures_stop_before_deployment(self):
        """Access denial and exhausted throttling propagate before any ECR, Docker or ECS mutation."""
        for code in ['AccessDeniedException', 'ThrottlingException']:
            with self.subTest(code=code):
                session, ecs, ecr = Mock(), Mock(), Mock()
                sts = Mock()
                sts.get_caller_identity.return_value = {'Account': release.ACCOUNTS['production']}
                session.client.side_effect = lambda name, **kwargs: {
                    'sts': sts, 'ecs': ecs, 'ecr': ecr, 'ssm': self.ssm}[name]
                ecs.describe_services.return_value = {'services': [{
                    'status': 'ACTIVE', 'taskDefinition': 'current',
                    'deployments': [{'rolloutState': 'COMPLETED'}]}]}
                ecs.describe_task_definition.return_value = {'taskDefinition': {'family': release.APP}}
                self.ssm.get_parameters.side_effect = ClientError({'Error': {
                    'Code': code, 'Message': 'Parameter read failed'}}, 'GetParameters')
                with patch.object(release.boto3, 'Session', return_value=session), \
                        patch.object(release.sys, 'argv', ['release.py', 'production', 'candidate']), \
                        patch.object(release.subprocess, 'run') as run:
                    with self.assertRaises(ClientError):
                        release.main()
                session.client.assert_any_call('ssm', config=release.SSM_CLIENT_CONFIG)
                ecr.describe_repositories.assert_not_called()
                ecs.register_task_definition.assert_not_called()
                ecs.update_service.assert_not_called()
                run.assert_not_called()

    def test_sdk_retries_throttling_and_has_a_finite_budget(self):
        """Exercise real SDK retry handling offline: recover after five throttles and stop after ten attempts."""
        for throttle_count, expected_requests in [(5, 8), (100, 10)]:
            with self.subTest(throttle_count=throttle_count):
                ssm = boto3.client('ssm', region_name='us-east-1', aws_access_key_id='test',
                                   aws_secret_access_key='test', config=release.SSM_CLIENT_CONFIG)
                requests = []

                def respond(request):
                    """Return an AWSResponse for a prepared HTTP request; fake throttles precede fixture reads."""
                    requests.append(json.loads(request.body))
                    self.assertEqual(request.headers['X-Amz-Target'], b'AmazonSSM.GetParameters')
                    throttled = len(requests) <= throttle_count
                    body = {'__type': 'ThrottlingException', 'message': 'Rate exceeded'} if throttled \
                        else self.parameter_response(**requests[-1])
                    raw = SimpleNamespace(stream=lambda: iter([json.dumps(body).encode()]))
                    return AWSResponse(request.url, 400 if throttled else 200,
                                       {'content-type': 'application/x-amz-json-1.1'}, raw)

                with patch.object(ssm._endpoint.http_session, 'send', side_effect=respond), \
                        patch('botocore.endpoint.time.sleep'):
                    if throttle_count == 5:
                        self.assertEqual(len(release.secret_references(ssm)), 18)
                    else:
                        with self.assertRaises(ClientError):
                            release.secret_references(ssm)
                self.assertEqual(len(requests), expected_requests)
                self.assertTrue(all(not request['WithDecryption'] for request in requests))
                ssm.close()

    def test_clone_preserves_roles_resources_and_removes_stale_literals(self):
        """Cloning returns a registerable copy with exact secret overrides and unchanged sidecars/roles."""
        ecs = boto3.client('ecs', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
        current = {'family': release.APP, 'taskDefinitionArn': 'old', 'revision': 7,
                   'executionRoleArn': 'execution', 'taskRoleArn': 'task', 'cpu': '256', 'memory': '512',
                   'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'],
                   'containerDefinitions': [{'name': release.APP, 'image': 'old', 'readonlyRootFilesystem': True,
                       'environment': [{'name': 'BUSAPI_URL', 'value': 'old'}, {'name': 'KAFKA_SSL_ENABLED', 'value': 'true'},
                                       {'name': 'USE_KEYCLOAK', 'value': 'true'}, {'name': 'AUTH0_URL', 'value': 'old'}],
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
