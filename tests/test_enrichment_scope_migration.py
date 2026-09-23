import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.test_star_rank import FakeClient, api_repo
from tests.test_localize_repositories import FakeClient as TranslationClient, source, write_json
from tests.test_classify_repositories import FakeClient as ClassificationClient
from tools.star_rank import run_update, atomic_write_json
from tools.localize_repositories import localize_repositories, discover_ranked_repositories
from tools.classify_repositories import classify_repositories
from tools.migrate_enrichment_scope import migrate_scope, tree_digest
from tools.migrate_star_rank_top500 import apply_manifest, build_manifest
from tools.validate_star_rank_data import validate_data_tree

TAXONOMY = Path('data/classification-taxonomy.zh-CN.json')


def make_data(root):
    seeds = root.parent / 'seeds.json'; atomic_write_json(seeds, [])
    now = dt.datetime(2026, 9, 1, 17, tzinfo=dt.timezone.utc)
    run_update(FakeClient([api_repo(1, 'owner/one', 100)]), data_dir=root, projects_file=seeds, captured_at=now, max_candidates=1)
    run_update(FakeClient([api_repo(1, 'owner/one', 101), api_repo(2, 'owner/two', 900)]), data_dir=root, projects_file=seeds, captured_at=now + dt.timedelta(days=1), max_candidates=1)
    localized = localize_repositories(root, client=TranslationClient(), now=now)
    _, classified = classify_repositories(root, client=ClassificationClient(), taxonomy_file=TAXONOMY, now=now)
    validate_data_tree(root)
    return localized, classified


class EnrichmentScopeMigrationTests(unittest.TestCase):
    def test_isolated_migration_preserves_input_cache_and_old_deploy_contract(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); data = root / 'data'
            localized, classified = make_data(data)
            before = tree_digest(data)
            self.assertEqual(localized['coverage']['eligible_count'], 1)
            with patch('tools.localize_repositories.GitHubModelsClient', side_effect=AssertionError('network forbidden')), patch('tools.classify_repositories.GitHubModelsClassificationClient', side_effect=AssertionError('network forbidden')):
                report = migrate_scope(data, root / 'migrated')
            self.assertEqual(before, tree_digest(data))
            self.assertEqual(report['online_requests'], 0)
            self.assertEqual(report['localization']['eligible_count'], 2)
            self.assertEqual(report['localization']['pending_count'], 1)
            self.assertEqual(report['classification']['eligible_count'], 2)
            self.assertEqual(report['classification']['pending_count'], 1)
            new_localized = localize_repositories(root / 'migrated')
            new_index, new_classified = classify_repositories(root / 'migrated', taxonomy_file=TAXONOMY)
            self.assertEqual(new_localized['schema_version'], '1.1.0')
            self.assertEqual(new_index['schema_version'], '1.1.0')
            self.assertEqual(new_localized['repositories'], localized['repositories'])
            self.assertEqual(new_classified['repositories'], classified['repositories'])
            # deploy_existing's direct validator accepts either fixed data version.
            validate_data_tree(data); validate_data_tree(root / 'migrated')
            for version in (data, root / 'migrated'):
                apply_manifest(version, build_manifest(version), recomputed_at='2026-09-21T00:00:00Z')
            again = migrate_scope(root / 'migrated', root / 'again')
            self.assertEqual(again['source_digest'], again['output_digest'])

    def test_online_budget_after_migration_reaches_catalog_only_project(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); data = root / 'data'; make_data(data)
            migrate_scope(data, root / 'migrated')
            client = TranslationClient()
            localized = localize_repositories(root / 'migrated', client=client, max_projects=1)
            self.assertEqual(client.calls[0][0]['repository_id'], 2)
            self.assertEqual(localized['coverage']['pending_count'], 0)
            client = ClassificationClient()
            index, _ = classify_repositories(root / 'migrated', client=client, max_projects=1, taxonomy_file=TAXONOMY)
            self.assertEqual(client.calls[0][0]['repository_id'], 2)
            self.assertEqual(index['coverage']['pending_count'], 0)
            validate_data_tree(root / 'migrated')

    def test_waiting_metadata_does_not_become_fresh_when_directory_is_assembled(self):
        with tempfile.TemporaryDirectory() as name:
            public = Path(name)
            write_json(public / 'daily/2026-09-20.json', {'date': '2026-09-20', 'entries': [source(1, full_name='owner/current'), source(3, full_name='owner/known-date')]})
            write_json(public / 'directory.json', {'updated_at': '2026-09-21T12:00:00Z', 'repositories': [{**source(1, full_name='owner/old'), 'last_seen_date': '2026-09-01'}, {**source(3, full_name='owner/unknown-date'), 'last_seen_date': None}, {**source(2), 'last_seen_date': '2026-09-21'}]})
            expanded = discover_ranked_repositories(public, source_scope='catalog-v1')
            self.assertEqual(expanded[1]['full_name'], 'owner/current')
            self.assertIn(2, expanded)
            self.assertEqual(expanded[3]['full_name'], 'owner/known-date')
            self.assertNotIn(2, discover_ranked_repositories(public))

    def test_refuses_output_overwrite_and_pending_collection(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); data = root / 'data'; make_data(data)
            for output in (data, data / 'nested', root):
                with self.assertRaises(ValueError):
                    migrate_scope(data, output)
            atomic_write_json(data / 'state/pending-update.json', {})
            with self.assertRaises(ValueError):
                migrate_scope(data, root / 'output')
            self.assertFalse((root / 'output').exists())
