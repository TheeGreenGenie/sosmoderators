import type { Context, TriggerContext, RedisClient } from '@devvit/public-api';

/** Minimal context shape shared by Context (triggers/menu) and JobContext (scheduler). */
export interface MinimalContext {
  readonly reddit: Context['reddit'];
  readonly subredditName?: string;
}
import { checkRateLimit, enqueueRetry, type ActionType } from './rateLimiter.js';
import { logAction } from './auditLog.js';
import { getConfig } from '../redis/config.js';
import { shouldDeliverNow } from '../utils/quietHours.js';

interface ModActionOptions {
  context: TriggerContext | Context;
  redis: RedisClient;
  targetId: string;
  targetType: 'post' | 'comment' | 'user';
  actor: string;
  reason: string;
  score?: number;
}

async function executeWithRateLimit(
  redis: RedisClient,
  action: ActionType,
  execute: () => Promise<void>,
  payload: string
): Promise<boolean> {
  const { allowed } = await checkRateLimit(redis, action);
  if (!allowed) {
    await enqueueRetry(redis, { action, payload, retries: 0, queuedAt: Date.now() });
    return false;
  }
  await execute();
  return true;
}

export async function removePost(opts: ModActionOptions): Promise<boolean> {
  const { context, redis, targetId, actor, reason, score } = opts;
  const executed = await executeWithRateLimit(
    redis,
    'removal',
    () => context.reddit.remove(targetId, false),
    JSON.stringify({ targetId, reason })
  );
  if (executed) {
    await logAction(redis, {
      timestamp: Date.now(),
      action: 'remove_post',
      targetId,
      targetType: 'post',
      actor,
      reason,
      score,
    });
  }
  return executed;
}

export async function flairPost(
  opts: ModActionOptions & { flairText: string; flairTemplateId?: string }
): Promise<boolean> {
  const { context, redis, targetId, actor, reason, flairText } = opts;
  let { flairTemplateId } = opts;

  // Look up template ID by name so setPostFlair works on template-only subreddits
  if (!flairTemplateId) {
    try {
      const templates = await context.reddit.getPostFlairTemplates(context.subredditName ?? '');
      // Normalise both sides: NFC + strip Unicode variation selectors (U+FE0E/FE0F)
      // so emoji like "⚠️" match regardless of how Reddit stores them
      const norm = (s: string) => s.normalize('NFC').replace(/[︎️]/g, '').toLowerCase().trim();
      const match = templates.find((t) => norm(t.text) === norm(flairText));
      if (match) {
        flairTemplateId = match.id;
        console.log(`[flairPost] resolved "${flairText}" → templateId=${flairTemplateId}`);
      } else {
        console.log(`[flairPost] no template found for "${flairText}" (norm="${norm(flairText)}") available: [${templates.map((t) => `"${norm(t.text)}"`).join(', ')}]`);
      }
    } catch (e) {
      console.log(`[flairPost] getPostFlairTemplates failed: ${e}`);
    }
  }

  const executed = await executeWithRateLimit(
    redis,
    'flair',
    () =>
      context.reddit.setPostFlair({
        postId: targetId,
        subredditName: context.subredditName ?? '',
        text: flairText,
        ...(flairTemplateId ? { flairTemplateId } : {}),
      }),
    JSON.stringify({ targetId, flairText })
  );
  if (executed) {
    await logAction(redis, {
      timestamp: Date.now(),
      action: 'flair_post',
      targetId,
      targetType: 'post',
      actor,
      reason,
    });
  }
  return executed;
}

export async function sendModmail(
  opts: ModActionOptions & { subject: string; body: string }
): Promise<boolean> {
  const { context, redis, targetId, actor, reason, subject, body } = opts;
  const executed = await executeWithRateLimit(
    redis,
    'modmail',
    () =>
      context.reddit.sendPrivateMessage({
        to: `r/${context.subredditName ?? ''}`,
        subject,
        text: body,
      }),
    JSON.stringify({ subject })
  );
  if (executed) {
    await logAction(redis, {
      timestamp: Date.now(),
      action: 'send_modmail',
      targetId,
      targetType: 'post',
      actor,
      reason,
    });
  }
  return executed;
}

export async function banUser(
  opts: ModActionOptions & { durationDays?: number; message?: string }
): Promise<boolean> {
  const { context, redis, targetId, actor, reason, durationDays, message } = opts;
  const executed = await executeWithRateLimit(
    redis,
    'ban',
    () =>
      context.reddit.banUser({
        subredditName: context.subredditName ?? '',
        username: targetId,
        duration: durationDays,
        reason,
        message: message ?? reason,
        note: `Automated action by SubGuardian | Actor: ${actor}`,
      }),
    JSON.stringify({ targetId, durationDays })
  );
  if (executed) {
    await logAction(redis, {
      timestamp: Date.now(),
      action: 'ban_user',
      targetId,
      targetType: 'user',
      actor,
      reason,
    });
  }
  return executed;
}

export async function sendModAlert(
  context: MinimalContext,
  redis: RedisClient,
  subject: string,
  body: string,
  isCritical: boolean = false
): Promise<void> {
  const config = await getConfig(redis);
  if (!shouldDeliverNow(config, isCritical)) {
    await logAction(redis, {
      timestamp: Date.now(),
      action: 'modmail_quiet_hours_dropped',
      targetId: 'system',
      targetType: 'system',
      actor: 'SubGuardian',
      reason: subject,
    });
    return;
  }

  await sendModmail({
    context: context as Context,
    redis,
    targetId: 'system',
    targetType: 'post',
    actor: 'SubGuardian',
    reason: subject,
    subject: `[SubGuardian] ${subject}`,
    body,
  });
}
