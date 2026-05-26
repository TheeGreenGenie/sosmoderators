import { Devvit } from '@devvit/public-api';
import type { MenuItemOnPressEvent, Context, JobContext } from '@devvit/public-api';
import { onPostSubmit } from './triggers/postSubmit.js';
import { onPostReport } from './triggers/postReport.js';
import { onModMail } from './triggers/modmail.js';
import { onCommentSubmit } from './triggers/commentSubmit.js';
import { onAppInstall, onAppUpgrade } from './triggers/appInstall.js';
import { runAggregateBuilder } from './jobs/aggregateBuilder.js';
import { runSpikeDetector } from './jobs/spikeDetector.js';
import { runRedisMonitor } from './jobs/redisMonitor.js';
import { runTrustDecay } from './jobs/trustDecay.js';
import { runRaidModeExpiry } from './jobs/raidModeExpiry.js';
import { runFlairVoteTallier } from './jobs/flairVoteTallier.js';
import { runWeeklyHighlight } from './jobs/weeklyHighlight.js';
import { Keys } from './redis/schema.js';
import { drainRetryQueue } from './moderation/rateLimiter.js';
import { sendModAlert } from './moderation/actions.js';
import { getAuditLog } from './moderation/auditLog.js';
import { getActivePreset, setPreset, getConfig } from './redis/config.js';
import { renderApp, renderLoadingSpinner } from './ui/renders.js';
import { getSpamScore } from './redis/posts.js';
import { writeCaseRecord } from './ui/dashboard/CaseFile.js';
import { buildCoachContext } from './ai/coachContext.js';

// ─── Configure required permissions ─────────────────────────────────────────

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: true,
});

// ─── Triggers ────────────────────────────────────────────────────────────────

Devvit.addTrigger({ event: 'PostSubmit', onEvent: onPostSubmit });
Devvit.addTrigger({ event: 'PostReport', onEvent: onPostReport });
Devvit.addTrigger({ event: 'ModMail', onEvent: onModMail });
Devvit.addTrigger({ event: 'CommentSubmit', onEvent: onCommentSubmit });
Devvit.addTrigger({ event: 'AppInstall', onEvent: onAppInstall });
Devvit.addTrigger({ event: 'AppUpgrade', onEvent: onAppUpgrade });

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────

Devvit.addSchedulerJob({ name: 'aggregate_builder', onRun: runAggregateBuilder });
Devvit.addSchedulerJob({ name: 'spike_detector', onRun: runSpikeDetector });
Devvit.addSchedulerJob({ name: 'redis_monitor', onRun: runRedisMonitor });
Devvit.addSchedulerJob({ name: 'trust_decay', onRun: runTrustDecay });
Devvit.addSchedulerJob({ name: 'raid_mode_expiry', onRun: runRaidModeExpiry });
Devvit.addSchedulerJob({ name: 'flair_vote_tallier', onRun: runFlairVoteTallier });
Devvit.addSchedulerJob({ name: 'weekly_highlight', onRun: runWeeklyHighlight });
Devvit.addSchedulerJob({
  name: 'coach_context_warmup',
  onRun: async (_event, context) => {
    await buildCoachContext(context.redis, context.subredditName ?? '');
  },
});

Devvit.addSchedulerJob({
  name: 'retry_queue_drain',
  onRun: async (_event, context) => {
    const { needsSaturationAlert } = await drainRetryQueue(context.redis, async (item) => {
      const { action, payload } = item;
      const data = JSON.parse(payload) as Record<string, unknown>;
      if (action === 'removal') {
        await context.reddit.remove(data['targetId'] as string, false);
      }
    });
    if (needsSaturationAlert) {
      await sendModAlert(
        context,
        context.redis,
        'Rate Limit Saturated (>5 min)',
        'SubGuardian global rate limit has been continuously saturated for over 5 minutes. ' +
          'Automated actions are queued but not executing. Consider activating Emergency Stop to investigate.'
      );
    }
  },
});

// ─── Single Custom Post (routes by postData.view) ────────────────────────────

Devvit.addCustomPostType({
  name: 'SubGuardian',
  description: 'SubGuardian moderation panel',
  height: 'tall',
  render: renderApp,
});

// ─── Mod Menu Actions ─────────────────────────────────────────────────────────

Devvit.addMenuItem({
  label: 'SubGuardian: Open Dashboard',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event: MenuItemOnPressEvent, context: Context) => {
    const redis = context.redis;
    const sub = context.subredditName ?? '';
    const oldId = await redis.get('sys:dashboard:post_id');
    if (oldId) {
      try {
        const existing = await context.reddit.getPostById(oldId);
        if (!existing.removed && !existing.spam) {
          context.ui.navigateTo(existing.url);
          return;
        }
        // Post was removed/deleted — fall through to recreate
      } catch { /* post not found — fall through to recreate */ }
    }
    const post = await context.reddit.submitPost({
      subredditName: sub,
      title: 'SubGuardian Dashboard',
      preview: renderLoadingSpinner('Dashboard'),
      postData: { view: 'dashboard' },
    });
    await redis.set('sys:dashboard:post_id', post.id);
    try { await post.sticky(1); } catch { /* sticky slot taken */ }
    context.ui.navigateTo(post.url);
  },
});

Devvit.addMenuItem({
  label: 'SubGuardian: Open Config',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event: MenuItemOnPressEvent, context: Context) => {
    const redis = context.redis;
    const sub = context.subredditName ?? '';
    const oldId = await redis.get('sys:config:post_id');
    if (oldId) {
      try {
        const existing = await context.reddit.getPostById(oldId);
        if (!existing.removed && !existing.spam) {
          context.ui.navigateTo(existing.url);
          return;
        }
        // Post was removed/deleted — fall through to recreate
      } catch { /* post not found — fall through to recreate */ }
    }
    const post = await context.reddit.submitPost({
      subredditName: sub,
      title: 'SubGuardian Configuration',
      preview: renderLoadingSpinner('Config'),
      postData: { view: 'config' },
    });
    await redis.set('sys:config:post_id', post.id);
    try { await post.sticky(2); } catch { /* sticky slot taken */ }
    context.ui.navigateTo(post.url);
  },
});

Devvit.addMenuItem({
  label: 'SubGuardian: Generate Appeal Summary',
  location: 'post',
  forUserType: 'moderator',
  onPress: (_event: MenuItemOnPressEvent, context: Context) => {
    context.ui.showToast('Appeal summary generated — check the comments.');
  },
});

Devvit.addMenuItem({
  label: 'SubGuardian: Approve & Notify Author',
  location: 'post',
  forUserType: 'moderator',
  onPress: async (event: MenuItemOnPressEvent, context: Context) => {
    const postId = event.targetId;
    const post = await context.reddit.getPostById(postId);
    await context.reddit.approve(postId);
    const spam = await getSpamScore(context.redis, postId);
    await writeCaseRecord(context, postId, post.title, spam?.signals ?? [], 'approved', 'Approved from mod menu');
    try {
      await context.reddit.sendPrivateMessage({
        to: post.authorName,
        subject: `Your post on r/${context.subredditName ?? ''} has been approved`,
        text: [
          `Hi u/${post.authorName},`,
          ``,
          `Your post **"${post.title}"** has been reviewed by a moderator and approved. It is now visible in the subreddit feed.`,
          ``,
          `*This is an automated message from SubGuardian.*`,
        ].join('\n'),
      });
    } catch { /* DMs disabled — skip silently */ }
    context.ui.showToast('Post approved and author notified.');
  },
});

Devvit.addMenuItem({
  label: 'SubGuardian: Remove & Notify Author',
  location: 'post',
  forUserType: 'moderator',
  onPress: async (event: MenuItemOnPressEvent, context: Context) => {
    const postId = event.targetId;
    const post = await context.reddit.getPostById(postId);
    await context.reddit.remove(postId, true);
    const spam = await getSpamScore(context.redis, postId);
    await writeCaseRecord(context, postId, post.title, spam?.signals ?? [], 'removed', 'Removed from mod menu');
    try {
      await context.reddit.sendPrivateMessage({
        to: post.authorName,
        subject: `Your post on r/${context.subredditName ?? ''} has been removed`,
        text: [
          `Hi u/${post.authorName},`,
          ``,
          `Your post **"${post.title}"** has been reviewed by a moderator and removed from the subreddit.`,
          ``,
          `If you believe this was a mistake, please reach out via modmail.`,
          ``,
          `*This is an automated message from SubGuardian.*`,
        ].join('\n'),
      });
    } catch { /* DMs disabled — skip silently */ }
    context.ui.showToast('Post removed and author notified.');
  },
});

Devvit.addMenuItem({
  label: 'SubGuardian: Open Leaderboard',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event: MenuItemOnPressEvent, context: Context) => {
    const redis = context.redis;
    const sub = context.subredditName ?? '';
    const oldId = await redis.get(Keys.leaderboardPostId);
    if (oldId) {
      try { await context.reddit.remove(oldId, false); } catch { /* already gone */ }
    }
    const post = await context.reddit.submitPost({
      subredditName: sub,
      title: 'SubGuardian Community Leaderboard',
      preview: renderLoadingSpinner('Leaderboard'),
      postData: { view: 'leaderboard' },
    });
    await redis.set(Keys.leaderboardPostId, post.id);
    try {
      await post.sticky(2);
    } catch {
      // Already 2 stickies — that's fine
    }
    context.ui.navigateTo(post.url);
  },
});

Devvit.addMenuItem({
  label: 'SubGuardian: Toggle Raid Mode',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event: MenuItemOnPressEvent, context: Context) => {
    const redis = context.redis;
    const current = await getActivePreset(redis);
    if (current === 'raid') {
      await redis.del(Keys.raidMode);
      await redis.del('sub:raid_mode:activated_at');
      await setPreset(redis, 'default');
      context.ui.showToast('Raid mode deactivated — reverted to Default preset.');
    } else {
      await redis.set(Keys.raidMode, '1');
      await redis.set('sub:raid_mode:activated_at', String(Date.now()));
      await setPreset(redis, 'raid');
      context.ui.showToast('Raid mode activated.');
    }
  },
});

Devvit.addMenuItem({
  label: 'SubGuardian: View Audit Log',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event: MenuItemOnPressEvent, context: Context) => {
    const entries = await getAuditLog(context.redis, 0, 5);
    const summary = entries
      .map((e) => `[${new Date(e.timestamp).toUTCString()}] ${e.action} — ${e.reason}`)
      .join('\n');
    context.ui.showToast(summary || 'No audit log entries yet.');
  },
});

// ─── Stats Report (modmail) ───────────────────────────────────────────────────

Devvit.addMenuItem({
  label: 'SubGuardian: Generate Stats Report',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event: MenuItemOnPressEvent, context: Context) => {
    const redis = context.redis;
    const subredditName = context.subredditName ?? '';

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const aggKey = Keys.aggPostsDaily(today);
    const reportKey = Keys.aggReportsDaily(today);

    const [
      total, removed, flagged, approved,
      avgTotal, lastBuilt,
      killSwitch, activePreset,
      config, auditEntries,
      reportTotal, reportActioned,
    ] = await Promise.all([
      redis.hGet(aggKey, 'total'),
      redis.hGet(aggKey, 'removed'),
      redis.hGet(aggKey, 'flagged'),
      redis.hGet(aggKey, 'approved'),
      redis.hGet('agg:posts:7d_avg', 'total'),
      redis.get('agg:last_built'),
      redis.get(Keys.killSwitch),
      getActivePreset(redis),
      getConfig(redis),
      getAuditLog(redis, 0, 10),
      redis.hGet(reportKey, 'total'),
      redis.hGet(reportKey, 'actioned'),
    ]);

    const estimatedBytes = parseInt((await redis.get('sys:redis:estimated_bytes')) ?? '0');
    const estimatedMB = (estimatedBytes / (1024 * 1024)).toFixed(1);
    const removalRate = parseInt(total ?? '0') > 0
      ? Math.round((parseInt(removed ?? '0') / parseInt(total ?? '0')) * 100)
      : 0;

    const featureList = Object.entries(config.features)
      .map(([k, v]) => `  - ${k}: ${v ? '✅' : '❌'}`)
      .join('\n');

    const auditList = auditEntries.length > 0
      ? auditEntries
          .map((e) => `  - [${new Date(e.timestamp).toUTCString()}] **${e.action}** — ${e.reason}`)
          .join('\n')
      : '  - No recent actions';

    const body = [
      `# SubGuardian Stats Report`,
      `Generated: ${new Date().toUTCString()}`,
      `Subreddit: r/${subredditName}`,
      '',
      `## Today's Activity`,
      `- Posts submitted: **${total ?? 0}**`,
      `- Removed: **${removed ?? 0}** (${removalRate}% removal rate)`,
      `- Flagged for review: **${flagged ?? 0}**`,
      `- Approved: **${approved ?? 0}**`,
      `- 7-day avg posts/day: **${avgTotal ?? 0}**`,
      '',
      `## Report Handling`,
      `- Total reports processed: **${reportTotal ?? 0}**`,
      `- Posts actioned via reports: **${reportActioned ?? 0}**`,
      '',
      `## System Status`,
      `- Active preset: **${activePreset}**`,
      `- Kill switch: **${killSwitch === '1' ? '🔴 ACTIVE' : '🟢 Off'}**`,
      `- Redis usage: **${estimatedMB} MB / 500 MB**`,
      `- Last aggregate build: ${lastBuilt ? new Date(parseInt(lastBuilt)).toUTCString() : 'Never'}`,
      '',
      `## Feature Toggles`,
      featureList,
      '',
      `## Recent Audit Log (last 10)`,
      auditList,
    ].join('\n');

    await context.reddit.modMail.createConversation({
      subredditName,
      subject: `SubGuardian Stats Report — ${new Date().toDateString()}`,
      body,
      isAuthorHidden: false,
    });

    context.ui.showToast('Stats report sent to mod mail.');
  },
});

// ─── DEV TOOLS — REMOVE BEFORE APP REVIEW ────────────────────────────────────

const setTrustForm = Devvit.createForm(
  {
    fields: [
      { type: 'number', name: 'score', label: 'Trust Score (0–1000)', defaultValue: 75 },
    ],
    title: 'Set User Trust Score',
    acceptLabel: 'Apply',
  },
  async (formEvent, formContext) => {
    const score = Math.max(0, Math.min(1000, Number(formEvent.values['score'] ?? 75)));
    const authorId = await formContext.redis.get('dev:pending_trust_authorId');
    if (!authorId) {
      formContext.ui.showToast('Session expired — press the menu item again.');
      return;
    }
    // Recompute tier from new score
    const tier =
      score <= 149 ? 'untrusted' :
      score <= 299 ? 'low' :
      score <= 499 ? 'neutral' :
      score <= 699 ? 'trusted' : 'highly_trusted';

    console.log(`[DEV:SetTrust] authorId=${authorId} requestedScore=${score} tier=${tier}`);
    const raw = await formContext.redis.get(Keys.userTrust(authorId));
    console.log(`[DEV:SetTrust] existing raw=${raw}`);
    const existing = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const updated = { ...existing, score, tier, lastUpdated: Date.now(), devOverride: true };
    await formContext.redis.set(Keys.userTrust(authorId), JSON.stringify(updated));
    await formContext.redis.zAdd(Keys.leaderboardTrust, { score, member: authorId });

    // Reset activity counters so recomputeTrust doesn't override this score on next approval
    const activityRaw = await formContext.redis.get(Keys.userActivity(authorId));
    const activity = activityRaw ? JSON.parse(activityRaw) as Record<string, unknown> : {};
    const approvedSubPosts = Math.floor(score / 15);
    const resetActivity = { ...activity, approvedSubPosts, totalSubPosts: approvedSubPosts };
    await formContext.redis.set(Keys.userActivity(authorId), JSON.stringify(resetActivity));
    console.log(`[DEV:SetTrust] reset activity approvedSubPosts=${approvedSubPosts}`);

    await formContext.redis.del('dev:pending_trust_authorId');
    const verify = await formContext.redis.get(Keys.userTrust(authorId));
    console.log(`[DEV:SetTrust] verified read-back=${verify}`);
    formContext.ui.showToast(`Trust score set to ${score} (${tier}) for user ${authorId}.`);
  }
);

Devvit.addMenuItem({
  label: 'SubGuardian: [DEV] Set User Trust Score',
  location: 'post',
  forUserType: 'moderator',
  onPress: async (event: MenuItemOnPressEvent, context: Context) => {
    const postId = event.targetId;
    const authorId = await context.redis.get(Keys.postAuthorId(postId));
    if (!authorId) {
      context.ui.showToast('No author ID cached for this post.');
      return;
    }
    await context.redis.set('dev:pending_trust_authorId', authorId, { expiration: new Date(Date.now() + 60_000) });
    context.ui.showForm(setTrustForm);
  },
});

const triggerJobForm = Devvit.createForm(
  {
    fields: [
      {
        type: 'select',
        name: 'job',
        label: 'Job to run',
        options: [
          { label: 'aggregate_builder', value: 'aggregate_builder' },
          { label: 'spike_detector', value: 'spike_detector' },
          { label: 'trust_decay', value: 'trust_decay' },
          { label: 'flair_vote_tallier', value: 'flair_vote_tallier' },
          { label: 'weekly_highlight', value: 'weekly_highlight' },
          { label: 'retry_queue_drain', value: 'retry_queue_drain' },
          { label: 'raid_mode_expiry', value: 'raid_mode_expiry' },
        ],
        defaultValue: ['aggregate_builder'],
      },
    ],
    title: 'Trigger Job Now',
    acceptLabel: 'Run',
  },
  async (formEvent, formContext) => {
    const jobName = (formEvent.values['job'] as string[])[0] ?? '';
    const ctx = formContext as unknown as JobContext;
    try {
      if (jobName === 'aggregate_builder') await runAggregateBuilder({} as never, ctx);
      else if (jobName === 'spike_detector') await runSpikeDetector({} as never, ctx);
      else if (jobName === 'trust_decay') await runTrustDecay({} as never, ctx);
      else if (jobName === 'flair_vote_tallier') await runFlairVoteTallier({} as never, ctx, true);
      else if (jobName === 'weekly_highlight') await runWeeklyHighlight({} as never, ctx);
      else if (jobName === 'raid_mode_expiry') await runRaidModeExpiry({} as never, ctx);
      else if (jobName === 'retry_queue_drain') {
        const { needsSaturationAlert } = await drainRetryQueue(ctx.redis, async (item) => {
          const { action, payload } = item;
          const data = JSON.parse(payload) as Record<string, unknown>;
          if (action === 'removal') await ctx.reddit.remove(data['targetId'] as string, false);
        });
        if (needsSaturationAlert) {
          await sendModAlert(ctx, ctx.redis, 'Rate Limit Saturated', 'Manually triggered drain found saturation.');
        }
      }
      formContext.ui.showToast(`Job "${jobName}" completed.`);
    } catch (e) {
      formContext.ui.showToast(`Job "${jobName}" failed: ${(e as Error).message}`);
    }
  }
);

Devvit.addMenuItem({
  label: 'SubGuardian: [DEV] Trigger Job Now',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: (_event: MenuItemOnPressEvent, context: Context) => {
    context.ui.showForm(triggerJobForm);
  },
});

Devvit.addMenuItem({
  label: 'SubGuardian: [DEV] Clear Test Caches',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event: MenuItemOnPressEvent, context: Context) => {
    const redis = context.redis;
    // Clear title + selftext duplicate caches
    await redis.del(Keys.cacheTitles);
    await redis.del(Keys.cacheSelftextHashes);
    // Clear per-user post rate limit keys
    const rateLimitKeys = await redis.zRange('ratelimit:posts:index', 0, -1);
    for (const { member } of rateLimitKeys) {
      await redis.del(`ratelimit:posts:user:${member}`);
    }
    await redis.del('ratelimit:posts:index');
    // Reset activity counters for all tracked users — deleted posts should not count
    const allUsers = await redis.zRange(Keys.leaderboardTrust, 0, -1);
    for (const { member } of allUsers) {
      if (!member.startsWith('t2_')) continue;
      const raw = await redis.get(Keys.userActivity(member));
      if (!raw) continue;
      const activity = JSON.parse(raw) as Record<string, unknown>;
      const reset = {
        ...activity,
        totalSubPosts: 0,
        approvedSubPosts: 0,
        removedPosts: 0,
      };
      await redis.set(Keys.userActivity(member), JSON.stringify(reset));
      console.log(`[DEV:ClearCaches] reset activity for ${member}`);
    }
    context.ui.showToast('Test caches cleared — duplicates, rate limits, and post counts reset.');
  },
});

// ─────────────────────────────────────────────────────────────────────────────

export default Devvit;
