"""Source-safe run receipts. Token totals are observed usage, never inferred bills."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
import json
import os
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
import uuid
from urllib.parse import urlsplit

# Official per-million USD rates verified 2026-09-24. Estimate a range because
# peak periods exclude Chinese holidays; do not guess calendar/billing eligibility.
TARIFF = {'source': 'https://api-docs.deepseek.com/quick_start/pricing',
          'verified_on': '2026-09-24', 'valid_until': '2026-10-24', 'currency': 'USD',
          'cache_hit': ['0.003', '0.006'], 'cache_miss': ['0.15', '0.3'],
          'output': ['0.6', '1.2']}


class UsageMeter:
    def __init__(self):
        self.requests = 0
        self.usage_responses = 0
        self.priced_responses = 0
        self.tokens = Counter(prompt_tokens=0, completion_tokens=0, cache_hit_tokens=0, cache_miss_tokens=0)
        self.errors = Counter()

    def observe(self, raw):
        try:
            value = json.loads(raw)
            usage = value.get('usage') if isinstance(value, dict) else None
            if not isinstance(usage, dict):
                return
            prompt, completion = usage.get('prompt_tokens'), usage.get('completion_tokens')
            if any(type(v) is not int or v < 0 for v in [prompt, completion]):
                return
            self.usage_responses += 1
            self.tokens.update(prompt_tokens=prompt, completion_tokens=completion)
            hit, miss = usage.get('prompt_cache_hit_tokens'), usage.get('prompt_cache_miss_tokens')
            if all(type(v) is int and v >= 0 for v in [hit, miss]) and hit + miss == prompt:
                self.priced_responses += 1
                self.tokens.update(cache_hit_tokens=hit, cache_miss_tokens=miss)
        except (ValueError, UnicodeError):
            return

    def summary(self, endpoint, model, at):
        complete = self.usage_responses == self.requests
        tariff_valid = TARIFF['verified_on'] <= at[:10] <= TARIFF['valid_until']
        supported = urlsplit(endpoint or '').hostname == 'api.deepseek.com' and model == 'deepseek-flash'
        price_complete = self.priced_responses == self.requests
        estimate = None
        if supported and tariff_valid and complete and price_complete:
            values = [self.tokens['cache_hit_tokens'], self.tokens['cache_miss_tokens'], self.tokens['completion_tokens']]
            rates = [TARIFF['cache_hit'], TARIFF['cache_miss'], TARIFF['output']]
            estimate = {'currency': 'USD', 'min': str(sum(Decimal(v)*Decimal(r[0]) for v,r in zip(values,rates))/1000000),
                        'max': str(sum(Decimal(v)*Decimal(r[1]) for v,r in zip(values,rates))/1000000)}
        return {'requests': self.requests, 'usage_responses': self.usage_responses,
                'unknown_usage_requests': self.requests-self.usage_responses,
                'usage_complete': complete, 'observed_tokens': dict(self.tokens),
                'request_errors': dict(sorted(self.errors.items())), 'estimated_cost': estimate,
                'pricing': TARIFF if supported else None,
                'pricing_status': 'estimated_range' if estimate is not None else 'unavailable',
                'billing_note': '估算区间并非账单；缺失用量或过期价格不计算费用。'}


def failure_code(error):
    # Fixed labels only; never persist source snippets, model text or exception bodies.
    text = str(error)
    for fragment, code in [('关键标识', 'missing_verbatim'), ('不含中文', 'missing_chinese'),
                           ('中文简介', 'missing_description'), ('长度或字符', 'text_limits'),
                           ('ID', 'repository_identity'), ('repository_id', 'repository_identity'),
                           ('未知', 'taxonomy_or_fields'), ('Schema', 'schema'),
                           ('HTTP', 'provider_http'), ('网络', 'network'), ('超时', 'network')]:
        if fragment in text:
            return code
    return 'invalid_result'


def write_run(root, kind, at, client, model, attempted, accepted, failed, errors):
    meter = getattr(client, 'usage', None)
    if not isinstance(meter, UsageMeter):
        return  # Test/injected clients without observed transport cannot invent usage.
    try:
        from tools.star_rank import atomic_write_json
    except ModuleNotFoundError:  # direct script execution
        from star_rank import atomic_write_json
    record = {'version': 1, 'id': uuid.uuid4().hex, 'kind': kind, 'started_at': at,
              'finished_at': datetime.now(timezone.utc).isoformat(), 'model': model,
              'attempted_projects': len(attempted), 'accepted_projects': len(accepted),
              'failed_projects': len(failed),
              'failures': [{'repository_id': i, 'reason': failure_code(errors[i])} for i in sorted(failed)],
              **meter.summary(getattr(client, 'endpoint', None), model, at)}
    directory = (root / 'public' if (root / 'public').is_dir() else root) / 'enrichment-runs'
    validate_record(record)
    atomic_write_json(directory / 'history' / (record['id']+'.json'), record)
    latest_file = directory / 'latest.json'
    latest = json.loads(latest_file.read_text()) if latest_file.exists() else {'version': 1, 'runs': {}}
    latest['runs'][kind] = record
    atomic_write_json(latest_file, latest)

    summary_file = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary_file:
        cost = record['estimated_cost']
        cost_label = f"USD {cost['min']}–{cost['max']}（估算，非账单）" if cost else '未知（用量或价格不完整）'
        with open(summary_file, 'a', encoding='utf-8') as stream:
            stream.write(f"\n### {kind} 补全运行\n\n"
                         f"- 尝试 / 接受 / 失败项目：{len(attempted)} / {len(accepted)} / {len(failed)}\n"
                         f"- HTTP 请求：{meter.requests}；缺失用量：{record['unknown_usage_requests']}\n"
                         f"- 已观察输入 / 输出 Token：{meter.tokens['prompt_tokens']} / {meter.tokens['completion_tokens']}\n"
                         f"- 费用：{cost_label}\n"
                         f"- 记录：enrichment-runs/history/{record['id']}.json\n")


def validate_record(record):
    schema = json.loads((Path(__file__).resolve().parents[1] / 'schemas/star-rank/enrichment-run.schema.json').read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(record)
    if record['usage_responses'] + record['unknown_usage_requests'] != record['requests']:
        raise ValueError('补全用量请求计数不一致')
    if record['usage_complete'] != (record['unknown_usage_requests'] == 0):
        raise ValueError('补全用量完整性不一致')
    if record['accepted_projects'] + record['failed_projects'] != record['attempted_projects']:
        raise ValueError('补全项目计数不一致')
    if record['failed_projects'] != len(record['failures']) or len({v['repository_id'] for v in record['failures']}) != len(record['failures']):
        raise ValueError('补全失败项目计数不一致')
    if record['estimated_cost'] is not None and not record['usage_complete']:
        raise ValueError('未知用量不得计算完整费用')


def validate_history(public_dir):
    directory = public_dir / 'enrichment-runs'
    if not directory.exists():
        return
    latest = json.loads((directory / 'latest.json').read_text())
    if set(latest) != {'version', 'runs'} or latest['version'] != 1 or not isinstance(latest['runs'], dict) or not set(latest['runs']) <= {'localization', 'classification'}:
        raise ValueError('补全运行索引无效')
    for path in (directory / 'history').glob('*.json'):
        record = json.loads(path.read_text())
        validate_record(record)
        if record['id'] != path.stem:
            raise ValueError('补全运行记录 ID 不一致')
    for kind, record in latest['runs'].items():
        validate_record(record)
        if kind != record['kind'] or json.loads((directory / 'history' / (record['id']+'.json')).read_text()) != record:
            raise ValueError('最近补全运行与历史记录不一致')
