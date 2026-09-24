"""Regression coverage for manual withdrawal and offline failure identity."""
import datetime as dt
import io
import json
import tempfile
import unittest
from pathlib import Path

from tools.classify_repositories import classify_repositories, GitHubModelsClassificationClient, ClassificationModelUnavailable, load_taxonomy
from tools.localize_repositories import localize_repositories, GitHubModelsClient, ModelUnavailable
from tools.enrichment_state import failure_state

TAXONOMY = Path('data/classification-taxonomy.zh-CN.json')
NOW = dt.datetime(2026, 9, 20, tzinfo=dt.timezone.utc)


class Client:
    def __init__(self, fail_ids=()):
        self.fail_ids = set(fail_ids)
        self.calls = []

    def translate(self, rows):
        self.calls.extend(row['repository_id'] for row in rows)
        return [{'repository_id': row['repository_id'],
                 'display_name_zh': 'invalid' if row['repository_id'] in self.fail_ids else '开发工具',
                 'description_zh': None} for row in rows]

    def classify(self, rows):
        self.calls.extend(row['repository_id'] for row in rows)
        return [{'repository_id': row['repository_id'],
                 'primary_category': 'invalid' if row['repository_id'] in self.fail_ids else 'developer-tools',
                 'project_type': 'cli-developer-tool', 'use_cases': ['ai-coding']} for row in rows]


class EnrichmentRecoveryTests(unittest.TestCase):
    def test_malformed_provider_envelopes_fail_through_bounded_fallback(self):
        rows = [{'repository_id': 1, 'full_name': 'owner/repo', 'description': None, 'language': 'Python'}]
        for body in [None, [], {'choices': None}, {'choices': [{'finish_reason': 'stop', 'message': None}]},
                     {'choices': [{'finish_reason': 'stop', 'message': {'content': '[]'}}]}]:
            for kind in ['localization', 'classification']:
                with self.subTest(body=body, kind=kind):
                    calls = []
                    def opener(*args, **kwargs):
                        calls.append(1)
                        return io.BytesIO(json.dumps(body).encode())
                    if kind == 'localization':
                        client = GitHubModelsClient('fixture', endpoint='https://example.com/v1/chat/completions', opener=opener, sleeper=lambda _: None)
                        with self.assertRaises(ModelUnavailable):
                            client.translate(rows)
                    else:
                        client = GitHubModelsClassificationClient('fixture', load_taxonomy(TAXONOMY), endpoint='https://example.com/v1/chat/completions', opener=opener, sleeper=lambda _: None)
                        with self.assertRaises(ClassificationModelUnavailable):
                            client.classify(rows)
                    self.assertEqual(len(calls), 2)

    def test_withdraw_manual_cache_then_regenerate_and_reconcile_failures(self):
        for kind in ['localization', 'classification']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                daily = root / 'public/daily/2026-09-19.json'
                daily.parent.mkdir(parents=True)
                rows = [{'repository_id': i, 'full_name': f'owner/repo-{i}', 'description': None, 'language': 'Python'} for i in [1, 2]]
                daily.write_text(json.dumps({'date': '2026-09-19', 'entries': rows}))
                override = root / 'overrides.json'

                def run(client=None, **kwargs):
                    args = dict(overrides_file=override if override.exists() else None, client=client, now=NOW, **kwargs)
                    if kind == 'localization':
                        catalog = localize_repositories(root, **args)
                        return catalog, catalog
                    return classify_repositories(root, taxonomy_file=TAXONOMY, **args)

                first, _ = run(Client([1]))
                self.assertEqual(first['failed_repository_ids'], [1])
                self.assertEqual(run()[0], first)
                manual = {'repository_id': 1}
                if kind == 'localization':
                    manual.update(display_name_zh='人工开发工具', description_zh=None)
                else:
                    manual.update(primary_category='developer-tools', project_type='cli-developer-tool', use_cases=['ai-coding'])
                payload = {'schema_version': '1.0.0', 'locale': 'zh-CN', 'repositories': [manual]}
                if kind == 'classification':
                    payload.pop('locale')
                    payload['taxonomy_version'] = '1.0.0'
                override.write_text(json.dumps(payload))
                fixed, catalog = run()
                self.assertEqual(fixed['coverage']['pending_count'], 0)
                self.assertEqual(fixed['coverage']['failed_count'], 0)
                self.assertEqual(fixed['failed_repository_ids'], [])
                self.assertEqual(catalog['repositories'][0]['provenance'], 'manual')

                # Retire an override: the offline build must not retain its output.
                payload['repositories'] = []
                override.write_text(json.dumps(payload))
                pending, catalog = run()
                self.assertEqual(pending['coverage']['pending_count'], 1)
                self.assertEqual([row['repository_id'] for row in catalog['repositories']], [2])
                client = Client()
                _, regenerated = run(client)
                self.assertEqual(client.calls, [1])
                self.assertEqual(regenerated['repositories'][0]['provenance'], 'github_models')

    def test_failures_removed_with_source_and_preserved_if_not_attempted(self):
        prior = {'coverage': {'failed_count': 2}, 'failed_repository_ids': [1, 2]}
        self.assertEqual(failure_state(prior, {2, 3}, set(), set()), (1, {'failed_repository_ids': [2]}))
        self.assertEqual(failure_state(prior, {2, 3}, {3}, {3}), (2, {'failed_repository_ids': [2, 3]}))
        legacy = {'coverage': {'failed_count': 7}}
        self.assertEqual(failure_state(legacy, {2}, set(), set()), (1, {}))
        self.assertEqual(failure_state(legacy, set(), set(), set()), (0, {'failed_repository_ids': []}))
        self.assertEqual(failure_state(legacy, {2}, {2}, {2}), (1, {'failed_repository_ids': [2]}))
        partial_legacy = {'coverage': {'failed_count': 1}}
        count, metadata = failure_state(partial_legacy, {1, 2}, {1}, {1})
        self.assertEqual((count, metadata), (1, {'failed_repository_ids': [1]}))
        self.assertEqual(failure_state({'coverage': {'failed_count': count}, **metadata}, {1, 2}, {1}, {1}), (1, metadata))
