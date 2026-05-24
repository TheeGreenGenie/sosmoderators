import type { ScheduledJobEvent, JobContext, RedisClient } from '@devvit/public-api';
import { Keys, hourKey } from '../redis/schema.js';
import { getHourlyPostCount } from '../redis/aggregates.js';
import { sendModAlert } from '../moderation/actions.js';
import { SPIKE_ALERT_MULTIPLIER } from '../utils/constants.js';

/**
 * Runs every 15 minutes.
 * Checks post velocity AND toxicity surge against 7-day baselines.
 */
export async function runSpikeDetector(
  _event: ScheduledJobEvent<undefined>,
  context: JobContext
): Promise<void> {
  console.log(`[SpikeDetector] job started`);
  const redis = context.redis;
  const now = new Date();
  const currentHk = hourKey(now);

  await checkPostSpike(redis, context, now, currentHk);
  await checkToxicitySpike(redis, context, now, currentHk);
  console.log(`[SpikeDetector] done`);
}

async function checkPostSpike(
  redis: RedisClient,
  context: JobContext,
  now: Date,
  currentHk: string
): Promise<void> {
  const currentCount = await getHourlyPostCount(redis, currentHk);

  const baselineCounts: number[] = [];
  for (let weeksAgo = 1; weeksAgo <= 4; weeksAgo++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - weeksAgo * 7);
    const count = await getHourlyPostCount(redis, hourKey(d));
    if (count > 0) baselineCounts.push(count);
  }

  if (baselineCounts.length === 0 || currentCount < 10) return;

  const avg = baselineCounts.reduce((a, b) => a + b, 0) / baselineCounts.length;
  const threshold = avg * SPIKE_ALERT_MULTIPLIER;

  if (currentCount >= threshold) {
    const alertKey = `spike:post:alert:${currentHk}`;
    if (await redis.get(alertKey)) return;

    await sendModAlert(
      context,
      redis,
      'Unusual Post Volume Spike',
      [
        `**Current hour posts:** ${currentCount}`,
        `**Baseline average:** ${avg.toFixed(1)}`,
        `**Threshold (${SPIKE_ALERT_MULTIPLIER}x):** ${threshold.toFixed(1)}`,
        `**Time:** ${now.toUTCString()}`,
      ].join('\n')
    );
    await redis.set(alertKey, '1', { expiration: new Date(Date.now() + 3600 * 1000) });
  }
}

async function checkToxicitySpike(
  redis: RedisClient,
  context: JobContext,
  now: Date,
  currentHk: string
): Promise<void> {
  const sumRaw = await redis.get(Keys.hourlyToxicitySum(currentHk));
  const countRaw = await redis.get(`spike:toxicity_count:${currentHk}`);
  const currentSum = parseFloat(sumRaw ?? '0');
  const currentCount = parseInt(countRaw ?? '0');
  if (currentCount < 5) return;

  const currentAvg = currentSum / currentCount;

  // Collect baseline toxicity averages for the same hour-of-week over 4 weeks
  const baselineAvgs: number[] = [];
  for (let weeksAgo = 1; weeksAgo <= 4; weeksAgo++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - weeksAgo * 7);
    const hk = hourKey(d);
    const bSumRaw = await redis.get(Keys.hourlyToxicitySum(hk));
    const bCountRaw = await redis.get(`spike:toxicity_count:${hk}`);
    const bCount = parseInt(bCountRaw ?? '0');
    if (bCount > 0) {
      baselineAvgs.push(parseFloat(bSumRaw ?? '0') / bCount);
    }
  }

  if (baselineAvgs.length === 0) return;

  const baselineAvg = baselineAvgs.reduce((a, b) => a + b, 0) / baselineAvgs.length;
  const threshold = baselineAvg * SPIKE_ALERT_MULTIPLIER;

  if (currentAvg >= threshold && currentAvg >= 0.4) {
    const alertKey = `spike:toxicity:alert:${currentHk}`;
    if (await redis.get(alertKey)) return;

    await sendModAlert(
      context,
      redis,
      'Toxicity Surge Detected',
      [
        `**Current hour avg toxicity:** ${currentAvg.toFixed(3)} (${currentCount} comments)`,
        `**Baseline average:** ${baselineAvg.toFixed(3)}`,
        `**Threshold (${SPIKE_ALERT_MULTIPLIER}x):** ${threshold.toFixed(3)}`,
        `**Time:** ${now.toUTCString()}`,
        '',
        'Review recent comments for coordinated harassment.',
      ].join('\n')
    );
    await redis.set(alertKey, '1', { expiration: new Date(Date.now() + 3600 * 1000) });
  }
}
