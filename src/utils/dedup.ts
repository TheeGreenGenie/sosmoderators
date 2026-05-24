import type { RedisClient } from '@devvit/public-api';
import { DEDUP_TTL_SECONDS } from './constants.js';
import { Keys } from '../redis/schema.js';

/**
 * Returns true if this eventId has already been processed (duplicate trigger).
 * Sets the dedup key with TTL if this is the first occurrence.
 */
export async function isDuplicate(redis: RedisClient, eventId: string): Promise<boolean> {
  const key = Keys.dedupTrigger(eventId);
  const existing = await redis.get(key);
  if (existing != null) return true;
  await redis.set(key, '1', { expiration: new Date(Date.now() + DEDUP_TTL_SECONDS * 1000) });
  return false;
}
