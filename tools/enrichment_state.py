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
