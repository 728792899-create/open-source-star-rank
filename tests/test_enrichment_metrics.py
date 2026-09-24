import datetime as dt
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from tools.enrichment_metrics import UsageMeter, validate_history, validate_record, write_run
from tools.model_transport import request_entries
from tools.localize_repositories import GitHubModelsClient, localize_repositories, build_prompt
from tools.classify_repositories import classify_repositories
from tests.test_localize_repositories import PartialRetryClient, source, ranking, write_json
from tests.test_classify_repositories import PartialRetryClient as ClassificationRetryClient

ENDPOINT='https://api.deepseek.com/chat/completions'
AT='2026-09-24T05:00:00Z'
PAYLOAD={'response_format':{'type':'json_schema','json_schema':{'schema':{'type':'object'}}},'messages':[{'role':'system','content':'test'}]}

def raw(content='{"repositories": []}', usage=True):
    result={'choices':[{'finish_reason':'stop','message':{'content':content}}]}
    if usage:
        result['usage']={'prompt_tokens':100, 'completion_tokens':20, 'prompt_cache_hit_tokens':40,'prompt_cache_miss_tokens':60}
    return json.dumps(result).encode()

class MetricsTests(unittest.TestCase):
    def test_usage_in_rejected_content_is_counted(self):
        meter=UsageMeter(); responses=iter([raw('invalid'),raw()])
        request_entries(ENDPOINT,'secret',PAYLOAD,opener=lambda *a,**k:io.BytesIO(next(responses)),sleeper=lambda _:None,meter=meter)
        result=meter.summary(ENDPOINT,'deepseek-flash',AT)
        self.assertEqual((result['requests'],result['usage_responses']), (2,2))
        self.assertEqual(result['observed_tokens']['prompt_tokens'],200)
        self.assertEqual(result['request_errors'],{'invalid_response':1})
        self.assertEqual(result['estimated_cost'],{'currency':'USD','min':'0.00004224','max':'0.00008448'})

    def test_http_failure_counts_but_cost_is_unknown(self):
        meter=UsageMeter(); calls=[]
        def opener(*a,**k):
            calls.append(1)
            if len(calls)==1:raise urllib.error.HTTPError(ENDPOINT,500,'secret',{},io.BytesIO(b'secret'))
            return io.BytesIO(raw())
        request_entries(ENDPOINT,'secret',PAYLOAD,opener=opener,sleeper=lambda _:None,meter=meter)
        result=meter.summary(ENDPOINT,'deepseek-flash',AT)
        self.assertEqual(result['requests'],2);self.assertEqual(result['unknown_usage_requests'],1)
        self.assertIsNone(result['estimated_cost']);self.assertNotIn('secret',json.dumps(result))
        self.assertEqual(result['request_errors'],{'http_500':1})

    def test_unusable_usage_and_tariffs_do_not_invent_cost(self):
        for usage in [None,{}, {'prompt_tokens':True,'completion_tokens':20}, {'prompt_tokens':-1,'completion_tokens':20}]:
            meter=UsageMeter();meter.requests=1;meter.observe(json.dumps({'usage':usage}))
            result=meter.summary(ENDPOINT,'deepseek-flash',AT)
            self.assertEqual(result['unknown_usage_requests'],1);self.assertIsNone(result['estimated_cost'])
        for date,model in [('2026-11-01T00:00:00Z','deepseek-flash'),(AT,'other-model')]:
            meter=UsageMeter();meter.requests=1;meter.observe(raw())
            self.assertIsNone(meter.summary(ENDPOINT,model,date)['estimated_cost'])
        meter=UsageMeter();meter.requests=1;meter.observe(json.dumps({'usage':{'prompt_tokens':100,'completion_tokens':20,'prompt_cache_hit_tokens':0,'prompt_cache_miss_tokens':1}}))
        self.assertTrue(meter.summary(ENDPOINT,'deepseek-flash',AT)['usage_complete'])
        self.assertIsNone(meter.summary(ENDPOINT,'deepseek-flash',AT)['estimated_cost'])

    def test_feedback_is_only_for_failed_rows_and_is_user_data(self):
        for kind in ['localization','classification']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                root=Path(folder);write_json(root/'public/daily/2026-09-24.json',ranking('2026-09-24',[source(1),source(2)]))
                client=PartialRetryClient(2) if kind=='localization' else ClassificationRetryClient(2)
                if kind=='localization':localize_repositories(root,client=client)
                else:classify_repositories(root,client=client,taxonomy_file=Path('data/classification-taxonomy.zh-CN.json'))
                self.assertEqual([[v['repository_id'] for v in batch] for batch in client.calls],[[1,2],[2]])
                self.assertNotIn('correction_feedback',client.calls[0][1])
                feedback=client.calls[1][0]['correction_feedback']
                self.assertTrue(feedback['validation_error']);self.assertEqual(feedback['previous_output']['repository_id'],2)
                row=dict(client.calls[1][0],correction_feedback={'validation_error':'INJECTED_DATA'})
                system,user=build_prompt([row]);self.assertNotIn('INJECTED_DATA',system);self.assertIn('INJECTED_DATA',user)

    def test_online_receipts_survive_offline_and_public_only_without_duplicates(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);write_json(root/'public/daily/2026-09-24.json',ranking('2026-09-24',[source(1)]))
            row={'repository_id':1,'display_name_zh':'Project｜开发者 API 项目 1','description_zh':'面向开发者的 API 项目 1。'}
            client=GitHubModelsClient('secret',model='deepseek-flash',endpoint=ENDPOINT,opener=lambda *a,**k:io.BytesIO(raw(json.dumps({'repositories':[row]}))))
            params={'model':'deepseek-flash','client':client,'now':dt.datetime.fromisoformat(AT)}
            localize_repositories(root,**params)
            directory=root/'public/enrichment-runs';before={p.name:p.read_bytes() for p in directory.rglob('*.json')}
            receipt=json.loads((directory/'latest.json').read_text())['runs']['localization']
            self.assertEqual((receipt['requests'],receipt['accepted_projects']),(1,1))
            localize_repositories(root);localize_repositories(root,write_state=False,**params)
            self.assertEqual(before,{p.name:p.read_bytes() for p in directory.rglob('*.json')})
            localize_repositories(root,**params)
            after=json.loads((directory/'latest.json').read_text())['runs']['localization']
            self.assertEqual((after['requests'],after['attempted_projects']),(0,0))
            self.assertEqual(len(list((directory/'history').glob('*.json'))),2)
            validate_history(root/'public')
            after['raw_response']='secret'
            with self.assertRaises(Exception):validate_record(after)
