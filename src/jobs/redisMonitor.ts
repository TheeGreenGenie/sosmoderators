import type { ScheduledJobEvent, JobContext } from '@devvit/public-api';
import { Keys } from '../redis/schema.js';
import { evictOldAggregates, clearAICache } from '../redis/aggregates.js';
import { sendModAlert } from '../moderation/actions.js';
import { REDIS_MONITOR } from '../utils/constants.js';

/**
 * Rough Redis usage estimate based on known key sizes.
 * Devvit doesn't expose MEMORY USAGE, so we track a running byte counter
 * in a dedicated key, incremented by writers (best-effort).
 */
async function estimateUsageMB(redis: import('@devvit/public-api').RedisClient): Promise<number> {
  const raw = await redis.get('sys:redis:estimated_bytes');
  return parseInt(raw ?? '0') / (1024 * 1024);
}

export async function runRedisMonitor(
  _event: ScheduledJobEvent<undefined>,
  context: JobContext
): Promise<void> {
  console.log(`[RedisMonitor] job started`);
  const redis = context.redis;
  const estimatedMB = await estimateUsageMB(redis);
  console.log(`[RedisMonitor] estimated usage=${estimatedMB.toFixed(2)}MB`);
  const pct = estimatedMB / 500;

  if (pct >= REDIS_MONITOR.CRITICAL_THRESHOLD) {
    await evictOldAggregates(redis, 30);
    await clearAICache(redis);
    await sendModAlert(
      context,
      redis,
      'CRITICAL: Redis Storage Alert',
      `Redis is at ${(pct * 100).toFixed(1)}% capacity (${estimatedMB.toFixed(1)} MB / 500 MB).\n\nEmergency eviction triggered: aggregate history trimmed to 30 days, AI cache cleared.`
    );
    return;
  }

  if (pct >= REDIS_MONITOR.WARNING_THRESHOLD) {
    const warned = await redis.get(Keys.redisUsageWarned);
    if (!warned) {
      await sendModAlert(
        context,
        redis,
        'Warning: Redis Storage Usage High',
        `Redis is at ${(pct * 100).toFixed(1)}% capacity (${estimatedMB.toFixed(1)} MB / 500 MB).\n\nConsider clearing old data or adjusting retention settings.`
      );
      await redis.set(Keys.redisUsageWarned, '1', {
        expiration: new Date(Date.now() + REDIS_MONITOR.WARNING_COOLDOWN_SECONDS * 1000),
      });
    }
  }
}
