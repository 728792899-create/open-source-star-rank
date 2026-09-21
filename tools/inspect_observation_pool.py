#!/usr/bin/env python3
"""Read-only rollout report from recorded data; makes no GitHub/API requests."""
import argparse
import datetime as dt
import json
from pathlib import Path
from tools.star_rank import load_json, load_snapshot_history, observation_records, snapshot_pair_is_valid, recent_growth_by_repository, select_candidate_pool
from tools.observation_pool import select_observed, admission_limit


def inspect_pool(data_dir: Path):
    state = load_json(data_dir / 'state/candidates.json')
    candidates = state['candidates']
    history = load_snapshot_history(data_dir / 'snapshots')
    latest_day = max(history)
    latest = history[latest_day]
    previous = history.get(latest_day - dt.timedelta(days=1))
    current_ids = set(latest['repositories'])
    previous_ids = set((previous or {}).get('repositories', {}))
    leases = observation_records(candidates, history, latest_day + dt.timedelta(days=1))
    protected = {item['repository_id'] for item in leases if item['protected_until'] >= (latest_day + dt.timedelta(days=1)).isoformat()}
    directory = state.get('directory', candidates)
    ordered = select_candidate_pool(directory, recent_growth=recent_growth_by_repository(data_dir / 'snapshots', before=latest_day + dt.timedelta(days=1)), observed_date=(latest_day + dt.timedelta(days=1)).isoformat(), max_candidates=len(directory))
    capacity = state.get('observation_capacity', 2000)
    selected = select_observed(ordered, previous_ids={item['repository_id'] for item in candidates}, protected_ids=protected, capacity=capacity)
    return {
        'mode': 'offline-membership-plan-no-new-observations',
        'recorded_snapshot_date': latest_day.isoformat(),
        'recorded_observed_count': len(current_ids),
        'recorded_previous_observed_count': len(previous_ids),
        'recorded_added_count': len(current_ids - previous_ids) if previous else None,
        'recorded_removed_count': len(previous_ids - current_ids) if previous else None,
        'recorded_comparable_1d_count': len(current_ids & previous_ids) if previous and snapshot_pair_is_valid(previous, latest) else 0,
        'protected_for_next_capture': len(protected),
        'directory_count': len(directory), 'planned_observed_count': len(selected),
        'daily_admission_limit': admission_limit(capacity),
        'maximum_repository_refresh_requests': len(selected),
        'search_page_budget': 20,
        'budget_excludes': 'seed resolution and bounded retries; requests are not executed',
        'limitation': 'Membership planning only. Future availability, Stars, 7/30-day windows and production acceptance cannot be inferred.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect_pool(args.data_dir), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
