import datetime as dt
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from tests.test_star_rank import FakeClient, api_repo
from tools import star_rank as s
from tools.capture_store import read_receipt
from tools.capture_checkpoint import checkpoint
from tools.star_rank_schema import SchemaValidationError

class CaptureStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'data'; self.root.mkdir()
        self.seed = Path(self.tmp.name) / 'seed.json'; self.seed.write_text('[]')
        self.when = dt.datetime(2026, 9, 20, 16, 20, tzinfo=dt.timezone.utc)
    def update(self, root=None, when=None, **kwargs):
        return s.run_update(FakeClient([api_repo(1, 'demo/one', 100)]), data_dir=root or self.root,
                            projects_file=self.seed, captured_at=when or self.when, **kwargs)
    def test_derivation_failure_keeps_valid_receipt_and_offline_retry(self):
        with patch.object(s, 'build_index', side_effect=RuntimeError('derivation broken')):
            with self.assertRaises(RuntimeError): self.update()
        receipt = next(p for p in self.root.glob('captures/*/*.json') if p.name != 'latest.json')
        self.assertEqual(read_receipt(receipt)['snapshot']['candidate_count'], 1)
        self.assertFalse((self.root/'public/index.json').exists())
        restored = Path(self.tmp.name)/'restored'; shutil.copytree(self.root/'captures', restored/'captures')
        client = FakeClient([])
        result = s.run_update(client, data_dir=restored, projects_file=self.seed,
                              captured_at=self.when+dt.timedelta(hours=8), require_valid_capture=True)
        self.assertEqual(client.request_count, 0); self.assertEqual(result['status'], 'reused')
        self.assertTrue((restored/'public/index.json').exists())
    def test_tampered_receipt_is_not_replayed(self):
        self.update(); path=next(p for p in self.root.glob('captures/*/*.json') if p.name != 'latest.json'); path.write_bytes(path.read_bytes()+b' ')
        restored=Path(self.tmp.name)/'restored'; shutil.copytree(self.root/'captures',restored/'captures')
        with self.assertRaises(SchemaValidationError): self.update(root=restored)
        self.assertFalse((restored/'public').exists())
    def test_dry_run_does_not_save_receipt(self):
        self.update(dry_run=True); self.assertFalse((self.root/'captures').exists())
    def test_multiple_receipts_restore_in_date_order_without_api(self):
        self.update(); self.update(when=self.when+dt.timedelta(days=1))
        restored=Path(self.tmp.name)/'restored'; shutil.copytree(self.root/'captures',restored/'captures')
        client=FakeClient([])
        result=s.run_update(client,data_dir=restored,projects_file=self.seed,captured_at=self.when+dt.timedelta(days=1,hours=8),require_valid_capture=True)
        self.assertEqual(client.request_count,0); self.assertEqual(result['index']['latest_date'],'2026-09-21')
    def test_checkpoint_never_commits_dirty_derived_files(self):
        def git(root,*args): return subprocess.run(['git','-C',str(root),*args],check=True,capture_output=True,text=True).stdout
        remote=Path(self.tmp.name)/'remote.git'; subprocess.run(['git','init','--bare',str(remote)],check=True,capture_output=True)
        git(self.root,'init'); git(self.root,'remote','add','origin',str(remote))
        self.update(); checkpoint(self.root)
        files=git(self.root,'ls-tree','-r','--name-only','HEAD').splitlines()
        self.assertTrue(files); self.assertTrue(all(p.startswith('captures/') for p in files))
        self.assertTrue((self.root/'public/index.json').exists())

    def test_retry_pushes_commit_after_transport_failure(self):
        root=self.root
        def git(*args): return subprocess.run(['git','-C',str(root),*args],check=True,capture_output=True,text=True).stdout
        remote=Path(self.tmp.name)/'remote.git'; subprocess.run(['git','init','--bare',str(remote)],check=True,capture_output=True)
        git('init'); git('remote','add','origin',str(remote)); self.update()
        original=subprocess.run
        def fail_push(args, **kwargs):
            if 'push' in args: raise subprocess.CalledProcessError(1,args)
            return original(args,**kwargs)
        with patch('tools.capture_checkpoint.subprocess.run',side_effect=fail_push), self.assertRaises(subprocess.CalledProcessError): checkpoint(root)
        self.assertFalse(git('ls-remote','origin','refs/heads/star-rank-data'))
        checkpoint(root)
        self.assertIn(git('rev-parse','HEAD').strip(),git('ls-remote','origin','refs/heads/star-rank-data'))
    def test_equal_timestamp_replacement_recovers_latest_receipt(self):
        self.update()
        s.run_update(FakeClient([api_repo(1,'demo/one',200)]),data_dir=self.root,projects_file=self.seed,captured_at=self.when,replace_snapshot=True,replace_date=s.local_date(self.when))
        restored=Path(self.tmp.name)/'restored'; shutil.copytree(self.root/'captures',restored/'captures')
        result=s.run_update(FakeClient([]),data_dir=restored,projects_file=self.seed,captured_at=self.when+dt.timedelta(hours=8))
        self.assertEqual(result['snapshot']['repositories']['1']['stars_total'],200)
