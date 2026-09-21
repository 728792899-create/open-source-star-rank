import datetime as dt
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from tools.backup_star_rank import upload, restore, digest, BackupClient, validate_manifest
from tools.star_rank import run_update
from tests.test_star_rank import FakeClient, api_repo

class Storage:
    def __init__(self): self.values={}; self.puts=[]
    def get(self,path,missing_ok=False):
        if missing_ok: return self.values.get(path)
        return self.values[path]
    def put(self,path,raw): self.puts.append(path);self.values[path]=raw

class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)/'data';self.root.mkdir()
        self.seed=Path(self.tmp.name)/'seed.json';self.seed.write_text('[]')
        run_update(FakeClient([api_repo(1,'demo/one',100)]),data_dir=self.root,projects_file=self.seed,captured_at=dt.datetime(2026,9,20,16,20,tzinfo=dt.timezone.utc))
        for args in [('init','-q'),('config','user.email','test@example.test'),('config','user.name','Test'),('add','.'),('commit','-qm','data')]:
            subprocess.run(['git','-C',str(self.root),*args],check=True,capture_output=True)
        self.client=Storage()
    def test_roundtrip_exact_commit_ignores_dirty_working_tree(self):
        original=(self.root/'public/index.json').read_bytes()
        (self.root/'public/index.json').write_text('dirty')
        report=upload(self.root,self.client)
        restored=Path(self.tmp.name)/'restored';restore(restored,self.client)
        self.assertEqual((restored/'public/index.json').read_bytes(),original)
        self.assertGreater(report['verified_count'],3)
        puts=len([p for p in self.client.puts if p.startswith('/objects/')])
        upload(self.root,self.client)
        self.assertEqual(len([p for p in self.client.puts if p.startswith('/objects/')]),puts)
    def test_corruption_fails_restore_without_partial_output(self):
        upload(self.root,self.client)
        key=next(p for p in self.client.values if p.startswith('/objects/'));self.client.values[key]=b'bad'
        output=Path(self.tmp.name)/'restored'
        with self.assertRaisesRegex(ValueError,'checksum'):restore(output,self.client)
        self.assertFalse(output.exists())
        with self.assertRaisesRegex(ValueError,'checksum'):upload(self.root,self.client)
    def test_semantically_invalid_backup_does_not_replace_latest(self):
        upload(self.root,self.client)
        previous=self.client.get('/backup/latest')
        index=self.root/'public/index.json'
        value=json.loads(index.read_text());value['candidate_count']+=1;index.write_text(json.dumps(value))
        subprocess.run(['git','-C',str(self.root),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.root),'commit','-qm','invalid'],check=True)
        with self.assertRaises(Exception):upload(self.root,self.client)
        self.assertEqual(previous,self.client.get('/backup/latest'))

    def test_existing_destination_is_never_overwritten(self):
        with self.assertRaisesRegex(ValueError,'must not exist'):restore(self.root,self.client)
    def test_manifest_traversal_and_endpoint_credentials_are_rejected(self):
        report=upload(self.root,self.client)
        manifest=json.loads(self.client.get('/manifests/'+report['manifest']))
        manifest['files'][0]['path']='public/../../secret.json'
        with self.assertRaises(ValueError):validate_manifest(manifest)
        for endpoint in ['http://example.test','https://user:pass@example.test','https://example.test/a','https://example.test?token=x']:
            with self.assertRaises(ValueError):BackupClient(endpoint,'x'*40)
