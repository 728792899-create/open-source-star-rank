import type { DailyRanking, EventDailyRanking, EventRankingIndex, RankingIndex } from '../types';
import {
  readEventDailyRanking,
  readEventRankingIndex,
  readRankingIndex,
} from './data';

export interface DefaultRankingSelection {
  candidateIndex: RankingIndex;
  eventIndex: EventRankingIndex;
  ranking: DailyRanking | EventDailyRanking | null;
  index: RankingIndex | EventRankingIndex;
  isEvent: boolean;
  fallbackNotice?: string;
}

export function readDefaultRanking(): DefaultRankingSelection {
  const candidateIndex = readRankingIndex();
  const eventIndex = readEventRankingIndex();
  const eventRanking = eventIndex.latest_date ? readEventDailyRanking(eventIndex.latest_date) : null;
  const ranking = eventRanking;
  const isEvent = Boolean(eventRanking);
  return {
    candidateIndex,
    eventIndex,
    ranking,
    index: eventIndex,
    isEvent,
  };
}
