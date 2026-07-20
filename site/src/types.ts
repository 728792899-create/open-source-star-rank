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
  ranking_limit?: number;
  page_size?: number;
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
  ranking_limit?: number;
  entry_count?: number;
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
  scope?: 'github_public_events_as_archived_by_gh_archive';
  counting_unit?: 'unique_actor_repository_pair';
  table_dates: string[];
  expected_hour_count?: 24;
  observed_hour_count?: number;
  missing_hours?: string[];
  estimated_bytes: number;
  bytes_processed: number;
  maximum_bytes_billed: number;
  unique_star_addition_count?: number;
  observed_watch_event_count: number;
  observed_repository_count: number;
  ranking_complete?: true;
  metadata_attempted_count: number;
  metadata_success_count: number;
  metadata_not_found_count: number;
  metadata_filtered_count: number;
  api_request_count: number;
  api_retry_count: number;
  quality_baseline_days?: number;
  watch_event_count_median?: number | null;
  unique_addition_count_median?: number | null;
  watch_event_count_ratio?: number | null;
  unique_addition_count_ratio?: number | null;
  quality_status?: 'calibrating' | 'passed';
}

export interface EventRankingIndex {
  schema_version: '1.0.0' | '1.1.0' | '1.2.0';
  status: 'initializing' | 'ready';
  timezone: 'Asia/Shanghai';
  updated_at: string | null;
  latest_date: string | null;
  available_dates: string[];
  methodology_version: 'gharchive-public-watch-events-v1' | 'gharchive-public-watch-events-v2' | 'gharchive-public-watch-events-v3';
  freshness_threshold_hours: 36;
  latest_source_metrics: EventSourceMetrics | null;
  ranking_limit?: number;
  page_size?: number;
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
  schema_version: '1.0.0' | '1.1.0' | '1.2.0';
  date: string;
  timezone: 'Asia/Shanghai';
  window_start: string;
  window_end: string;
  generated_at: string;
  methodology_version: 'gharchive-public-watch-events-v1' | 'gharchive-public-watch-events-v2' | 'gharchive-public-watch-events-v3';
  source_metrics: EventSourceMetrics;
  eligible_count: number;
  entries: EventRankingEntry[];
  ranking_limit?: number;
  entry_count?: number;
}

export interface EventCategoryPoolEntry {
  repository_id: number;
  full_name: string;
  description: string | null;
  language: string | null;
  stars_total: number;
  stars_added: number;
  watch_events: number;
  rank: number;
  trend_7d?: Array<number | null>;
  html_url: string;
  owner_avatar_url: string | null;
}

export interface EventCategoryPool {
  schema_version: '1.0.0' | '1.1.0';
  date: string;
  timezone: 'Asia/Shanghai';
  window_start: string;
  window_end: string;
  generated_at: string;
  methodology_version: 'gharchive-public-watch-events-v1' | 'gharchive-public-watch-events-v2' | 'gharchive-public-watch-events-v3';
  pool_size: number;
  entries: EventCategoryPoolEntry[];
}

export interface ExplorationPool {
  schema_version: '1.0.0';
  board_kind: 'candidate_daily' | 'candidate_period_7d' | 'candidate_period_30d';
  date: string;
  timezone: 'Asia/Shanghai';
  window_start: string;
  window_end: string;
  pool_size: number;
  entries: RankingEntry[];
}

export interface AllTimeEntry {
  repository_id: number;
  full_name: string;
  description: string | null;
  language: string | null;
  stars_total: number;
  rank: number;
  html_url: string;
  owner_avatar_url: string | null;
}

export interface AllTimeSourceMetrics {
  provider: 'github_search';
  sort: 'stars';
  minimum_stars: number;
  search_result_count: number;
  api_request_count: number;
  api_retry_count: number;
}

export interface AllTimeBoard {
  schema_version: '1.0.0';
  generated_at: string;
  methodology_version: 'github-search-most-starred-v1';
  source_metrics: AllTimeSourceMetrics;
  entry_count: number;
  entries: AllTimeEntry[];
}

export interface AllTimeIndex {
  schema_version: '1.0.0';
  status: 'initializing' | 'ready';
  updated_at: string | null;
  methodology_version: 'github-search-most-starred-v1';
  entry_count: number;
  top_stars: number | null;
  freshness_threshold_hours: number;
}

export type FacetDimension = 'language' | 'category' | 'type' | 'scenario';

export interface LocalizationCoverage {
  eligible_count: number;
  localized_count: number;
  pending_count: number;
  failed_count: number;
  coverage_ratio: number;
}

export interface RepositoryLocalization {
  repository_id: number;
  source_full_name: string;
  source_hash: string;
  display_name_zh: string;
  description_zh: string | null;
  generated_at: string;
  provenance: 'github_models' | 'manual';
}

export interface LocalizationCatalog {
  schema_version: '1.0.0';
  locale: 'zh-CN';
  generated_at: string | null;
  model: string;
  prompt_version: 'repository-localization-v1';
  coverage: LocalizationCoverage;
  repositories: RepositoryLocalization[];
}

export interface ClassificationTerm {
  id: string;
  label: string;
}

export interface ClassificationCoverage {
  eligible_count: number;
  classified_count: number;
  pending_count: number;
  failed_count: number;
  coverage_ratio: number;
}

export interface ClassificationIndex {
  schema_version: '1.0.0';
  taxonomy_version: '1.0.0';
  locale: 'zh-CN';
  generated_at: string | null;
  model: string;
  prompt_version: 'repository-classification-v1';
  coverage: ClassificationCoverage;
  categories: ClassificationTerm[];
  project_types: ClassificationTerm[];
  use_cases: ClassificationTerm[];
}

export interface RepositoryClassification {
  repository_id: number;
  source_full_name: string;
  source_hash: string;
  primary_category: string;
  project_type: string;
  use_cases: string[];
  taxonomy_version: '1.0.0';
  generated_at: string;
  provenance: 'github_models' | 'manual';
}

export interface ClassificationRepositoryCatalog {
  schema_version: '1.0.0';
  taxonomy_version: '1.0.0';
  generated_at: string | null;
  repositories: RepositoryClassification[];
}

export interface EventHistoryPoint {
  date: string;
  stars_added: number;
  rank: number;
}

export interface RepositoryProfile {
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
  event_history: EventHistoryPoint[];
  all_time_rank: number | null;
}
