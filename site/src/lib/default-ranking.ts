import type { DailyRanking, EventDailyRanking, EventLiveRanking, EventRankingIndex, RankingIndex } from '../types';
import {
  readEventDailyRanking,
  readEventLiveRanking,
  readEventRankingIndex,
  readRankingIndex,
} from './data';

export interface DefaultRankingSelection {
  candidateIndex: RankingIndex;
  eventIndex: EventRankingIndex;
  ranking: DailyRanking | EventDailyRanking | EventLiveRanking | null;
  index: RankingIndex | EventRankingIndex;
  isEvent: boolean;
  isLive: boolean;
  fallbackNotice?: string;
}

function beijingDate(timestamp?: string | null): string | null {
  if (!timestamp) return null;
  const value = new Date(timestamp);
  if (Number.isNaN(value.valueOf())) return null;
  return new Date(value.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function readDefaultRanking(): DefaultRankingSelection {
  const candidateIndex = readRankingIndex();
  const eventIndex = readEventRankingIndex();
  const liveRanking = readEventLiveRanking();
  const eventRanking = eventIndex.latest_date ? readEventDailyRanking(eventIndex.latest_date) : null;
  // Once the verified 24-hour board has caught up with the provisional date,
  // that provisional file is historical residue rather than "today". This
  // data-only comparison keeps builds reproducible across machines and time.
  // The candidate pipeline normally publishes just after Beijing midnight. Its
  // timestamp acts as a data-owned day marker, preventing yesterday's final
  // provisional file from being relabelled as today's board during rollover.
  const currentDataDate = beijingDate(candidateIndex.updated_at);
  const liveIsNewer = Boolean(
    liveRanking
      && (!eventIndex.latest_date || liveRanking.date > eventIndex.latest_date)
      && (!currentDataDate || liveRanking.date >= currentDataDate),
  );
  const ranking = liveIsNewer ? liveRanking : eventRanking;
  const isEvent = Boolean(ranking);
  return {
    candidateIndex,
    eventIndex,
    ranking,
    index: eventIndex,
    isEvent,
    isLive: liveIsNewer,
    fallbackNotice: liveIsNewer ? undefined : eventRanking ? '今日实时榜尚未生成，当前展示最新的昨日完整榜。' : undefined,
  };
}
