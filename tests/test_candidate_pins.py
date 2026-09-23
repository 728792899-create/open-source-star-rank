import datetime as dt
import tempfile
import unittest
from pathlib import Path

from tests.test_star_rank import FakeClient, api_repo
from tools.star_rank import merge_and_refresh_candidates, repository_record


class CandidatePinsTests(unittest.TestCase):
    def test_removed_pin_can_be_evicted_and_new_pin_takes_precedence(self):
        old = repository_record(api_repo(1, 'owner/old', 10000), observed_date='2026-09-19', source='seed', pinned=True)
        new = repository_record(api_repo(2, 'owner/new', 10), observed_date='2026-09-21', source='search')
        with tempfile.TemporaryDirectory() as directory:
            result = merge_and_refresh_candidates(FakeClient([api_repo(1, 'owner/old', 10000), api_repo(2, 'owner/new', 10)]), previous=[old], discovered={2: new}, pinned_repositories=['owner/new'], snapshot_dir=Path(directory), observed_date=dt.date(2026, 9, 21), max_candidates=1)
        self.assertEqual([item['repository_id'] for item in result], [2])
        self.assertTrue(result[0]['pinned'])

    def test_removed_pin_stays_unpinned_after_refresh(self):
        old = repository_record(api_repo(1, 'owner/old', 10), observed_date='2026-09-19', source='seed', pinned=True)
        with tempfile.TemporaryDirectory() as directory:
            result = merge_and_refresh_candidates(FakeClient([api_repo(1, 'owner/old', 12)]), previous=[old], discovered={}, pinned_repositories=[], snapshot_dir=Path(directory), observed_date=dt.date(2026, 9, 21), max_candidates=10)
        self.assertFalse(result[0]['pinned'])

    def test_renamed_seed_resolves_stable_id_without_resetting_history(self):
        class AliasClient(FakeClient):
            def get_repository(self, name):
                return self.repositories[1] if name == 'owner/old' else super().get_repository(name)
        old = repository_record(api_repo(1, 'owner/new', 10), observed_date='2026-09-19', source='search')
        with tempfile.TemporaryDirectory() as directory:
            result = merge_and_refresh_candidates(AliasClient([api_repo(1, 'owner/new', 12)]), previous=[old], discovered={}, pinned_repositories=['owner/old'], snapshot_dir=Path(directory), observed_date=dt.date(2026, 9, 21), max_candidates=10)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]['pinned'])
        self.assertEqual(result[0]['full_name'], 'owner/new')
        self.assertEqual(result[0]['first_seen_date'], '2026-09-19')
