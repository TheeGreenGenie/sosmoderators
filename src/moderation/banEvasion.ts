import type { RedisClient } from '@devvit/public-api';
import { levenshtein } from '../utils/levenshtein.js';
import { BAN_EVASION } from '../utils/constants.js';

const RECENT_BANS_KEY = 'bans:recent';
const RECENT_BANS_TTL_MS = 30 * 86_400_000;

export interface BanEvasionResult {
  suspicious: boolean;
  matchedUsername?: string;
  distance?: number;
  reason?: string;
}

export async function recordBan(redis: RedisClient, username: string): Promise<void> {
  const lower = username.toLowerCase();
  await redis.zAdd(RECENT_BANS_KEY, { score: Date.now(), member: lower });
  // Trim bans older than 30 days
  await redis.zRemRangeByScore(RECENT_BANS_KEY, 0, Date.now() - RECENT_BANS_TTL_MS);
}

export async function checkBanEvasion(
  redis: RedisClient,
  username: string,
  accountAgeDays: number,
  postTimestamp: number
): Promise<BanEvasionResult> {
  if (accountAgeDays > BAN_EVASION.NEW_ACCOUNT_DAYS) {
    return { suspicious: false };
  }

  const cutoff = postTimestamp - BAN_EVASION.POST_WITHIN_BAN_HOURS * 3_600_000;
  // Get bans within the time window (score = bannedAt timestamp)
  const recent = await redis.zRange(RECENT_BANS_KEY, cutoff, '+inf', { by: 'score' });
  const lower = username.toLowerCase();

  for (const { member: bannedUser } of recent) {
    const dist = levenshtein(lower, bannedUser);
    if (dist <= BAN_EVASION.MAX_LEVENSHTEIN) {
      return {
        suspicious: true,
        matchedUsername: bannedUser,
        distance: dist,
        reason: `Username similar to recently banned user "${bannedUser}" (edit distance: ${dist})`,
      };
    }
  }

  return { suspicious: false };
}
