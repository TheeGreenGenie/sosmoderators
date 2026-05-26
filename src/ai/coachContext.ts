import type { RedisClient } from '@devvit/public-api';
import type { SubConfig, AuditEntry } from '../redis/schema.js';
import { Keys, dateKey, hourKey } from '../redis/schema.js';
import { getConfig } from '../redis/config.js';
import { getAuditLog } from '../moderation/auditLog.js';

export interface CoachTrustUser {
  userId: string;
  username: string;
  score: number;
}

export interface CoachContext {
  subredditName: string;
  config: SubConfig;
  preset: string;
  killSwitchActive: boolean;
  raidModeActive: boolean;
  lastBuilt: string | null;
  todayStats: {
    posts: number;
    removed: number;
    flagged: number;
    approved: number;
  };
  weekAvgStats: {
    postsPerDay: number;
    removalsPerDay: number;
    flagsPerDay: number;
  };
  auditLog: AuditEntry[];
  topTrustUsers: CoachTrustUser[];
  hourlyPostCounts: number[];   // 4 values, oldest first (hours: -3, -2, -1, now)
  redisUsagePct: number;
}

export async function buildCoachContext(
  redis: RedisClient,
  subredditName: string,
): Promise<CoachContext> {
  const now = new Date();
  const today = dateKey(now);

  // Build last 4 hour keys: [3h ago, 2h ago, 1h ago, now]
  const hourKeys = Array.from({ length: 4 }, (_, i) => {
    const d = new Date(now.getTime() - (3 - i) * 3_600_000);
    return hourKey(d);
  });

  const [
    config,
    killSwitch,
    preset,
    raidModeRaw,
    lastBuilt,
    postsToday,
    removedToday,
    flaggedToday,
    approvedToday,
    avgTotal,
    avgRemoved,
    avgFlagged,
    redisUsageRaw,
  ] = await Promise.all([
    getConfig(redis),
    redis.get(Keys.killSwitch),
    redis.get(Keys.activePreset),
    redis.get(Keys.raidMode),
    redis.get('agg:last_built'),
    redis.hGet(Keys.aggPostsDaily(today), 'total'),
    redis.hGet(Keys.aggPostsDaily(today), 'removed'),
    redis.hGet(Keys.aggPostsDaily(today), 'flagged'),
    redis.hGet(Keys.aggPostsDaily(today), 'approved'),
    redis.hGet('agg:posts:7d_avg', 'total'),
    redis.hGet('agg:posts:7d_avg', 'removed'),
    redis.hGet('agg:posts:7d_avg', 'flagged'),
    redis.get('sys:redis:usage_pct'),
  ]);

  // Fetch hourly counts and audit log in parallel
  const [hourlyCounts, auditLog, topTrustRaw] = await Promise.all([
    Promise.all(hourKeys.map((hk) => redis.get(Keys.hourlyPostCount(hk)))),
    getAuditLog(redis, 0, 50),
    redis.zRange(Keys.leaderboardTrust, 0, 9, { by: 'rank', reverse: true }),
  ]);

  // Resolve usernames for top trust users
  const topTrustUsers: CoachTrustUser[] = await Promise.all(
    topTrustRaw
      .filter((m) => m.member.startsWith('t2_'))
      .slice(0, 5)
      .map(async (m) => ({
        userId: m.member,
        username: (await redis.get(Keys.userUsername(m.member))) ?? m.member,
        score: Math.round(m.score),
      })),
  );

  return {
    subredditName,
    config,
    preset: preset ?? 'default',
    killSwitchActive: killSwitch === '1',
    raidModeActive: !!raidModeRaw,
    lastBuilt: lastBuilt ? new Date(parseInt(lastBuilt)).toUTCString() : null,
    todayStats: {
      posts: parseInt(postsToday ?? '0'),
      removed: parseInt(removedToday ?? '0'),
      flagged: parseInt(flaggedToday ?? '0'),
      approved: parseInt(approvedToday ?? '0'),
    },
    weekAvgStats: {
      postsPerDay: parseInt(avgTotal ?? '0'),
      removalsPerDay: parseInt(avgRemoved ?? '0'),
      flagsPerDay: parseInt(avgFlagged ?? '0'),
    },
    auditLog,
    topTrustUsers,
    hourlyPostCounts: hourlyCounts.map((c) => parseInt(c ?? '0')),
    redisUsagePct: parseInt(redisUsageRaw ?? '0'),
  };
}
