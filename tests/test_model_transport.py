import io
import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from tools.model_transport import (ModelResponseError, NoRedirect, parse_response,
                                   request_entries, runtime_config, validate_endpoint, provider_payload)
from tools.localize_repositories import GitHubModelsClient, localize_repositories
from tools.classify_repositories import GitHubModelsClassificationClient, classify_repositories
from tests.test_localize_repositories import source, write_json, ranking

ENDPOINT = 'https://example.com/v1/chat/completions'


def response(content=None, finish='stop', **message):
    return json.dumps({'choices': [{'finish_reason': finish, 'message': {
        'content': json.dumps({'repositories': []}) if content is None else content, **message}}]}).encode()


class ModelTransportTests(unittest.TestCase):
    def test_retired_and_unsafe_endpoints_fail_before_request(self):
        for endpoint in ['', 'https://models.github.ai/inference/chat/completions',
                         'http://example.com/v1/chat/completions',
                         'https://key@example.com/v1/chat/completions',
                         ENDPOINT+'?key=secret', ENDPOINT+'#fragment']:
            with self.subTest(endpoint=endpoint), self.assertRaises(ModelResponseError):
                request_entries(endpoint, 'secret', {}, opener=lambda *a, **k: self.fail('network call'))
        self.assertEqual(validate_endpoint(ENDPOINT), ENDPOINT)

    def test_outer_response_and_model_content_are_distinguished(self):
        with self.assertRaisesRegex(ModelResponseError, '非 JSON 响应'):
            parse_response(b'OK\r\n')
        with self.assertRaisesRegex(ModelResponseError, '完整 JSON'):
            parse_response(response('```json\n{"repositories": []}\n```'))
        self.assertEqual(parse_response(response()), [])

    def test_incomplete_refused_and_malformed_results_rejected(self):
        invalid = [b'{}', b'[]', b'{"choices":[null]}', response(finish='length'),
                   response(finish='content_filter'), response(finish=None),
                   response(refusal='no'), response(''), response([]), response('{'),
                   response('[]'), response('{"repositories": [1]}')]
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(ModelResponseError):
                parse_response(raw)

    def test_bounded_retry_recovers_and_never_logs_body(self):
        calls=[]; waits=[]
        def opener(req, **kw):
            calls.append(req)
            self.assertNotIn('X-github-api-version', req.headers)
            self.assertEqual(req.headers['Authorization'], 'Bearer dedicated')
            return io.BytesIO(b'OK\r\n' if len(calls)==1 else response())
        self.assertEqual(request_entries(ENDPOINT,'dedicated',{},opener=opener,sleeper=waits.append),[])
        self.assertEqual((len(calls),waits),(2,[1.0]))
        calls.clear()
        def failed(req, **kw):
            calls.append(req)
            raise urllib.error.HTTPError(ENDPOINT,403,'secret',{},io.BytesIO(b'secret prompt'))
        with self.assertRaisesRegex(ModelResponseError,'HTTP 403') as caught:
            request_entries(ENDPOINT,'dedicated',{},opener=failed,sleeper=waits.append)
        self.assertEqual(len(calls),1)
        self.assertNotIn('secret',str(caught.exception))

    def test_redirect_is_not_followed(self):
        request=urllib.request.Request(ENDPOINT,headers={'Authorization':'Bearer dedicated'})
        self.assertIsNone(NoRedirect().redirect_request(request,None,302,'Found',{},'https://other.example/'))
        calls=[]
        def redirect(req, **kw):
            calls.append(req)
            raise urllib.error.HTTPError(ENDPOINT,302,'Found',{'Location':'https://other.example/'},io.BytesIO())
        with patch('tools.model_transport.urllib.request.build_opener') as builder:
            builder.return_value.open.side_effect=redirect
            with self.assertRaisesRegex(ModelResponseError,'HTTP 302'):
                request_entries(ENDPOINT,'dedicated',{})
            self.assertIsInstance(builder.call_args.args[0],NoRedirect)
        self.assertEqual(len(calls),1)

    def test_deepseek_uses_json_mode_and_local_schema_validation(self):
        tax=json.loads(Path('data/classification-taxonomy.zh-CN.json').read_text())
        captured=[]
        def invalid(req, **kw):
            body=json.loads(req.data); captured.append(body)
            self.assertEqual(body['response_format'], {'type':'json_object'})
            self.assertEqual(body['thinking'], {'type':'disabled'})
            self.assertIn('JSON Schema',body['messages'][0]['content'])
            self.assertIn('primary_category',body['messages'][0]['content'])
            row={'repository_id':1,'primary_category':'developer-tools','project_type':'cli-developer-tool','use_cases':[{}]}
            return io.BytesIO(response(json.dumps({'repositories':[row]})))
        from tools.classify_repositories import ClassificationModelUnavailable
        client=GitHubModelsClassificationClient('dedicated',tax,endpoint='https://api.deepseek.com/chat/completions',opener=invalid,sleeper=lambda _:None)
        with self.assertRaisesRegex(ClassificationModelUnavailable,'Schema'):
            client.classify([source(1)])
        self.assertEqual(len(captured),2)
        payload={'response_format':{'type':'json_schema','json_schema':{'schema':{'type':'object'}}},'messages':[{'role':'system','content':'prompt'}]}
        original=json.dumps(payload)
        self.assertEqual(provider_payload(ENDPOINT,payload),payload)
        provider_payload('https://api.deepseek.com/chat/completions',payload)
        self.assertEqual(json.dumps(payload),original)

    def test_schema_rejects_missing_required_field_even_when_nullable(self):
        from tools.localize_repositories import ModelUnavailable
        row={'repository_id':1,'display_name_zh':'开发工具'}
        client=GitHubModelsClient('dedicated',endpoint='https://api.deepseek.com/chat/completions',opener=lambda *a,**k:io.BytesIO(response(json.dumps({'repositories':[row]}))),sleeper=lambda _:None)
        with self.assertRaisesRegex(ModelUnavailable,'Schema'):
            client.translate([dict(source(1),description=None)])

    def test_runtime_never_uses_github_token_or_offline_credentials(self):
        with patch.dict(os.environ,{'GITHUB_TOKEN':'repo-secret'},clear=True):
            self.assertEqual(runtime_config(False,'model'),(None,None))
        with patch.dict(os.environ,{'ENRICHMENT_API_URL':ENDPOINT,'ENRICHMENT_API_KEY':'dedicated'},clear=True):
            self.assertEqual(runtime_config(True,'model'),(None,None))
            self.assertEqual(runtime_config(False,None),(None,None))
            self.assertEqual(runtime_config(False,'model'),('dedicated',ENDPOINT))

    def test_new_provider_results_and_offline_metadata_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            write_json(root/'public/daily/2026-09-24.json',ranking('2026-09-24',[source(1)]))
            localized={'repository_id':1,'display_name_zh':'Project｜开发者 API 项目 1','description_zh':'面向开发者的 API 项目 1。'}
            classified={'repository_id':1,'primary_category':'developer-tools','project_type':'cli-developer-tool','use_cases':['ai-coding']}
            def opener_for(row):
                return lambda *a,**k: io.BytesIO(response(json.dumps({'repositories':[row]})))
            taxonomy=Path('data/classification-taxonomy.zh-CN.json')
            tax=json.loads(taxonomy.read_text())
            localization=localize_repositories(root,model='confirmed-model',client=GitHubModelsClient('dedicated',endpoint=ENDPOINT,opener=opener_for(localized)))
            index,catalog=classify_repositories(root,taxonomy_file=taxonomy,model='confirmed-model',client=GitHubModelsClassificationClient('dedicated',tax,endpoint=ENDPOINT,opener=opener_for(classified)))
            self.assertEqual(localization['repositories'][0]['provenance'],'model_api')
            self.assertEqual(catalog['repositories'][0]['provenance'],'model_api')
            self.assertEqual(localize_repositories(root),localization)
            self.assertEqual(classify_repositories(root,taxonomy_file=taxonomy),(index,catalog))
