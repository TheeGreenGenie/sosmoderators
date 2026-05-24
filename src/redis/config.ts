import type { RedisClient } from '@devvit/public-api';
import type { SubConfig, AntiRaidConfig, SpamDetectionConfig, ReportHandlingConfig } from './schema.js';
import { Keys } from './schema.js';

export const DEFAULT_CONFIG: SubConfig = {
  antiRaid: {
    enabled: false,
    raidDurationHours: 24,
    gates: {
      postsPerDay: { enabled: false, limit: 5 },
      accountAgeDays: { enabled: false, minimum: 30 },
      minKarma: { enabled: false, minimum: 100 },
      minTrustScore: { enabled: false, minimum: 200 },
    },
  },
  spamDetection: {
    autoRemoveThreshold: 0.85,
    autoFlagThreshold: 0.65,
    repostWindowDays: 30,
    bannedKeywords: [],
    bannedDomains: [],
  },
  reportHandling: {
    autoActionThreshold: 5,
    viewReportRatioThreshold: 0.3,
    minViewsForRatioCheck: 100,
  },
  ai: {
    provider: 'heuristic',
    apiKeyConfigured: false,
  },
  flairList: [],
  flairVoting: {
    enabled: false,
    votingPeriodHours: 48,
    minTrustToVote: 300,
    approvalRatio: 0.6,
    minVotes: 0,
  },
  appeals: {
    cooldownDays: 30,
  },
  features: {
    spamDetection: true,
    reportHandling: true,
    antiRaid: true,
    banEvasion: true,
    modmailRouting: true,
    trustScoring: true,
    flairAutoAssign: true,
    flairTitleTags: false,
    postRateLimit: true,
  },
  rateLimits: {
    removal: 30,
    flair: 60,
    modmail: 10,
    reportAction: 20,
    ban: 5,
    global: 150,
  },
};

const STRICT_OVERRIDES: Partial<{
  antiRaid: Partial<AntiRaidConfig>;
  spamDetection: Partial<SpamDetectionConfig>;
  reportHandling: Partial<ReportHandlingConfig>;
}> = {
  antiRaid: {
    enabled: true,
    gates: {
      postsPerDay: { enabled: true, limit: 3 },
      accountAgeDays: { enabled: true, minimum: 90 },
      minKarma: { enabled: true, minimum: 500 },
      minTrustScore: { enabled: true, minimum: 300 },
    },
  },
  spamDetection: {
    autoRemoveThreshold: 0.7,
    autoFlagThreshold: 0.5,
  },
  reportHandling: {
    autoActionThreshold: 3,
    viewReportRatioThreshold: 0.2,
    minViewsForRatioCheck: 50,
  },
};

const RAID_OVERRIDES: Partial<{
  antiRaid: Partial<AntiRaidConfig>;
  spamDetection: Partial<SpamDetectionConfig>;
  reportHandling: Partial<ReportHandlingConfig>;
}> = {
  antiRaid: {
    enabled: true,
    gates: {
      postsPerDay: { enabled: true, limit: 1 },
      accountAgeDays: { enabled: true, minimum: 180 },
      minKarma: { enabled: true, minimum: 1000 },
      minTrustScore: { enabled: true, minimum: 400 },
    },
  },
  spamDetection: {
    autoRemoveThreshold: 0.6,
    autoFlagThreshold: 0.4,
  },
  reportHandling: {
    autoActionThreshold: 2,
    viewReportRatioThreshold: 0.15,
    minViewsForRatioCheck: 25,
  },
};

export type PresetName = 'default' | 'strict' | 'raid';

export function buildPreset(name: PresetName): SubConfig {
  if (name === 'strict') {
    return mergeWithOverrides(DEFAULT_CONFIG, STRICT_OVERRIDES);
  }
  if (name === 'raid') {
    return mergeWithOverrides(DEFAULT_CONFIG, RAID_OVERRIDES);
  }
  return { ...DEFAULT_CONFIG };
}

export function mergeWithOverrides(
  base: SubConfig,
  overrides: Partial<{
    antiRaid: Partial<AntiRaidConfig>;
    spamDetection: Partial<SpamDetectionConfig>;
    reportHandling: Partial<ReportHandlingConfig>;
  }>
): SubConfig {
  return {
    ...base,
    antiRaid: overrides.antiRaid
      ? { ...base.antiRaid, ...overrides.antiRaid, gates: overrides.antiRaid.gates ?? base.antiRaid.gates }
      : base.antiRaid,
    spamDetection: overrides.spamDetection
      ? { ...base.spamDetection, ...overrides.spamDetection }
      : base.spamDetection,
    reportHandling: overrides.reportHandling
      ? { ...base.reportHandling, ...overrides.reportHandling }
      : base.reportHandling,
  };
}

export async function getConfig(redis: RedisClient): Promise<SubConfig> {
  const raw = await redis.get(Keys.subConfig);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const stored = JSON.parse(raw) as SubConfig;
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      features: { ...DEFAULT_CONFIG.features, ...stored.features },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function setConfig(redis: RedisClient, config: SubConfig): Promise<void> {
  await redis.set(Keys.subConfig, JSON.stringify(config));
}

export async function getActivePreset(redis: RedisClient): Promise<PresetName> {
  const val = await redis.get(Keys.activePreset);
  if (val === 'strict' || val === 'raid') return val;
  return 'default';
}

export async function setPreset(redis: RedisClient, name: PresetName): Promise<void> {
  const config = buildPreset(name);
  await Promise.all([
    redis.set(Keys.subConfig, JSON.stringify(config)),
    redis.set(Keys.activePreset, name),
  ]);
}
