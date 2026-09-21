import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.test_star_rank import FakeClient, api_repo
from tools.observation_pool import select_observed, select_directory
from tools.star_rank import run_update, atomic_write_json, observation_records, build_snapshot, repository_record
from tools.validate_star_rank_data import validate_data_tree, SchemaValidationError

UTC = dt.timezone.utc

def record(i, day='2026-09-01'):
    return repository_record(api_repo(i, f'owner/repo-{i}', i), observed_date=day, source='search')


class ObservationPoolTests(unittest.TestCase):
    def test_long_running_lease_survives_rolling_history_and_same_day_replay(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); seeds = root / 'seeds.json'; atomic_write_json(seeds, [])
            now = dt.datetime(2026, 8, 1, 17, tzinfo=UTC)
            for offset in range(34):
                result = run_update(FakeClient([api_repo(1, 'owner/one', 100 + offset)]), data_dir=root, projects_file=seeds, captured_at=now + dt.timedelta(days=offset), max_candidates=1)
            record = result['directory']['observations'][0]
            self.assertEqual(record['started_on'], '2026-08-02')
            self.assertEqual(result['directory']['coverage']['comparable_30d_count'], 1)
            before = (root / 'public/directory.json').read_bytes()
            run_update(FakeClient([]), data_dir=root, projects_file=seeds, captured_at=now + dt.timedelta(days=33), max_candidates=1)
            self.assertEqual(before, (root / 'public/directory.json').read_bytes())
            validate_data_tree(root)

    def test_protected_pool_queues_even_new_pins_and_mature_pool_rotates_five_percent(self):
        old = [record(i) for i in range(1, 101)]
        new = [{**record(i), 'pinned': True} for i in range(101, 201)]
        ids = set(range(1, 101))
        self.assertEqual({item['repository_id'] for item in select_observed(new + old, previous_ids=ids, protected_ids=ids, capacity=100)}, ids)
        rotated = select_observed(new + old, previous_ids=ids, protected_ids=set(), capacity=100)
        self.assertEqual(len({item['repository_id'] for item in rotated} - ids), 5)
        replaced = select_observed(new + old, previous_ids=ids, protected_ids=set(), capacity=100, allow_admission=False)
        self.assertEqual({item['repository_id'] for item in replaced}, ids)
        with self.assertRaises(ValueError):
            select_observed(old, previous_ids=ids, protected_ids=ids, capacity=90)

    def test_directory_keeps_all_observed_and_bounds_waiting_without_fabricating_freshness(self):
        observed = [record(1)]
        older = record(2, '2026-08-01')
        recent = record(3)
        directory = select_directory([older, recent], observed, limit=2)
        self.assertEqual({item['repository_id'] for item in directory}, {1, 3})
        self.assertEqual(directory[0]['last_refreshed_date'], '2026-09-01')

    def test_continuity_requires_31_valid_samples_and_restarts_after_gap(self):
        candidates = [record(1)]
        start = dt.date(2026, 8, 1)
        history = {}
        for offset in range(31):
            day = start + dt.timedelta(days=offset)
            capture = dt.datetime.combine(day - dt.timedelta(days=1), dt.time(17), UTC)
            history[day] = build_snapshot(candidates, captured_at=capture)
        lease = observation_records(candidates, history, start + dt.timedelta(days=30))[0]
        self.assertEqual(lease['started_on'], '2026-08-01')
        self.assertEqual(lease['protected_until'], '2026-08-31')
        del history[start + dt.timedelta(days=29)]
        lease = observation_records(candidates, history, start + dt.timedelta(days=30))[0]
        self.assertEqual(lease['started_on'], '2026-08-31')
        history[start + dt.timedelta(days=30)]['capture_quality']['valid_for_ranking'] = False
        self.assertEqual(observation_records(candidates, history, start + dt.timedelta(days=30))[0]['last_valid_snapshot_on'], '2026-08-29')

    def test_collect_discovery_separately_and_replay_every_interrupted_write(self):
        with tempfile.TemporaryDirectory() as name:
            base = Path(name)
            seeds = base / 'seeds.json'; atomic_write_json(seeds, [])
            now = dt.datetime(2026, 9, 1, 17, tzinfo=UTC)
            root = base / 'data'
            run_update(FakeClient([api_repo(1, 'owner/one', 100)]), data_dir=root, projects_file=seeds, captured_at=now, max_candidates=1)
            import shutil
            for failure_at in range(1, 11):
                with self.subTest(write=failure_at):
                    dest = base / f'case-{failure_at}'; shutil.copytree(root, dest)
                    calls = 0
                    def fail(path, payload):
                        nonlocal calls
                        calls += 1
                        atomic_write_json(path, payload)
                        if calls == failure_at:
                            raise OSError('injected interruption')
                    client = FakeClient([api_repo(1, 'owner/one', 101), api_repo(2, 'owner/two', 900)])
                    kwargs = dict(data_dir=dest, projects_file=seeds, captured_at=now + dt.timedelta(days=1), max_candidates=1)
                    try:
                        with patch('tools.star_rank.atomic_write_json', side_effect=fail):
                            run_update(client, **kwargs)
                    except OSError:
                        pass
                    result = run_update(FakeClient([]), **kwargs)
                    directory = result['directory']
                    self.assertEqual(directory['repository_count'], 2)
                    self.assertEqual(directory['observation_count'], 1)
                    self.assertEqual(directory['coverage']['comparable_1d_count'], 1)
                    self.assertEqual(directory['coverage']['queued_count'], 1)
                    self.assertEqual(set(result['snapshot']['repositories']), {'1'})
                    validate_data_tree(dest)
                    self.assertFalse((dest / 'state/pending-update.json').exists())
                    before = (dest / 'public/directory.json').read_bytes()
                    run_update(FakeClient([]), **kwargs)
                    self.assertEqual(before, (dest / 'public/directory.json').read_bytes())

    def test_unavailable_observed_repository_removed_from_directory(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); seeds = root / 'seeds.json'; atomic_write_json(seeds, [])
            now = dt.datetime(2026, 9, 1, 17, tzinfo=UTC)
            run_update(FakeClient([api_repo(1, 'owner/one', 100), api_repo(2, 'owner/two', 99)]), data_dir=root, projects_file=seeds, captured_at=now, max_candidates=2)
            result = run_update(FakeClient([api_repo(2, 'owner/two', 100), api_repo(3, 'owner/new', 999)]), data_dir=root, projects_file=seeds, captured_at=now + dt.timedelta(days=1), max_candidates=2)
            self.assertNotIn(1, {item['repository_id'] for item in result['directory']['repositories']})
            self.assertEqual(set(result['snapshot']['repositories']), {'2'})
            validate_data_tree(root)
            payload = json.loads((root/'public/directory.json').read_text())
            payload['observation_count'] = 2
            atomic_write_json(root/'public/directory.json', payload)
            with self.assertRaises(SchemaValidationError):
                validate_data_tree(root)
