"""Bounded discovery and observation policies; no network or persistence."""
from __future__ import annotations

DIRECTORY_LIMIT = 5000
PROTECTION_DAYS = 30


def admission_limit(capacity: int) -> int:
    return max(1, capacity // 20)


def select_observed(ordered, *, previous_ids, protected_ids, capacity, allow_admission=True):
    """Keep leases and pinned incumbents; rotate at most 5% of a nonempty pool.

    Initial bootstrap may fill capacity. New pins queue like other newcomers
    when all incumbent slots are protected. Reducing capacity is explicit error.
    """
    incumbents = [item for item in ordered if item['repository_id'] in previous_ids]
    if len(incumbents) > capacity:
        raise ValueError('观察池容量小于现有成员数；请先制定显式缩容迁移')
    newcomers = [item for item in ordered if item['repository_id'] not in previous_ids]
    if not previous_ids:
        return newcomers[:capacity]
    mandatory = [item for item in incumbents if item['repository_id'] in protected_ids or item.get('pinned')]
    mandatory_ids = {item['repository_id'] for item in mandatory}
    replaceable = [item for item in incumbents if item['repository_id'] not in mandatory_ids]
    admitted = newcomers[:min(admission_limit(capacity), capacity - len(mandatory)) if allow_admission else 0]
    return mandatory + replaceable[:capacity - len(mandatory) - len(admitted)] + admitted


def select_directory(records, observed, *, limit=DIRECTORY_LIMIT):
    observed_ids = {item['repository_id'] for item in observed}
    waiting = [item for item in records if item['repository_id'] not in observed_ids
               and not any(item.get(key) for key in ('fork', 'archived', 'disabled'))]
    waiting.sort(key=lambda item: (item['last_refreshed_date'], bool(item.get('pinned')),
                                  item['stars_total'], -item['repository_id']), reverse=True)
    return sorted([*observed, *waiting[:max(0, limit - len(observed))]],
                  key=lambda item: item['full_name'].casefold())
