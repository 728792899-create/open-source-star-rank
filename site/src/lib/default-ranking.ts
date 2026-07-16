import type { DailyRanking, EventDailyRanking, EventRankingIndex, RankingIndex } from '../types';
import {
  eventRankingIsFresh,
  readDailyRanking,
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
  const candidateRanking = candidateIndex.latest_date ? readDailyRanking(candidateIndex.latest_date) : null;
  const eventFresh = eventRankingIsFresh(eventIndex, candidateIndex);
  const eventRanking = eventFresh && eventIndex.latest_date ? readEventDailyRanking(eventIndex.latest_date) : null;
  const ranking = eventRanking ?? candidateRanking;
  const isEvent = Boolean(eventRanking);
  const fallbackNotice = !isEvent && candidateRanking
    ? eventIndex.status === 'ready'
      ? '公共事件榜已超过 36 小时未更新，首页已自动回退到候选池净增榜。'
      : '公共事件榜尚未完成首次采集，当前展示候选池净增榜。'
    : undefined;
  return {
    candidateIndex,
    eventIndex,
    ranking,
    index: isEvent ? eventIndex : candidateIndex,
    isEvent,
    fallbackNotice,
  };
}
