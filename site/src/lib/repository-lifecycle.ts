const SHANGHAI_OFFSET = '+08:00';

// This module is used only by Astro's static rendering. Freeze one build clock;
// browser freshness/countdown scripts continue to use the visitor's real clock.
const buildTimestamp = (() => {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch === undefined) return Date.now();
  const seconds = Number(epoch);
  const timestamp = seconds * 1000;
  if (!/^\d+$/u.test(epoch) || !Number.isSafeInteger(seconds) || !Number.isFinite(new Date(timestamp).getTime())) {
    throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer timestamp in seconds within the Date range');
  }
  return timestamp;
})();

export const repositoryOwner = (fullName: string) => fullName.split('/', 1)[0] || fullName;

export const repositoryDate = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
};

export const repositoryAgeDays = (createdAt?: string | null, now = new Date(buildTimestamp)) => {
  if (!createdAt) return null;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const day = (date: Date) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  const start = new Date(`${day(created)}T00:00:00${SHANGHAI_OFFSET}`);
  const end = new Date(`${day(now)}T00:00:00${SHANGHAI_OFFSET}`);
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000));
};

export const repositoryAgeLabel = (createdAt?: string | null, now = new Date(buildTimestamp)) => {
  const days = repositoryAgeDays(createdAt, now);
  if (days === null) return '发布天数待补充';
  if (days === 0) return '今天发布';
  return `已发布 ${new Intl.NumberFormat('zh-CN').format(days)} 天`;
};

