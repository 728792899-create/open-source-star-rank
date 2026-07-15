export interface CollectionMetrics {
  search_result_counts: {
    recent_created: number;
    recent_active: number;
    established_active: number;
  };
  unique_discovered_count: number;
  candidate_added_count: number;
  candidate_removed_count: number;
  api_request_count: number;
  api_retry_count: number;
  snapshot_expected_count: number;
  snapshot_complete_count: number;
  snapshot_completeness: number;
}

export interface RankingIndex {
  schema_version: string;
  status: 'initializing' | 'ready';
  timezone: string;
  updated_at: string | null;
  latest_date: string | null;
  available_dates: string[];
  candidate_count: number;
  methodology_version: string;
  freshness_threshold_hours: number;
  latest_collection: CollectionMetrics | null;
  sampling?: SamplingState;
  periods?: Record<'7d' | '30d', PeriodAvailability>;
}

export interface SamplingState {
  target_local_time: '00:20';
  valid_window_start: '00:00';
  valid_window_end: '03:00';
  latest_snapshot_at: string | null;
  latest_snapshot_valid: boolean;
  latest_snapshot_reason: 'missing' | 'within_window' | 'outside_window';
  latest_valid_snapshot_at: string | null;
  consecutive_valid_snapshots: number;
  next_scheduled_at: string | null;
  expected_first_ranking_at: string | null;
  period_progress: Record<'7d' | '30d', { completed: number; required: number }>;
}

export interface PeriodAvailability {
  latest_date: string | null;
  available_dates: string[];
}

export interface WindowQuality {
  duration_minutes: number;
  valid_for_ranking: boolean;
  reason: string;
}

export interface RankingEntry {
  repository_id: number;
  full_name: string;
  description: string | null;
  language: string | null;
  stars_total: number;
  stars_gained: number;
  rank: number;
  rank_change: number | null;
  trend_7d: Array<number | null>;
  html_url: string;
  owner_avatar_url: string | null;
  knowledge_url: string | null;
}

export interface DailyRanking {
  schema_version: string;
  date: string;
  timezone: string;
  window_start: string;
  window_end: string;
  window_quality?: WindowQuality;
  candidate_count: number;
  eligible_count: number;
  collection: CollectionMetrics;
  entries: RankingEntry[];
}

export interface PeriodRanking extends DailyRanking {
  period_days: 7 | 30;
  window_quality: WindowQuality;
}

export interface LanguageRanking extends DailyRanking {
  language: string;
  slug: string;
  window_quality: WindowQuality;
}

export interface LanguageSummary {
  language: string;
  slug: string;
  candidate_count: number;
  latest_date: string | null;
  available_dates: string[];
  status: 'accumulating' | 'ready';
}

export interface LanguageIndex {
  schema_version: string;
  updated_at: string;
  timezone: string;
  languages: LanguageSummary[];
}

export interface RepositoryHistoryPoint {
  date: string;
  stars_total: number | null;
  stars_gained: number | null;
  rank: number | null;
}

export interface RepositoryDetail {
  repository_id: number;
  full_name: string;
  description: string | null;
  language: string | null;
  stars_total: number;
  html_url: string;
  owner_avatar_url: string | null;
  knowledge_url: string | null;
  first_seen_date: string | null;
  last_seen_date: string | null;
  history_30d: RepositoryHistoryPoint[];
}

export interface RepositoryCatalog {
  schema_version: string;
  updated_at: string;
  timezone: string;
  candidate_count: number;
  repositories: RepositoryDetail[];
}

export interface EventSourceMetrics {
  provider: 'gh_archive_bigquery';
  dataset: 'githubarchive.day';
  table_dates: string[];
  estimated_bytes: number;
  bytes_processed: number;
  maximum_bytes_billed: number;
  observed_watch_event_count: number;
  observed_repository_count: number;
  metadata_attempted_count: number;
  metadata_success_count: number;
  metadata_not_found_count: number;
  metadata_filtered_count: number;
  api_request_count: number;
  api_retry_count: number;
}

export interface EventRankingIndex {
  schema_version: '1.0.0';
  status: 'initializing' | 'ready';
  timezone: 'Asia/Shanghai';
  updated_at: string | null;
  latest_date: string | null;
  available_dates: string[];
  methodology_version: 'gharchive-public-watch-events-v1';
  freshness_threshold_hours: 36;
  latest_source_metrics: EventSourceMetrics | null;
}

export interface EventRankingEntry {
  repository_id: number;
  full_name: string;
  description: string | null;
  language: string | null;
  stars_total: number;
  stars_added: number;
  watch_events: number;
  rank: number;
  rank_change: number | null;
  trend_7d: Array<number | null>;
  html_url: string;
  owner_avatar_url: string | null;
}

export interface EventDailyRanking {
  schema_version: '1.0.0';
  date: string;
  timezone: 'Asia/Shanghai';
  window_start: string;
  window_end: string;
  generated_at: string;
  methodology_version: 'gharchive-public-watch-events-v1';
  source_metrics: EventSourceMetrics;
  eligible_count: number;
  entries: EventRankingEntry[];
}
