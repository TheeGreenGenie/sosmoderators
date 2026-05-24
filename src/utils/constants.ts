export const SCHEMA_VERSION = 3;

export const REDIS_CAP_MB = 500;

export const TRUST = {
  GRACE_POST_THRESHOLD: 5,
  MIN: 0,
  MAX: 1000,
  TIER_UNTRUSTED_MAX: 149,
  TIER_LOW_MAX: 299,
  TIER_NEUTRAL_MAX: 499,
  TIER_TRUSTED_MAX: 699,
  DECAY_INACTIVE_DAYS: 90,
  DECAY_RATE: 0.05,
  DECAY_FLOOR_TRUSTED: 300,
} as const;

export const RATE_LIMITS = {
  REMOVAL: { limit: 30, windowMs: 60_000 },
  FLAIR: { limit: 60, windowMs: 60_000 },
  MODMAIL: { limit: 10, windowMs: 60_000 },
  REPORT_ACTION: { limit: 20, windowMs: 60_000 },
  BAN: { limit: 5, windowMs: 300_000 },
  GLOBAL: { limit: 150, windowMs: 60_000 },
} as const;

export const RATE_LIMIT_RETRY_MAX = 3;
export const RATE_LIMIT_SATURATION_ALERT_MS = 5 * 60_000;

export const DEDUP_TTL_SECONDS = 60;

export const REDIS_MONITOR = {
  WARNING_THRESHOLD: 0.8,
  CRITICAL_THRESHOLD: 0.9,
  WARNING_COOLDOWN_SECONDS: 86_400,
} as const;

export const CIB = {
  // PostReport doesn't expose reporter identity, so CIB is detected by burst
  // pattern. If viewCount is available, a high report/view ratio means organic
  // community response (not CIB). A low ratio + burst = coordinated attack.
  // If viewCount = 0 (new posts, test posts), burst alone is sufficient.
  MIN_BURST_COUNT: 3,
  BURST_WINDOW_MS: 5 * 60_000,
  // Above this ratio (e.g. 10% of viewers reported it), treat as organic — not CIB.
  ORGANIC_REPORT_RATIO: 0.10,
} as const;

export const APPEAL = {
  COOLDOWN_DAYS: 30,
  LOG_MAX_ENTRIES: 10,
} as const;

export const AGGREGATE_JOB_INTERVAL_MIN = 15;
export const SPIKE_ALERT_MULTIPLIER = 2.5;
export const AUDIT_LOG_MAX_ENTRIES = 1000;

export const BAN_EVASION = {
  MAX_LEVENSHTEIN: 2,
  NEW_ACCOUNT_DAYS: 7,
  POST_WITHIN_BAN_HOURS: 1,
} as const;

export const FLAIR_CONFIDENCE = {
  AUTO_APPLY: 0.8,
  SUGGEST: 0.4,
} as const;

export const VOTE_APPROVAL_RATIO = 0.6;
