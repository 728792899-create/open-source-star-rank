"""JSON Schema helpers shared by the collector and build validation."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Mapping

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError, ValidationError


SCHEMA_FILES = {
    "state": "state.schema.json",
    "snapshot": "snapshot.schema.json",
    "index": "index.schema.json",
    "daily": "daily.schema.json",
    "language": "language.schema.json",
    "language_index": "language-index.schema.json",
    "period": "period.schema.json",
    "repositories": "repositories.schema.json",
    "event_index": "event-index.schema.json",
    "event_daily": "event-daily.schema.json",
    "localization": "localization.schema.json",
}


class SchemaValidationError(RuntimeError):
    """Raised when a star-rank document violates its public contract."""


def default_schema_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "schemas" / "star-rank"


def load_schema(kind: str, schema_dir: Path | None = None) -> Mapping[str, Any]:
    root = (schema_dir or default_schema_dir()).resolve()
    filename = SCHEMA_FILES.get(kind)
    if filename is None:
        raise SchemaValidationError(f"未知数据类型：{kind}")
    path = root / filename
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(payload)
        return payload
    except (OSError, json.JSONDecodeError, SchemaError) as exc:
        raise SchemaValidationError(f"无法读取 JSON Schema：{path}: {exc}") from exc


def validate_payload(kind: str, payload: Any, schema_dir: Path | None = None) -> None:
    schema = load_schema(kind, schema_dir)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(payload), key=lambda error: list(error.absolute_path))
    if not errors:
        return
    error: ValidationError = errors[0]
    location = ".".join(str(part) for part in error.absolute_path) or "<root>"
    raise SchemaValidationError(f"{kind} 数据不符合 Schema（{location}）：{error.message}")


def sync_public_schemas(public_dir: Path, schema_dir: Path | None = None) -> None:
    source = (schema_dir or default_schema_dir()).resolve()
    target = public_dir / "schema"
    target.mkdir(parents=True, exist_ok=True)
    for filename in SCHEMA_FILES.values():
        source_path = source / filename
        if not source_path.is_file():
            raise SchemaValidationError(f"缺少 JSON Schema：{source_path}")
        shutil.copyfile(source_path, target / filename)
