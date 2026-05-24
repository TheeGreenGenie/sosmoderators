import type { RedisClient } from '@devvit/public-api';
import { Keys } from '../redis/schema.js';
import { isDuplicate } from '../utils/dedup.js';

export async function isKillSwitchActive(redis: RedisClient): Promise<boolean> {
  return (await redis.get(Keys.killSwitch)) === '1';
}

export async function activateKillSwitch(redis: RedisClient): Promise<void> {
  await redis.set(Keys.killSwitch, '1');
}

export async function deactivateKillSwitch(redis: RedisClient): Promise<void> {
  await redis.del(Keys.killSwitch);
}

/**
 * Must be the FIRST call in every trigger handler.
 * Returns true if the handler should proceed, false to abort.
 */
export async function triggerGuard(
  redis: RedisClient,
  eventId: string
): Promise<{ proceed: boolean; reason?: string }> {
  if (await isKillSwitchActive(redis)) return { proceed: false, reason: 'kill_switch' };
  if (await isDuplicate(redis, eventId)) return { proceed: false, reason: 'duplicate' };
  return { proceed: true };
}

export async function isFeatureEnabled(
  redis: RedisClient,
  feature: keyof {
    spamDetection: boolean;
    reportHandling: boolean;
    antiRaid: boolean;
    modmailRouting: boolean;
    trustScoring: boolean;
    flairAutoAssign: boolean;
  }
): Promise<boolean> {
  const { getConfig } = await import('../redis/config.js');
  const config = await getConfig(redis);
  return config.features[feature] ?? true;
}
