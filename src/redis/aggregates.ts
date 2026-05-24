import type { RedisClient } from '@devvit/public-api';
import { Keys, dateKey, hourKey } from './schema.js';

// ─── Daily Aggregate Helpers ──────────────────────────────────────────────────

export async function incrementPostAgg(
  redis: RedisClient,
  field: 'total' | 'removed' | 'flagged' | 'approved'
): Promise<void> {
  const key = Keys.aggPostsDaily(dateKey());
  const current = await redis.hGet(key, field);
  await redis.hSet(key, { [field]: String(parseInt(current ?? '0') + 1) });
}

export async function incrementReportAgg(
  redis: RedisClient,
  field: 'total' | 'actioned' | 'false_positive'
): Promise<void> {
  const key = Keys.aggReportsDaily(dateKey());
  const current = await redis.hGet(key, field);
  await redis.hSet(key, { [field]: String(parseInt(current ?? '0') + 1) });
}

export async function addToxicityAgg(redis: RedisClient, score: number): Promise<void> {
  const key = Keys.aggToxicityDaily(dateKey());
  const [sumRaw, countRaw] = await Promise.all([
    redis.hGet(key, 'score_sum'),
    redis.hGet(key, 'count'),
  ]);
  await redis.hSet(key, {
    score_sum: String((parseFloat(sumRaw ?? '0') + score).toFixed(4)),
    count: String(parseInt(countRaw ?? '0') + 1),
  });
}

export async function incrementUserAgg(
  redis: RedisClient,
  field: 'new' | 'active' | 'banned'
): Promise<void> {
  const key = Keys.aggUsersDaily(dateKey());
  const current = await redis.hGet(key, field);
  await redis.hSet(key, { [field]: String(parseInt(current ?? '0') + 1) });
}

export async function recordTopicMention(redis: RedisClient, topic: string): Promise<void> {
  const key = Keys.aggTopics(dateKey());
  await redis.zIncrBy(key, topic, 1);
}

// ─── Hourly Spike Tracking ────────────────────────────────────────────────────

export async function incrementHourlyPost(redis: RedisClient): Promise<void> {
  const key = Keys.hourlyPostCount(hourKey());
  const current = await redis.get(key);
  await redis.set(key, String(parseInt(current ?? '0') + 1), { expiration: new Date(Date.now() + 8 * 3600 * 1000) });
}

export async function incrementHourlyNewUser(redis: RedisClient): Promise<void> {
  const key = Keys.hourlyNewUsers(hourKey());
  const current = await redis.get(key);
  await redis.set(key, String(parseInt(current ?? '0') + 1), { expiration: new Date(Date.now() + 8 * 3600 * 1000) });
}

export async function addHourlyToxicity(redis: RedisClient, score: number): Promise<void> {
  const key = Keys.hourlyToxicitySum(hourKey());
  const current = await redis.get(key);
  await redis.set(key, String((parseFloat(current ?? '0') + score).toFixed(4)), {
    expiration: new Date(Date.now() + 8 * 3600 * 1000),
  });
}

export async function getHourlyPostCount(redis: RedisClient, hk: string): Promise<number> {
  const val = await redis.get(Keys.hourlyPostCount(hk));
  return parseInt(val ?? '0');
}

// ─── Old Aggregate Eviction ───────────────────────────────────────────────────

export async function evictOldAggregates(
  redis: RedisClient,
  daysToKeep: number
): Promise<void> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - daysToKeep);

  // Build list of date keys to delete (dates older than cutoff)
  const keysToDelete: string[] = [];
  for (let i = daysToKeep + 1; i <= daysToKeep + 90; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const dk = dateKey(d);
    keysToDelete.push(
      Keys.aggPostsDaily(dk),
      Keys.aggReportsDaily(dk),
      Keys.aggToxicityDaily(dk),
      Keys.aggUsersDaily(dk),
      Keys.aggTopics(dk)
    );
  }

  for (const k of keysToDelete) {
    await redis.del(k);
  }
}

export async function clearAICache(redis: RedisClient): Promise<void> {
  // Devvit Redis doesn't support SCAN, so we track a manifest of AI cache keys
  // In practice, AI cache keys expire via TTL — this is a best-effort eviction
  const manifestKey = 'ai:cache:manifest';
  const raw = await redis.get(manifestKey);
  if (!raw) return;
  try {
    const keys: string[] = JSON.parse(raw) as string[];
    for (const k of keys) {
      await redis.del(k);
    }
    await redis.del(manifestKey);
  } catch {
    // ignore malformed manifest
  }
}

export async function registerAICacheKey(redis: RedisClient, key: string): Promise<void> {
  const manifestKey = 'ai:cache:manifest';
  const raw = await redis.get(manifestKey);
  let keys: string[] = [];
  try {
    keys = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    keys = [];
  }
  if (!keys.includes(key)) {
    keys.push(key);
    // Keep manifest bounded
    if (keys.length > 500) keys.splice(0, 100);
    await redis.set(manifestKey, JSON.stringify(keys));
  }
}
