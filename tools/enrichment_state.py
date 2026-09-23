"""Keep enrichment failures scoped to current pending repository identities."""
from typing import Any, Mapping


def failure_state(
    previous: Mapping[str, Any] | None,
    pending_ids: set[int],
    attempted_ids: set[int],
    failed_ids: set[int],
) -> tuple[int, dict[str, list[int]]]:
    previous = previous or {}
    previous_count = int(previous.get("coverage", {}).get("failed_count", 0))
    known_ids = previous.get("failed_repository_ids")
    if known_ids is not None or previous_count == 0 or attempted_ids or not pending_ids:
        # The first online pass migrates legacy counts to observed identities.
        # Unidentified historical failures remain pending, not counted twice.
        remaining = ((set(known_ids or []) - attempted_ids) | failed_ids) & pending_ids
        return len(remaining), {"failed_repository_ids": sorted(remaining)}
    # Old catalogs have no identities. Do not fabricate them or exceed current
    # pending work; an online pass over the remaining projects resolves this.
    return min(previous_count, len(pending_ids)), {}


class RetryQueue:
    """Persistent bounded retry order; offline reconciliation only prunes resolved work."""
    def __init__(self, root, kind, now, fingerprints=None):
        import json
        from datetime import datetime
        self.path = root / 'state' / 'enrichment-queue' / (kind + '.json')
        self.now = datetime.fromisoformat(now.replace('Z', '+00:00')).timestamp()
        self.items = json.loads(self.path.read_text()).get('items', {}) if self.path.exists() else {}
        self.fingerprints = {str(key): value for key, value in (fingerprints or {}).items()}
        if fingerprints is not None:
            self.items = {key: value for key, value in self.items.items() if value.get('source_hash') == self.fingerprints.get(key)}

    def select(self, pending, limit):
        # Untouched projects preserve the existing business priority. Previously tried
        # projects rotate by last attempt, so a permanently failing batch cannot starve the queue.
        eligible = [item for item in pending if self.items.get(str(item['repository_id']), {}).get('retry_at', 0) <= self.now]
        eligible.sort(key=lambda item: self.items.get(str(item['repository_id']), {}).get('last_attempt', 0))
        return eligible[:limit]

    def save(self, pending_ids, attempted_ids, failed_ids):
        import json
        import os
        import tempfile
        self.items = {key: value for key, value in self.items.items() if int(key) in pending_ids}
        for repository_id in attempted_ids & pending_ids:
            key = str(repository_id)
            failures = min(8, self.items.get(key, {}).get('failures', 0) + 1) if repository_id in failed_ids else 0
            self.items[key] = {
                'source_hash': self.fingerprints.get(key),
                'last_attempt': self.now,
                'failures': failures,
                'retry_at': self.now + min(86400, 3600 * 2 ** max(0, failures - 1)),
            }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, filename = tempfile.mkstemp(dir=self.path.parent, prefix='.queue-')
        try:
            with os.fdopen(fd, 'w') as handle:
                json.dump({'version': 1, 'items': self.items}, handle, sort_keys=True)
                handle.write('\n')
            os.replace(filename, self.path)
        finally:
            if os.path.exists(filename):
                os.unlink(filename)
