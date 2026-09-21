import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from tools.operations_report import write_report
from tools.star_rank import run_update
from tests.test_star_rank import FakeClient,api_repo

class OperationsTests(unittest.TestCase):
    def test_small_report_uses_source_dates_and_never_invents_enrichment(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'data';seed=Path(folder)/'seed.json';seed.write_text('[]')
            run_update(FakeClient([api_repo(1,'owner/project',100)]),data_dir=root,projects_file=seed,captured_at=dt.datetime(2026,9,20,16,20,tzinfo=dt.timezone.utc))
            report=write_report(root)
            self.assertEqual(report['observed_count'],1)
            self.assertEqual(report['snapshot_at'],'2026-09-20T16:20:00Z')
            self.assertIsNone(report['ranking_date']);self.assertEqual(report['enrichment'],{'translation':None,'classification':None})
            self.assertEqual(json.loads((root/'public/operations.json').read_text()),report)
