import type { RedisClient } from '@devvit/public-api';
import type { TrustScore, ActivityCounters, AppealEntry } from './schema.js';
import { Keys } from './schema.js';
import { APPEAL, TRUST } from '../utils/constants.js';

const DEFAULT_ACTIVITY: ActivityCounters = {
  totalSubPosts: 0,
  approvedSubPosts: 0,
  removedPosts: 0,
  topPostCount: 0,
  helpfulReportCount: 0,
  actionedReportsAgainst: 0,
  tempBanCount: 0,
  permBanHistory: 0,
  awardsReceived: 0,
  proposedFlairsAdopted: 0,
  lastActivityTs: 0,
};

export async function getTrustScore(redis: RedisClient, userId: string): Promise<TrustScore | null> {
  const raw = await redis.get(Keys.userTrust(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TrustScore;
  } catch {
    return null;
  }
}

export async function setTrustScore(redis: RedisClient, userId: string, score: TrustScore): Promise<void> {
  await redis.set(Keys.userTrust(userId), JSON.stringify(score));
  await redis.zAdd(Keys.leaderboardTrust, { score: score.score, member: userId });
}

export async function getActivity(redis: RedisClient, userId: string): Promise<ActivityCounters> {
  const raw = await redis.get(Keys.userActivity(userId));
  if (!raw) return { ...DEFAULT_ACTIVITY };
  try {
    return JSON.parse(raw) as ActivityCounters;
  } catch {
    return { ...DEFAULT_ACTIVITY };
  }
}

export async function updateActivity(
  redis: RedisClient,
  userId: string,
  patch: Partial<ActivityCounters>
): Promise<ActivityCounters> {
  const current = await getActivity(redis, userId);
  const updated: ActivityCounters = {
    ...current,
    ...patch,
    lastActivityTs: Date.now(),
  };
  // Rolling 90-day TTL, refreshed on each activity
  await redis.set(Keys.userActivity(userId), JSON.stringify(updated), {
    expiration: new Date(Date.now() + 90 * 86_400 * 1000),
  });
  return updated;
}

export async function isInGrace(redis: RedisClient, userId: string): Promise<boolean> {
  const val = await redis.get(Keys.userGrace(userId));
  return val === '1';
}

export async function setGrace(redis: RedisClient, userId: string): Promise<void> {
  await redis.set(Keys.userGrace(userId), '1');
}

export async function removeGrace(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(Keys.userGrace(userId));
}

export async function getAppealLog(redis: RedisClient, userId: string): Promise<AppealEntry[]> {
  const raw = await redis.get(Keys.userAppealLog(userId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as AppealEntry[];
  } catch {
    return [];
  }
}

export async function appendAppeal(
  redis: RedisClient,
  userId: string,
  entry: AppealEntry
): Promise<void> {
  const log = await getAppealLog(redis, userId);
  log.unshift(entry);
  const trimmed = log.slice(0, APPEAL.LOG_MAX_ENTRIES);
  await redis.set(Keys.userAppealLog(userId), JSON.stringify(trimmed));
}

export async function getLastAppealTs(redis: RedisClient, userId: string): Promise<number | null> {
  const log = await getAppealLog(redis, userId);
  return log[0]?.timestamp ?? null;
}

export async function isAppealOnCooldown(
  redis: RedisClient,
  userId: string,
  cooldownDays: number
): Promise<boolean> {
  const lastTs = await getLastAppealTs(redis, userId);
  if (!lastTs) return false;
  const cooldownMs = cooldownDays * 86_400_000;
  return Date.now() - lastTs < cooldownMs;
}

export async function incrementTrustLeaderboard(
  redis: RedisClient,
  userId: string,
  score: number
): Promise<void> {
  await redis.zAdd(Keys.leaderboardTrust, { score, member: userId });
}

export async function getUsersInactiveSince(
  redis: RedisClient,
  cutoffTs: number
): Promise<string[]> {
  // Returns all members of the leaderboard (we filter by activity in the caller)
  const all = await redis.zRange(Keys.leaderboardTrust, 0, -1, { by: 'rank' });
  const inactiveUsers: string[] = [];
  for (const { member } of all) {
    const activity = await getActivity(redis, member);
    if (activity.lastActivityTs < cutoffTs) {
      inactiveUsers.push(member);
    }
  }
  return inactiveUsers;
}

// Grace-tier constant for trust score computations
export const GRACE_THRESHOLD = TRUST.GRACE_POST_THRESHOLD;
