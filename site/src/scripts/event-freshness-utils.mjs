export function eventRankingIsFresh(eventIndex, candidateIndex) {
  if (eventIndex?.status !== 'ready' || !eventIndex.updated_at || !eventIndex.latest_date) return false;
  if (!candidateIndex?.updated_at) return true;
  const reference = new Date(candidateIndex.updated_at).getTime();
  const updated = new Date(eventIndex.updated_at).getTime();
  if (!Number.isFinite(reference) || !Number.isFinite(updated)) return false;
  return reference - updated <= eventIndex.freshness_threshold_hours * 60 * 60 * 1000;
}
