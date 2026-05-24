import type { ScheduledJobEvent, JobContext } from '@devvit/public-api';
import { Keys } from '../redis/schema.js';
import { getTrustScore, setTrustScore, isInGrace } from '../redis/users.js';
import { applyDecay } from '../scoring/trustScore.js';
import { TRUST } from '../utils/constants.js';

/**
 * Runs weekly (Sunday ~3am UTC).
 * Scans all users in the trust leaderboard.
 * Applies 5% monthly decay to users inactive for 90+ days.
 */
export async function runTrustDecay(
  _event: ScheduledJobEvent<undefined>,
  context: JobContext
): Promise<void> {
  console.log(`[TrustDecay] job started`);
  const redis = context.redis;
  const cutoffTs = Date.now() - TRUST.DECAY_INACTIVE_DAYS * 86_400_000;

  // Devvit Redis zRange returns members; process in pages of 100
  const allMembers = await redis.zRange(Keys.leaderboardTrust, 0, -1, { by: 'rank' });

  console.log(`[TrustDecay] processing ${allMembers.length} users — cutoffTs=${cutoffTs}`);
  for (const { member: userId } of allMembers) {
    const trustRecord = await getTrustScore(redis, userId);
    if (!trustRecord) {
      console.log(`[TrustDecay] userId=${userId} — no trust record, skipping`);
      continue;
    }

    const ageMs = Date.now() - (trustRecord.lastUpdated ?? 0);
    const ageDays = Math.floor(ageMs / 86_400_000);
    console.log(`[TrustDecay] userId=${userId} score=${trustRecord.score} lastUpdated=${trustRecord.lastUpdated} ageDays=${ageDays} cutoff=${TRUST.DECAY_INACTIVE_DAYS}d — ${trustRecord.lastUpdated >= cutoffTs ? 'SKIP (active)' : 'DECAY'}`);

    if (trustRecord.lastUpdated >= cutoffTs) continue;

    const inGrace = await isInGrace(redis, userId);
    const decayed = applyDecay(trustRecord, inGrace);
    console.log(`[TrustDecay] userId=${userId} decayed ${trustRecord.score} → ${decayed.score}`);

    if (decayed.score !== trustRecord.score) {
      await setTrustScore(redis, userId, decayed);
      console.log(`[TrustDecay] userId=${userId} leaderboard updated to ${decayed.score}`);
    } else {
      console.log(`[TrustDecay] userId=${userId} score unchanged (already at min or untrusted tier)`);
    }
  }
}
