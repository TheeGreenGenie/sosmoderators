import type { RedisClient } from '@devvit/public-api';
import { Keys } from '../redis/schema.js';
import { RATE_LIMITS, RATE_LIMIT_RETRY_MAX, RATE_LIMIT_SATURATION_ALERT_MS } from '../utils/constants.js';

const SATURATION_TRACKING_KEY = 'ratelimit:global:saturated_since';
const SATURATION_ALERTED_KEY = 'ratelimit:global:saturation_alerted';

export type ActionType = 'removal' | 'flair' | 'modmail' | 'report_action' | 'ban';

interface LimitConfig {
  limit: number;
  windowMs: number;
}

const LIMITS: Record<ActionType, LimitConfig> = {
  removal: RATE_LIMITS.REMOVAL,
  flair: RATE_LIMITS.FLAIR,
  modmail: RATE_LIMITS.MODMAIL,
  report_action: RATE_LIMITS.REPORT_ACTION,
  ban: RATE_LIMITS.BAN,
};

export async function checkRateLimit(
  redis: RedisClient,
  action: ActionType
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const { limit, windowMs } = LIMITS[action];
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = Keys.rateLimit(action, windowStart);

  const current = parseInt((await redis.get(key)) ?? '0');
  if (current >= limit) return { allowed: false, remaining: 0 };

  await redis.set(key, String(current + 1), {
    expiration: new Date(Date.now() + (Math.ceil(windowMs / 1000) + 5) * 1000),
  });

  // Global limit check
  const { limit: gLimit, windowMs: gWindow } = RATE_LIMITS.GLOBAL;
  const gWindowStart = Math.floor(now / gWindow) * gWindow;
  const globalKey = Keys.rateLimitGlobal(gWindowStart);
  const globalCurrent = parseInt((await redis.get(globalKey)) ?? '0');
  if (globalCurrent >= gLimit) return { allowed: false, remaining: 0 };
  await redis.set(globalKey, String(globalCurrent + 1), { expiration: new Date(Date.now() + 65 * 1000) });

  return { allowed: true, remaining: limit - current - 1 };
}

export interface RetryItem {
  action: ActionType;
  payload: string;
  retries: number;
  queuedAt: number;
}

export async function enqueueRetry(
  redis: RedisClient,
  item: RetryItem
): Promise<void> {
  if (item.retries >= RATE_LIMIT_RETRY_MAX) return;
  // Use a hash: field = unique id, value = serialized item
  const id = `${item.queuedAt}:${Math.random().toString(36).slice(2)}`;
  await redis.hSet(Keys.rateLimitRetryQueue, { [id]: JSON.stringify(item) });
}

/**
 * Drains the retry queue respecting rate limits.
 * Returns true if mods should be alerted about prolonged saturation.
 */
export async function drainRetryQueue(
  redis: RedisClient,
  handler: (item: RetryItem) => Promise<void>
): Promise<{ needsSaturationAlert: boolean }> {
  let processed = 0;
  let allBlocked = true;

  const queue = await redis.hGetAll(Keys.rateLimitRetryQueue);
  const entries = Object.entries(queue).slice(0, 20);

  for (const [id, raw] of entries) {
    try {
      const item = JSON.parse(raw) as RetryItem;
      const { allowed } = await checkRateLimit(redis, item.action);
      if (allowed) {
        await handler(item);
        await redis.hDel(Keys.rateLimitRetryQueue, [id]);
        processed++;
        allBlocked = false;
      } else {
        await redis.hDel(Keys.rateLimitRetryQueue, [id]);
        await enqueueRetry(redis, { ...item, retries: item.retries + 1 });
      }
    } catch {
      await redis.hDel(Keys.rateLimitRetryQueue, [id]);
    }
  }

  // If queue had items but nothing got through, track saturation window
  if (entries.length > 0 && allBlocked && processed === 0) {
    const saturatedSince = await redis.get(SATURATION_TRACKING_KEY);
    if (!saturatedSince) {
      await redis.set(SATURATION_TRACKING_KEY, String(Date.now()), {
        expiration: new Date(Date.now() + RATE_LIMIT_SATURATION_ALERT_MS * 2),
      });
    } else {
      const elapsed = Date.now() - parseInt(saturatedSince);
      if (elapsed >= RATE_LIMIT_SATURATION_ALERT_MS) {
        const alreadyAlerted = await redis.get(SATURATION_ALERTED_KEY);
        if (!alreadyAlerted) {
          await redis.set(SATURATION_ALERTED_KEY, '1', { expiration: new Date(Date.now() + 3600 * 1000) });
          return { needsSaturationAlert: true };
        }
      }
    }
  } else {
    // Clear saturation tracking on any successful drain
    await redis.del(SATURATION_TRACKING_KEY);
    await redis.del(SATURATION_ALERTED_KEY);
  }

  return { needsSaturationAlert: false };
}
