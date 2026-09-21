"""Commit only validated immutable receipts; never stage partial derived files."""
import argparse
from pathlib import Path
import subprocess
from tools.capture_store import read_receipt, latest_receipt


def checkpoint(root: Path):
    for folder in sorted((root / 'captures').glob('????-??-??')):
        latest_receipt(folder)
        for path in folder.glob('*.json'):
            if path.name != 'latest.json': read_receipt(path)
    def git(*args):
        return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True, text=True).stdout.strip()
    if git('diff', '--cached', '--name-only'):
        raise ValueError('Refusing to include unrelated staged files in capture checkpoint')
    git('config', 'user.name', 'github-actions[bot]')
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    git('add', 'captures')
    if git('diff', '--cached', '--name-only'):
        git('commit', '-m', 'Save validated capture receipts before publication')
    remote = git('ls-remote', 'origin', 'refs/heads/star-rank-data').split()
    base = remote[0] if remote else None
    if base:
        git('fetch', 'origin', 'refs/heads/star-rank-data')
        git('merge-base', '--is-ancestor', base, 'HEAD')
    revision = f'{base}..HEAD' if base else 'HEAD'
    if git('rev-list', '--min-parents=2', revision):
        raise ValueError('Refusing to push merge commits from capture checkpoint')
    for commit in git('rev-list', revision).splitlines():
        paths = git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit).splitlines()
        if not paths or any(not path.startswith('captures/') for path in paths):
            raise ValueError('Refusing to push unrelated unpublished commits')
    git('push', 'origin', 'HEAD:star-rank-data')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    checkpoint(parser.parse_args().data_dir)
