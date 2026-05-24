import type { ScheduledJobEvent, JobContext } from '@devvit/public-api';
import { Keys } from '../redis/schema.js';
import { getConfig, setPreset } from '../redis/config.js';
import { logAction } from '../moderation/auditLog.js';
import { sendModAlert } from '../moderation/actions.js';

/**
 * Runs every 30 minutes.
 * If raid mode is active and its configured duration has elapsed,
 * automatically reverts to the default preset and notifies mods.
 */
export async function runRaidModeExpiry(
  _event: ScheduledJobEvent<undefined>,
  context: JobContext
): Promise<void> {
  console.log(`[RaidModeExpiry] job started`);
  const redis = context.redis;

  const raidActive = await redis.get(Keys.raidMode);
  if (raidActive !== '1') {
    console.log(`[RaidModeExpiry] raid mode not active — skipping`);
    return;
  }

  const config = await getConfig(redis);
  const activeSinceRaw = await redis.get('sub:raid_mode:activated_at');
  if (!activeSinceRaw) return;

  const activatedAt = parseInt(activeSinceRaw);
  const durationMs = config.antiRaid.raidDurationHours * 3600_000;

  if (Date.now() - activatedAt < durationMs) return;

  await redis.del(Keys.raidMode);
  await redis.del('sub:raid_mode:activated_at');
  await setPreset(redis, 'default');

  await logAction(redis, {
    timestamp: Date.now(),
    action: 'raid_mode_auto_expired',
    targetId: 'system',
    targetType: 'system',
    actor: 'SubGuardian',
    reason: `Raid mode expired after ${config.antiRaid.raidDurationHours}h`,
  });

  await sendModAlert(
    context,
    redis,
    'Raid Mode Auto-Expired',
    `Raid mode has been active for ${config.antiRaid.raidDurationHours} hours and has been automatically deactivated. Preset reverted to **Default**.\n\nIf the threat is ongoing, reactivate via the SubGuardian menu.`
  );
}
