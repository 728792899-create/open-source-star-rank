import io
import json
import unittest
import urllib.error
from unittest.mock import patch
from tools.api_budget import BudgetPolicy
from tools.star_rank import GitHubClient, RateLimitError

class BudgetTests(unittest.TestCase):
    def test_excess_wait_and_deadline_refuse_without_sleep(self):
        with patch('tools.api_budget.time.sleep') as sleep:
            with self.assertRaises(ValueError):BudgetPolicy(max_wait=90).wait(91)
            with patch('tools.api_budget.time.time',return_value=100):
                with self.assertRaises(ValueError):BudgetPolicy(deadline=110).wait(11)
            sleep.assert_not_called()
    def test_retry_after_is_obeyed_and_total_wait_bounded(self):
        client=GitHubClient('test')
        failure=urllib.error.HTTPError('https://api.github.com/test',429,'throttled',{'Retry-After':'2'},None)
        response=io.BytesIO(b'{"ok":true}')
        with patch('tools.star_rank.urllib.request.urlopen',side_effect=[failure,response]),patch('tools.api_budget.time.sleep') as sleep:
            self.assertEqual(client._request_json('/test'),{'ok':True})
            sleep.assert_called_once_with(2.0)
            self.assertEqual(client.retry_count,1)
    def test_budget_rejects_unaffordable_batch_and_skips_when_disabled(self):
        client=GitHubClient('test',preflight=True)
        with patch.object(client,'_request_json',return_value={'resources':{'core':{'remaining':900,'limit':1000,'reset':0}}}):
            with self.assertRaises(RateLimitError):client.ensure_budget(1500)
        client.preflight=False
        with patch.object(client,'_request_json') as request:
            client.ensure_budget(1500);request.assert_not_called()
    def test_budget_waits_for_near_reset_then_rechecks(self):
        client=GitHubClient('test',preflight=True)
        resources=lambda remaining:{'resources':{'core':{'remaining':remaining,'limit':5000,'reset':102}}}
        with patch.object(client,'_request_json',side_effect=[resources(0),resources(5000)]),patch('tools.api_budget.time.time',return_value=100),patch('tools.api_budget.time.sleep') as sleep:
            client.ensure_budget(2000);sleep.assert_called_once_with(3.0)
