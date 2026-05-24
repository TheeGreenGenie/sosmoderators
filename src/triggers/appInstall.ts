import type { TriggerEventType, TriggerContext } from '@devvit/public-api';
import { runMigrations } from '../redis/migration.js';
import { getConfig, setConfig, DEFAULT_CONFIG } from '../redis/config.js';
import { logAction } from '../moderation/auditLog.js';

async function handleInstall(context: TriggerContext): Promise<void> {
  const redis = context.redis;

  await runMigrations(redis);

  const existing = await getConfig(redis);
  if (!existing) {
    await setConfig(redis, { ...DEFAULT_CONFIG });
  }

  await logAction(redis, {
    timestamp: Date.now(),
    action: 'app_installed',
    targetId: context.subredditId ?? 'unknown',
    targetType: 'system',
    actor: 'SubGuardian',
    reason: 'App installed / upgraded',
  });
}

export async function onAppInstall(_event: TriggerEventType['AppInstall'], context: TriggerContext): Promise<void> {
  await handleInstall(context);
}

export async function onAppUpgrade(_event: TriggerEventType['AppUpgrade'], context: TriggerContext): Promise<void> {
  await handleInstall(context);
}
