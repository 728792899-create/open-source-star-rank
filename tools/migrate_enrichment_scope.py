#!/usr/bin/env python3
"""Upgrade enrichment sources in an isolated output copy, without model calls.

Input data remains untouched. Validate both source and output; publishing the
result is a separate operation against an exact data commit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

from tools.classify_repositories import classify_repositories
from tools.localize_repositories import latest_public_timestamp, localize_repositories
from tools.validate_star_rank_data import validate_data_tree


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for folder in ('state', 'snapshots', 'public'):
        for path in sorted((root / folder).rglob('*.json')):
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(b'\0')
            digest.update(path.read_bytes())
            digest.update(b'\0')
    return digest.hexdigest()


def migrate_scope(data_dir: Path, output_dir: Path, *, config_dir: Path | None = None):
    source, output = data_dir.resolve(), output_dir.resolve()
    if source == output or source in output.parents or output in source.parents or output.exists():
        raise ValueError('迁移输出必须是源目录之外的新目录，不能覆盖已有数据')
    if not (source / 'public/index.json').is_file():
        raise ValueError('迁移需要包含 public/index.json 的完整数据目录')
    if (source / 'state/pending-update.json').exists():
        raise ValueError('请先恢复未完成的采集发布，再迁移补全来源')
    validate_data_tree(source)
    before = tree_digest(source)
    shutil.copytree(source, output, ignore=shutil.ignore_patterns('.git'))
    config = config_dir or Path(__file__).resolve().parents[1] / 'data'
    now = latest_public_timestamp(output / 'public')
    localization = localize_repositories(
        output, overrides_file=config / 'localization-overrides.zh-CN.json',
        source_scope='catalog-v1', max_projects=0, now=now,
    )
    classification, _ = classify_repositories(
        output, taxonomy_file=config / 'classification-taxonomy.zh-CN.json',
        overrides_file=config / 'classification-overrides.zh-CN.json',
        source_scope='catalog-v1', max_projects=0, now=now,
    )
    validation = validate_data_tree(output, sync_schemas=True)
    if tree_digest(source) != before:
        raise ValueError('源数据在迁移期间发生变化，请用固定数据提交重试')
    return {
        'source_digest': before, 'output_digest': tree_digest(output),
        'enrichment_schema_version': '1.1.0', 'source_scope': 'catalog-v1',
        'online_requests': 0,
        'localization': localization['coverage'], 'classification': classification['coverage'],
        'validation': validation,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(migrate_scope(args.data_dir, args.output_dir), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
