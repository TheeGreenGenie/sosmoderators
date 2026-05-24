import type { TriggerEventType, TriggerContext } from '@devvit/public-api';
import { triggerGuard, isFeatureEnabled } from '../moderation/killSwitch.js';
import { getConfig } from '../redis/config.js';
import { getTrustScore } from '../redis/users.js';
import { addReport, updateReportRecord } from '../redis/posts.js';
import { incrementReportAgg } from '../redis/aggregates.js';
import { computeWeightedReportCount, detectCIB, shouldAutoAction, checkViewReportRatio } from '../scoring/reportScore.js';
import { removePost, sendModAlert } from '../moderation/actions.js';

export async function onPostReport(event: TriggerEventType['PostReport'], context: TriggerContext): Promise<void> {
  const redis = context.redis;
  // Use a 30-second window so Devvit's duplicate trigger fires are collapsed,
  // while still allowing a second legitimate report after the window expires.
  const windowTs = Math.floor(Date.now() / 30_000);
  const eventId = `report:${event.post?.id ?? 'unknown'}:${(event.reason ?? '').slice(0, 20)}:${windowTs}`;
  console.log(`[PostReport] fired — postId=${event.post?.id ?? 'unknown'} reason="${event.reason ?? ''}"`);

  const guard = await triggerGuard(redis, eventId);
  if (!guard.proceed) {
    console.log(`[PostReport] aborted — reason=${guard.reason}`);
    return;
  }
  if (!(await isFeatureEnabled(redis, 'reportHandling'))) {
    console.log(`[PostReport] reportHandling feature disabled`);
    return;
  }

  const config = await getConfig(redis);
  const post = event.post;
  if (!post) {
    console.log(`[PostReport] missing post — aborting`);
    return;
  }

  // PostReport doesn't include reporter identity in the proto — use subreddit-level sentinel
  const reporterId = 'unknown';
  const reporterTrust = await getTrustScore(redis, reporterId);
  const reporterScore = reporterTrust?.score ?? 300;

  // Build report entry — reason is directly on the event
  const reportEntry = {
    reporterId,
    reporterTrust: reporterScore,
    reason: event.reason ?? 'unknown',
    timestamp: Date.now(),
  };

  // Persist to Redis
  const record = await addReport(redis, post.id ?? '', reportEntry);

  // Compute weighted count
  const weightedCount = computeWeightedReportCount(record.reports);
  record.weightedCount = weightedCount;

  const viewCount = ('viewCount' in post && typeof post.viewCount === 'number') ? post.viewCount : 0;
  const cibResult = detectCIB(record.reports, viewCount);
  record.cibFlag = cibResult.isCIB;

  await updateReportRecord(redis, post.id, record);
  await incrementReportAgg(redis, 'total');

  console.log(`[PostReport] weightedCount=${weightedCount.toFixed(2)} cib=${cibResult.isCIB}`);

  if (cibResult.isCIB) {
    await sendModAlert(
      context,
      redis,
      'CIB Detected',
      [
        `**Post:** ${post.title} (${post.id})`,
        `**Reports:** ${cibResult.reportCount} in under 5 minutes`,
        `**Views at time of reports:** ${viewCount > 0 ? viewCount : 'unknown'}`,
        `**Burst window:** ${cibResult.isBurst ? 'Yes (<5 min)' : 'No'}`,
        '',
        'Auto-action suppressed. Please review manually.',
      ].join('\n')
    );
    return;
  }

  // View/report ratio check
  if (
    'viewCount' in post &&
    typeof post.viewCount === 'number' &&
    checkViewReportRatio(
      post.viewCount,
      record.reports.length,
      config.reportHandling.viewReportRatioThreshold,
      config.reportHandling.minViewsForRatioCheck
    )
  ) {
    record.weightedCount = Math.max(record.weightedCount, config.reportHandling.autoActionThreshold);
    await updateReportRecord(redis, post.id, record);
  }

  if (shouldAutoAction(record, config.reportHandling.autoActionThreshold)) {
    await removePost({
      context,
      redis,
      targetId: post.id,
      targetType: 'post',
      actor: 'SubGuardian:reports',
      reason: `Weighted report count: ${weightedCount.toFixed(1)} / ${config.reportHandling.autoActionThreshold}`,
      score: weightedCount,
    });
    await incrementReportAgg(redis, 'actioned');
  }
}
