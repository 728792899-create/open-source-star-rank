export function freshnessState(updatedAt, thresholdHours = 36, now = Date.now()) {
  if (!updatedAt) return { status: 'initializing', ageHours: null };
  const updated = new Date(updatedAt).getTime();
  const current = typeof now === 'number' ? now : new Date(now).getTime();
  const ageHours = (current - updated) / 3_600_000;
  if (!Number.isFinite(ageHours)) return { status: 'stale', ageHours: null };
  return {
    status: ageHours > thresholdHours ? 'stale' : 'fresh',
    ageHours: Math.max(0, ageHours),
  };
}
