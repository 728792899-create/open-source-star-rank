"""Regression tests for the September 2026 audit, using real JSON contracts."""
import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.test_star_rank import FakeClient, api_repo
from tests.test_event_live_rank import FakeGitHub, repository
from tools import star_rank as s
from tools.event_live_rank import load_metadata_cache, enrich_live_aggregates
from tools.event_star_rank import build_category_pool, rebuild_dependent_pools
from tools.localize_repositories import discover_ranked_repositories
from tools.migrate_star_rank_top500 import apply_manifest, build_manifest
from tools.validate_star_rank_data import validate_data_tree
from tools.star_rank_schema import validate_payload

UTC = dt.timezone.utc


def capture(day):
    return dt.datetime(2026, 9, day, 16, 20, tzinfo=UTC)


class NoSearchClient(FakeClient):
    def search_repositories(self, query, *, sort, pages):
        self.request_count += 1
        return []


class PagedClient(FakeClient):
    def search_repositories(self, query, *, sort, pages):
        return super().search_repositories(query, sort=sort, pages=pages)[:pages * 100]


class AuditRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.seeds = self.root / 'seeds.json'
        s.atomic_write_json(self.seeds, [])

    def update(self, day, *, repos=None, **kwargs):
        repos = repos or [api_repo(i, f'demo/r{i}', 100 + day) for i in range(1, 7)]
        return s.run_update(FakeClient(repos), data_dir=self.root,
                            projects_file=self.seeds, captured_at=capture(day), **kwargs)

    def test_historical_language_stays_indexed_with_zero_current_candidates(self):
        for day in (15, 16, 17):
            self.update(day, repos=[{**api_repo(i, f'demo/r{i}', 100 + day),
                                    'language': 'Rust' if day == 17 else 'Python'} for i in range(1, 7)])
            validate_data_tree(self.root)
        languages = s.load_json(self.root / 'public/language/index.json')['languages']
        python = next(item for item in languages if item['language'] == 'Python')
        self.assertEqual(python['candidate_count'], 0)
        self.assertTrue(python['available_dates'])

    def test_private_search_seed_and_tracked_repositories_are_excluded(self):
        private = {**api_repo(7, 'demo/private', 999), 'private': True, 'visibility': 'private'}
        self.update(15, repos=[api_repo(i, f'demo/r{i}', 100) for i in range(1, 7)] + [private])
        self.assertNotIn('7', s.load_json(self.root / 'snapshots/2026-09-16.json')['repositories'])
        # Previously public repositories are looked up again; a seed cannot bypass visibility.
        s.atomic_write_json(self.seeds, [{'repository': 'demo/private-seed'}])
        records = [{**api_repo(1, 'demo/r1', 120), 'private': True}, api_repo(2, 'demo/r2', 120),
                   {**api_repo(8, 'demo/private-seed', 200), 'private': True}]
        original_get = NoSearchClient.get_repository
        calls = []
        class SeedClient(NoSearchClient):
            def get_repository(inner, name):
                calls.append(name)
                return original_get(inner, name)
        result = s.run_update(SeedClient(records), data_dir=self.root,
                              projects_file=self.seeds, captured_at=capture(16))
        self.assertNotIn('1', result['snapshot']['repositories'])
        self.assertIn('2', result['snapshot']['repositories'])
        self.assertNotIn('8', result['snapshot']['repositories'])
        self.assertEqual(calls, ['demo/private-seed'])

    def test_search_queries_require_public_visibility(self):
        class Client(FakeClient):
            def search_repositories(inner, query, **kwargs):
                self.assertIn('is:public', query)
                return super().search_repositories(query, **kwargs)
        s.discover_candidates(Client([api_repo(1, 'demo/r1', 100)]), observed_date=dt.date(2026, 9, 19), existing={})

    def test_same_day_replacement_refreshes_tracked_repositories(self):
        self.update(18, repos=[api_repo(1, 'demo/r1', 100)])
        result = s.run_update(NoSearchClient([api_repo(1, 'demo/r1', 200)]), data_dir=self.root,
                              projects_file=self.seeds, captured_at=capture(18) + dt.timedelta(hours=1),
                              replace_snapshot=True, replace_date=dt.date(2026, 9, 19))
        self.assertEqual(result['snapshot']['repositories']['1']['stars_total'], 200)

    def test_replacement_removes_only_obsolete_language_outputs(self):
        for day in (15, 16, 17):
            self.update(day)
        language_root = self.root / 'public/language' / s.language_slug('Python') / 'daily'
        self.assertTrue((language_root / '2026-09-17.json').exists())
        self.update(17, repos=[{**api_repo(i, f'demo/r{i}', 200), 'language': 'Rust'} for i in range(1, 7)],
                    replace_snapshot=True, replace_date=dt.date(2026, 9, 18))
        self.assertFalse((language_root / '2026-09-17.json').exists())
        self.assertTrue((language_root / '2026-09-16.json').exists())
        validate_data_tree(self.root)

    def test_retry_recovers_pending_batch_before_collecting_next_day(self):
        self.update(15)
        writer = s.atomic_write_json
        def fail(path, payload):
            if path == self.root / 'public/index.json':
                raise OSError('injected')
            writer(path, payload)
        with patch('tools.star_rank.atomic_write_json', side_effect=fail), self.assertRaises(OSError):
            self.update(16)
        self.update(17)
        self.assertTrue((self.root / 'public/daily/2026-09-16.json').exists())
        self.assertTrue((self.root / 'public/daily/2026-09-17.json').exists())
        validate_data_tree(self.root)

    def test_replacement_below_language_minimum_withdraws_that_day(self):
        for day in (15, 16):
            self.update(day)
        self.update(16, repos=[api_repo(i, f'demo/r{i}', 200) for i in range(1, 5)],
                    replace_snapshot=True, replace_date=dt.date(2026, 9, 17))
        self.assertFalse((self.root / 'public/language' / s.language_slug('Python') / 'daily/2026-09-16.json').exists())
        validate_data_tree(self.root)

    def test_invalid_replacement_withdraws_period_and_exploration_outputs(self):
        for day in range(1, 10):
            self.update(day)
        self.assertTrue((self.root / 'public/period/7d/2026-09-09.json').exists())
        s.run_update(FakeClient([api_repo(i, f'demo/r{i}', 200) for i in range(1, 7)]),
                     data_dir=self.root, projects_file=self.seeds, captured_at=capture(9) + dt.timedelta(hours=4),
                     replace_snapshot=True, replace_date=dt.date(2026, 9, 10))
        for relative in ('daily', 'period/7d', 'explore/daily', 'explore/period/7d'):
            self.assertFalse((self.root / 'public' / relative / '2026-09-09.json').exists())
        self.assertTrue((self.root / 'public/period/7d/2026-09-08.json').exists())
        validate_data_tree(self.root)

    def test_recovery_finishes_an_interrupted_obsolete_file_removal(self):
        for day in (15, 16):
            self.update(day)
        obsolete = self.root / 'public/language' / s.language_slug('Python') / 'daily/2026-09-16.json'
        unlink = Path.unlink
        def fail(path, *args, **kwargs):
            if path == obsolete:
                raise OSError('injected removal failure')
            return unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', fail), self.assertRaises(OSError):
            self.update(16, repos=[{**api_repo(i, f'demo/r{i}', 200), 'language': 'Rust'} for i in range(1, 7)],
                        replace_snapshot=True, replace_date=dt.date(2026, 9, 17))
        self.update(16)
        self.assertFalse(obsolete.exists())
        validate_data_tree(self.root)

    def test_retry_replays_entire_sample_after_each_publication_failure(self):
        for relative in ('state/candidates.json', 'snapshots/2026-09-18.json',
                         'public/daily/2026-09-17.json', 'public/language/index.json', 'public/index.json'):
            with self.subTest(path=relative), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                for day in (15, 16):
                    s.run_update(FakeClient([api_repo(i, f'demo/r{i}', 100 + day) for i in range(1, 7)]),
                                 data_dir=root, projects_file=self.seeds, captured_at=capture(day))
                writer = s.atomic_write_json
                def fail(path, payload):
                    if path == root / relative:
                        raise OSError('injected disk failure')
                    writer(path, payload)
                with patch('tools.star_rank.atomic_write_json', side_effect=fail), self.assertRaises(OSError):
                    s.run_update(FakeClient([api_repo(i, f'demo/r{i}', 117) for i in range(1, 7)]),
                                 data_dir=root, projects_file=self.seeds, captured_at=capture(17))
                result = s.run_update(FakeClient([]), data_dir=root, projects_file=self.seeds,
                                      captured_at=capture(17) + dt.timedelta(minutes=20))
                self.assertEqual(result['status'], 'reused')
                self.assertEqual(result['index']['latest_date'], '2026-09-17')
                self.assertFalse((root / 'state/pending-update.json').exists())
                validate_data_tree(root)

    def test_new_alltime_metadata_supersedes_old_daily(self):
        for path, payload in (
            ('daily/2026-01-01.json', {'date': '2026-01-01', 'entries': [dict(repository_id=1, full_name='demo/old')]}),
            ('alltime/top-1000.json', {'generated_at': '2026-09-19T00:00:00Z', 'entries': [dict(repository_id=1, full_name='demo/new')]}),
        ):
            s.atomic_write_json(self.root / path, payload)
        self.assertEqual(discover_ranked_repositories(self.root)[1]['full_name'], 'demo/new')

    def test_top500_migration_is_noop_for_current_contract(self):
        for day in (15, 16):
            s.run_update(PagedClient([api_repo(i, f'demo/r{i}', 100 + day) for i in range(1, 502)]),
                         data_dir=self.root, projects_file=self.seeds, captured_at=capture(day))
        before = {path: path.read_bytes() for path in (self.root / 'public').rglob('*.json')}
        apply_manifest(self.root, build_manifest(self.root), recomputed_at='2026-09-19T00:00:00Z')
        self.assertEqual(before, {path: path.read_bytes() for path in before})
        validate_data_tree(self.root)

    def test_live_cache_expires_and_does_not_reuse_live_publication_time(self):
        now = capture(18)
        entry = dict(repository_id=1, full_name='demo/recent', created_at='2026-01-01T00:00:00Z',
                     pushed_at=None, stars_total=100, html_url='https://github.com/demo/recent')
        s.atomic_write_json(self.root / 'events/live.json', {'generated_at': s.isoformat(now),
                                                            'entries': [{**entry, 'full_name': 'demo/old'}]})
        s.atomic_write_json(self.root / 'events/daily/2026-09-18.json',
                            {'generated_at': s.isoformat(now - dt.timedelta(minutes=10)), 'entries': [entry]})
        self.assertEqual(load_metadata_cache(self.root, now=now)[1]['full_name'], 'demo/recent')
        self.assertEqual(load_metadata_cache(self.root, now=now + dt.timedelta(hours=1)), {})
        github = FakeGitHub({1: repository(1)})
        entries, metrics = enrich_live_aggregates(github, [dict(repository_id=1, stars_added=5, watch_events=5)],
            metadata_cache=load_metadata_cache(self.root, now=now + dt.timedelta(hours=1)))
        self.assertEqual(metrics['metadata_cached_count'], 0)
        self.assertEqual(entries[0]['full_name'], 'fixture/repo-1')

    def test_backfill_rebuilds_category_trend(self):
        day = dt.date(2026, 9, 18)
        entry = dict(repository_id=1, full_name='demo/r1', stars_total=100, stars_added=10,
                     watch_events=10, html_url='https://github.com/demo/r1')
        pool = build_category_pool(date=day, generated_at=capture(18), enriched=[entry])
        s.atomic_write_json(self.root / 'public/events/category/2026-09-18.json', pool)
        state = dict(entries=[dict(repository_id=1, stars_added=42, watch_events=42)])
        rebuilt = rebuild_dependent_pools(self.root / 'public', self.root / 'state/events/daily',
                                          date=day - dt.timedelta(days=1), raw_state=state)
        self.assertEqual(rebuilt[day]['entries'][0]['trend_7d'][-2], 42)
        validate_payload('event_category_pool', rebuilt[day])

    @patch('socket.socket.connect', side_effect=AssertionError('Schema validation must stay local'))
    def test_backfill_without_extension_uses_new_verified_members(self, _network):
        from tests.test_event_star_rank import FakeRunner, FakeGitHub, aggregate, repository
        from tools.event_star_rank import run_event_update
        date = dt.date(2026, 9, 18)
        rows = [aggregate(i, 1000 - i) for i in range(1, 602)]
        metadata = {i: repository(i) for i in range(1, 602)}
        run_event_update(FakeRunner(rows), FakeGitHub(metadata), data_dir=self.root,
                         date=date, generated_at=capture(18), category_pool_limit=600)
        # A new leader enters and a formerly public repository becomes private.
        rows[-1] = aggregate(601, 2000)
        rows.sort(key=lambda item: -item['stars_added'])
        metadata[1]['private'] = True
        run_event_update(FakeRunner(rows), FakeGitHub(metadata), data_dir=self.root,
                         date=date, generated_at=capture(18), category_pool_limit=0, replace_day=True)
        pool = s.load_json(self.root / 'public/events/category/2026-09-18.json')
        self.assertEqual(pool['entries'][0]['repository_id'], 601)
        self.assertNotIn(1, [item['repository_id'] for item in pool['entries']])
        validate_payload('event_category_pool', pool)
