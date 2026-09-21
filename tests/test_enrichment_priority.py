import tempfile
import unittest
from pathlib import Path

from tests.test_localize_repositories import FakeClient as TranslationClient, source, write_json
from tests.test_classify_repositories import FakeClient as ClassificationClient
from tools.localize_repositories import localize_repositories, discover_ranked_repositories
from tools.classify_repositories import classify_repositories


class EnrichmentPriorityTests(unittest.TestCase):
    def test_current_top_100_precede_newer_metadata_and_new_candidates_precede_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / 'public'
            write_json(public / 'daily/2026-09-20.json', {'date': '2026-09-20', 'entries': [source(999), source(998)]})
            write_json(public / 'daily/2026-09-19.json', {'date': '2026-09-19', 'entries': [source(2), source(997)]})
            write_json(public / 'alltime/top-1000.json', {'generated_at': '2026-09-21T12:00:00Z', 'entries': [source(1)]})
            write_json(public / 'repositories.json', {'updated_at': '2026-09-21T10:00:00Z', 'repositories': [{**source(997), 'stars_total': 500}, {**source(999), 'stars_total': 10}, {**source(2), 'stars_total': 1000}]})
            self.assertEqual(list(discover_ranked_repositories(public)), [999, 998, 2, 997, 1])
            translations = TranslationClient()
            localize_repositories(root, client=translations, max_projects=1)
            self.assertEqual(translations.calls[0][0]['repository_id'], 999)
            classifications = ClassificationClient()
            classify_repositories(root, client=classifications, taxonomy_file=Path('data/classification-taxonomy.zh-CN.json'), max_projects=1)
            self.assertEqual(classifications.calls[0][0]['repository_id'], 999)

    def test_priority_preserves_existing_metadata_and_coverage_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            public = Path(directory)
            write_json(public / 'daily/2026-09-20.json', {'date': '2026-09-20', 'entries': [source(1, full_name='owner/old')]})
            write_json(public / 'repositories.json', {'updated_at': '2026-09-21T10:00:00Z', 'repositories': [source(1, full_name='owner/renamed'), source(2)]})
            sources = discover_ranked_repositories(public)
            self.assertEqual(sources[1]['full_name'], 'owner/old')
            self.assertEqual(list(sources), [1])
