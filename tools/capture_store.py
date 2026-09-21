"""Immutable, validated capture receipts, independent from derived rankings."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
from tools.star_rank_schema import validate_payload, SchemaValidationError


def receipt_bytes(receipt: dict) -> bytes:
    return (json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def validate_receipt(receipt: dict) -> None:
    if not isinstance(receipt, dict) or set(receipt) - {'snapshot', 'candidates', 'directory', 'observations', 'observation_capacity'}:
        raise SchemaValidationError('Invalid capture receipt fields')
    snapshot, candidates = receipt['snapshot'], receipt['candidates']
    validate_payload('snapshot', snapshot)
    state = dict(schema_version='1.2.0', updated_at=snapshot['captured_at'], candidate_count=len(candidates), candidates=candidates)
    if 'directory' in receipt:
        state.update(schema_version='1.3.0', directory=receipt['directory'], observations=receipt['observations'], observation_capacity=receipt['observation_capacity'])
    validate_payload('state', state)
    identities = {str(item['repository_id']): {'full_name': item['full_name'], 'stars_total': item['stars_total']} for item in candidates}
    if len(identities) != len(candidates) or identities != snapshot['repositories'] or len(candidates) != snapshot['candidate_count']:
        raise SchemaValidationError('Capture metadata and snapshot identities differ')
    if 'directory' in receipt:
        directory = {item['repository_id']: item for item in receipt['directory']}
        if len(directory) != len(receipt['directory']) or any(directory.get(item['repository_id']) != item for item in candidates):
            raise SchemaValidationError('Capture directory does not contain the exact observed members')


def store_receipt(data_dir: Path, receipt: dict) -> Path:
    validate_receipt(receipt)
    raw = receipt_bytes(receipt)
    destination = data_dir / 'captures' / receipt['snapshot']['snapshot_date'] / (hashlib.sha256(raw).hexdigest() + '.json')
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.read_bytes() != raw:
            raise SchemaValidationError('Immutable capture receipt checksum mismatch')
    else:
        # A receipt is independently recoverable even when journal/derived writes fail.
        temporary = destination.with_suffix('.tmp')
        with temporary.open('wb') as handle:
            handle.write(raw)
            handle.flush()
            import os
            os.fsync(handle.fileno())
        temporary.replace(destination)
    pointer = destination.parent / 'latest.json'
    temporary = pointer.with_suffix('.tmp')
    temporary.write_text(json.dumps({'sha256': destination.stem}) + '\n')
    temporary.replace(pointer)
    return destination


def read_receipt(path: Path) -> dict:
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != path.stem:
        raise SchemaValidationError(f'Capture checksum mismatch: {path.name}')
    receipt = json.loads(raw)
    validate_receipt(receipt)
    if receipt['snapshot']['snapshot_date'] != path.parent.name:
        raise SchemaValidationError('Capture date and path differ')
    return receipt


def latest_receipt(folder: Path) -> dict:
    import re
    pointer = json.loads((folder / 'latest.json').read_text())
    digest = pointer.get('sha256', '')
    if not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
        raise SchemaValidationError('Invalid capture pointer')
    return read_receipt(folder / (digest + '.json'))
