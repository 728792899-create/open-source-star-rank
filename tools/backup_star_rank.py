"""Content-addressed backups of an exact Git data commit, with safe offline restore."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 16 * 1024 * 1024
SHA = re.compile(r'[0-9a-f]{64}\Z')

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def valid_path(path):
    return isinstance(path, str) and re.fullmatch(r'(state|snapshots|public|captures)/[A-Za-z0-9_./-]+\.json', path) and all(p not in ('', '.', '..') for p in path.split('/'))

def validate_manifest(manifest):
    if not isinstance(manifest, dict) or manifest.get('version') != 1 or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('data_commit', '')):
        raise ValueError('Invalid backup manifest')
    created = datetime.fromisoformat(manifest['created_at'].replace('Z', '+00:00'))
    if created.tzinfo is None:
        raise ValueError('Backup timestamp must include timezone')
    files = manifest.get('files')
    if not isinstance(files, list) or not 1 <= len(files) <= 100000:
        raise ValueError('Invalid manifest files')
    paths = set()
    for item in files:
        if not valid_path(item.get('path')) or item['path'] in paths or not SHA.fullmatch(item.get('sha256', '')) or type(item.get('size')) is not int or not 0 <= item['size'] <= MAX_BYTES:
            raise ValueError('Invalid manifest entry')
        paths.add(item['path'])
    if not {'public/index.json', 'state/candidates.json'} <= paths:
        raise ValueError('Missing core data')
    return manifest

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Backup endpoint redirects are forbidden')

class BackupClient:
    def __init__(self, endpoint, token):
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('Backup endpoint must be an HTTPS origin')
        if len(token) < 32:
            raise ValueError('Backup token is missing or too short')
        self.endpoint = endpoint.rstrip('/')
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect)
    def request(self, path, body=None, missing_ok=False):
        request = urllib.request.Request(self.endpoint + path, data=body, method='GET' if body is None else 'PUT', headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/octet-stream'})
        try:
            with self.opener.open(request, timeout=60) as response:
                raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise ValueError('Backup object exceeds limit')
                return raw
        except urllib.error.HTTPError as exc:
            if missing_ok and exc.code == 404:
                return None
            raise ValueError(f'Backup request failed ({exc.code})') from None
    def get(self, path, missing_ok=False):
        return self.request(path, missing_ok=missing_ok)
    def put(self, path, raw):
        return self.request(path, body=raw)

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])

def upload(root, client):
    commit = git(root, 'rev-parse', 'HEAD').decode().strip()
    entries = git(root, 'ls-tree', '-rz', '--full-tree', commit, '--', 'state', 'snapshots', 'public', 'captures').split(b'\0')
    def upload_entry(entry):
        metadata, raw_path = entry.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        path = raw_path.decode()
        if not valid_path(path) or kind != 'blob' or mode != '100644':
            raise ValueError('Unexpected data tree entry: ' + path)
        raw = git(root, 'cat-file', 'blob', oid)
        if len(raw) > MAX_BYTES:
            raise ValueError('Backup object exceeds limit: ' + path)
        json.loads(raw)
        hash_value = digest(raw)
        # Re-read remote objects on every run: never report success for missing/corrupt old objects.
        remote = client.get('/objects/' + hash_value, missing_ok=True)
        if remote is None:
            client.put('/objects/' + hash_value, raw)
            remote = client.get('/objects/' + hash_value)
        if digest(remote) != hash_value or len(remote) != len(raw):
            raise ValueError('Remote checksum mismatch: ' + path)
        return dict(path=path, sha256=hash_value, size=len(raw))
    with ThreadPoolExecutor(max_workers=8) as pool:
        files = list(pool.map(upload_entry, (entry for entry in entries if entry)))
    manifest = validate_manifest(dict(version=1, data_commit=commit, created_at=datetime.now(timezone.utc).isoformat(), files=files))
    raw = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    if len(raw) > MAX_BYTES:
        raise ValueError('Manifest exceeds limit')
    hash_value = digest(raw)
    client.put('/manifests/' + hash_value, raw)
    if digest(client.get('/manifests/' + hash_value)) != hash_value:
        raise ValueError('Manifest readback mismatch')
    with tempfile.TemporaryDirectory(prefix='starrank-upload-verify-') as folder:
        restore(Path(folder) / 'data', client, hash_value)
    client.put('/backup/latest', json.dumps(dict(manifest=hash_value, verified_count=len(files))).encode())
    return dict(manifest=hash_value, data_commit=commit, verified_count=len(files))

def restore(destination, client, manifest_id=None):
    if destination.exists():
        raise ValueError('Restore destination must not exist')
    if manifest_id is None:
        manifest_id = json.loads(client.get('/backup/latest'))['manifest']
    if not SHA.fullmatch(manifest_id):
        raise ValueError('Invalid manifest id')
    raw = client.get('/manifests/' + manifest_id)
    if digest(raw) != manifest_id:
        raise ValueError('Manifest checksum mismatch')
    manifest = validate_manifest(json.loads(raw))
    # Failed restores stay inside a private temporary directory, never a partial live tree.
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.restore-', dir=destination.parent) as work:
        root = Path(work) / 'data'
        root.mkdir()
        def restore_entry(item):
            raw = client.get('/objects/' + item['sha256'])
            if len(raw) != item['size'] or digest(raw) != item['sha256']:
                raise ValueError('Restored object checksum mismatch: ' + item['path'])
            json.loads(raw)
            path = root / item['path']
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(restore_entry, manifest['files']))
        from tools.validate_star_rank_data import validate_data_tree
        from tools.capture_store import latest_receipt, read_receipt, validate_receipt
        validate_data_tree(root)
        for folder in sorted((root / 'captures').glob('????-??-??')):
            latest_receipt(folder)
            for path in folder.glob('*.json'):
                if path.name != 'latest.json':
                    read_receipt(path)
        pending = root / 'state' / 'pending-update.json'
        if pending.exists():
            validate_receipt(json.loads(pending.read_text()))
        # A saved pending receipt is recoverable; it is not claimed to be published.
        root.rename(destination)
    return dict(manifest=manifest_id, data_commit=manifest['data_commit'], verified_count=len(manifest['files']))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['upload', 'restore', 'verify'])
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--manifest')
    args = parser.parse_args()
    client = BackupClient(os.environ.get('STAR_RANK_BACKUP_ENDPOINT', ''), os.environ.get('STAR_RANK_BACKUP_TOKEN', ''))
    if args.mode == 'upload':
        if not args.data_dir:
            parser.error('--data-dir required')
        result = upload(args.data_dir, client)
    elif args.mode == 'restore':
        if not args.output:
            parser.error('--output required')
        result = restore(args.output, client, args.manifest)
    else:
        with tempfile.TemporaryDirectory(prefix='starrank-backup-verify-') as folder:
            result = restore(Path(folder) / 'data', client, args.manifest)
    print(json.dumps(result))

if __name__ == '__main__':
    main()
