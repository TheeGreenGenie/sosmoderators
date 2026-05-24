/**
 * Single source of truth for all Redis key names.
 * No raw string keys anywhere else in the codebase.
 */

export const Keys = {
  // User
  userTrust: (userId: string) => `user:${userId}:trust`,
  userActivity: (userId: string) => `user:${userId}:activity`,
  userGrace: (userId: string) => `user:${userId}:grace`,
  userAppealLog: (userId: string) => `user:${userId}:appeal_log`,
  userUsername: (userId: string) => `user:${userId}:username`,

  // Post / Content
  postReports: (postId: string) => `post:${postId}:reports`,
  postScore: (postId: string) => `post:${postId}:score`,
  cacheTitles: 'cache:titles',
  cacheDomains: 'cache:domains',
  cacheSelftextHashes: 'cache:selftext_hashes',

  // Aggregates
  aggPostsDaily: (date: string) => `agg:posts:daily:${date}`,
  aggReportsDaily: (date: string) => `agg:reports:daily:${date}`,
  aggToxicityDaily: (date: string) => `agg:toxicity:daily:${date}`,
  aggUsersDaily: (date: string) => `agg:users:daily:${date}`,
  aggTopics: (date: string) => `agg:topics:${date}`,
  leaderboardContributions: 'leaderboard:contributions',
  leaderboardTrust: 'leaderboard:trust',

  // Config
  subConfig: 'sub:config',
  killSwitch: 'sub:config:kill_switch',
  activePreset: 'sub:config:preset',
  raidMode: 'sub:raid_mode',

  // Dedup
  dedupTrigger: (eventId: string) => `dedup:trigger:${eventId}`,

  // Rate limiting
  rateLimit: (action: string, windowStart: number) => `ratelimit:${action}:${windowStart}`,
  rateLimitGlobal: (windowStart: number) => `ratelimit:global:${windowStart}`,
  rateLimitRetryQueue: 'ratelimit:retry_queue',

  // System
  redisUsageWarned: 'sys:redis:usage_warned',
  schemaVersion: 'schema:version',

  // Audit
  auditLog: 'audit:log',

  // AI Cache
  aiCacheAppeal: (hash: string) => `ai:cache:appeal:${hash}`,
  aiCacheContent: (hash: string) => `ai:cache:content:${hash}`,

  // Flair voting
  flairVote: (proposalId: string, userId: string) => `flair:vote:${proposalId}:${userId}`,
  flairVoteLock: (proposalId: string, userId: string) => `flair:vote:lock:${proposalId}:${userId}`,
  flairProposal: (proposalId: string) => `flair:proposal:${proposalId}`,
  flairProposalList: 'flair:proposals:active',
  flairVotesUp: (proposalId: string) => `flair:votes:up:${proposalId}`,
  flairVotesDown: (proposalId: string) => `flair:votes:down:${proposalId}`,
  flairSuggestion: (postId: string) => `flair:suggestion:${postId}`,

  // Contribution leaderboard (weekly, context-aware)
  leaderboardContributionsWeekly: (weekKey: string) => `leaderboard:contributions:weekly:${weekKey}`,
  contributionsProcessed: (weekKey: string) => `agg:contributions:processed:${weekKey}`,
  postScoreAvg: 'agg:post_score:avg',
  postAuthorId: (postId: string) => `post:${postId}:author_id`,

  // System singletons for managed posts
  weeklyHighlightPostId: 'sys:weekly_highlight:post_id',
  leaderboardPostId: 'sys:leaderboard:post_id',

  // Hourly spike tracking
  hourlyPostCount: (hourKey: string) => `spike:posts:${hourKey}`,
  hourlyNewUsers: (hourKey: string) => `spike:newusers:${hourKey}`,
  hourlyToxicitySum: (hourKey: string) => `spike:toxicity:${hourKey}`,
} as const;

/** Format a Date as YYYYMMDD for daily aggregate keys. */
export function dateKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** Format a Date as YYYYMMDDHH for hourly spike keys. */
export function hourKey(date: Date = new Date()): string {
  const h = String(date.getUTCHours()).padStart(2, '0');
  return `${dateKey(date)}${h}`;
}

/** Format the Monday of the current UTC week as YYYYMMDD, used for weekly contribution keys. */
export function weekKey(date: Date = new Date()): string {
  const day = date.getUTCDay(); // 0=Sun … 6=Sat
  const daysToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - daysToMonday);
  return dateKey(monday);
}

// ─── TypeScript interfaces for all stored JSON values ───────────────────────

export type TrustTier =
  | 'grace'
  | 'untrusted'
  | 'low'
  | 'neutral'
  | 'trusted'
  | 'highly_trusted';

export interface TrustComponents {
  accountAge: number;
  subKarma: number;
  approvalRate: number;
  positiveSignals: number;
  penalties: number;
  graceBonusActive: boolean;
}

export interface TrustScore {
  score: number;
  tier: TrustTier;
  components: TrustComponents;
  lastUpdated: number;
}

export interface ActivityCounters {
  totalSubPosts: number;
  approvedSubPosts: number;
  removedPosts: number;
  topPostCount: number;
  helpfulReportCount: number;
  actionedReportsAgainst: number;
  tempBanCount: number;
  permBanHistory: number;
  awardsReceived: number;
  proposedFlairsAdopted: number;
  lastActivityTs: number;
}

export interface SpamScore {
  score: number;
  signals: string[];
  computedAt: number;
}

export interface ReportEntry {
  reporterId: string;
  reporterTrust: number;
  reason: string;
  timestamp: number;
}

export interface ReportRecord {
  postId: string;
  reports: ReportEntry[];
  weightedCount: number;
  cibFlag: boolean;
  lastUpdated: number;
}

export interface FlairProposal {
  id: string;
  flair: string;
  proposedByUserId: string;
  proposedByUsername: string;
  createdAt: number;
  endsAt: number;
  status: 'active' | 'approved' | 'rejected' | 'superseded';
  postId: string;
  // Per-vote overrides set via modmail reply
  minVotes?: number;       // quorum — minimum total votes needed
  approvalPct?: number;    // 0–1, overrides global VOTE_APPROVAL_RATIO
  configConversationId?: string; // modmail conversation waiting for config reply
}

export interface FlairSuggestion {
  flair: string;
  commentId: string | null;
  suggestedAt: number;
  postAuthorId: string;
}

export interface AppealEntry {
  timestamp: number;
  summary: string;
  outcome: 'pending' | 'accepted' | 'rejected';
}

export interface AuditEntry {
  timestamp: number;
  action: string;
  targetId: string;
  targetType: 'post' | 'comment' | 'user' | 'config' | 'system';
  actor: string;
  reason: string;
  score?: number;
  override?: boolean;
}

export interface AntiRaidGate {
  enabled: boolean;
  limit?: number;
  minimum?: number;
}

export interface AntiRaidConfig {
  enabled: boolean;
  raidDurationHours: number;
  gates: {
    postsPerDay: AntiRaidGate & { limit: number };
    accountAgeDays: AntiRaidGate & { minimum: number };
    minKarma: AntiRaidGate & { minimum: number };
    minTrustScore: AntiRaidGate & { minimum: number };
  };
}

export interface SpamDetectionConfig {
  autoRemoveThreshold: number;
  autoFlagThreshold: number;
  repostWindowDays: number;
  bannedKeywords: string[];
  bannedDomains: string[];
}

export interface ReportHandlingConfig {
  autoActionThreshold: number;
  viewReportRatioThreshold: number;
  minViewsForRatioCheck: number;
}

export interface AIConfig {
  provider: 'heuristic' | 'llm';
  apiKeyConfigured: boolean;
  apiEndpoint?: string;
  apiKey?: string;
}

export interface SubConfig {
  antiRaid: AntiRaidConfig;
  spamDetection: SpamDetectionConfig;
  reportHandling: ReportHandlingConfig;
  ai: AIConfig;
  flairList: string[];
  flairVoting: {
    enabled: boolean;
    votingPeriodHours: number;
    minTrustToVote: number;
    approvalRatio: number;   // 0–1, global default (overridable per vote via modmail)
    minVotes: number;        // global quorum default
  };
  appeals: {
    cooldownDays: number;
  };
  features: {
    spamDetection: boolean;
    reportHandling: boolean;
    antiRaid: boolean;
    banEvasion: boolean;
    modmailRouting: boolean;
    trustScoring: boolean;
    flairAutoAssign: boolean;
    flairTitleTags: boolean;
    postRateLimit: boolean;
  };
  rateLimits: {
    removal: number;
    flair: number;
    modmail: number;
    reportAction: number;
    ban: number;
    global: number;
  };
}
