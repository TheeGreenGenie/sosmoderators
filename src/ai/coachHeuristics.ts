/**
 * Heuristic intent handlers for SubGuardian Coach.
 * Each handler reads from a pre-built CoachContext (and optionally Redis)
 * and returns a formatted text response for display in the Coach tab.
 */

import type { RedisClient } from '@devvit/public-api';
import type { CoachContext } from './coachContext.js';
import type { ExtractedEntities, IntentId } from '../utils/intentScoring.js';
import { scoreIntents, disambiguate, MIN_INTENT_SCORE } from '../utils/intentScoring.js';
import type { TrustScore, ActivityCounters, SpamScore, AuditEntry } from '../redis/schema.js';
import { Keys } from '../redis/schema.js';

// ─── Signal labels and fix suggestions ───────────────────────────────────────

const SIGNAL_COPY: Record<string, { label: string; fix: string }> = {
  title_duplicate: {
    label: 'Very similar title posted recently',
    fix: 'Rephrase your title significantly or comment on the existing post instead.',
  },
  selftext_duplicate: {
    label: 'Body text nearly identical to a recent post',
    fix: 'Add original content or perspective to differentiate your post.',
  },
  domain_banned: {
    label: 'Link from a restricted domain',
    fix: 'Use an approved source or share the information directly in the post body.',
  },
  banned_keyword: {
    label: 'Contains a phrase on the spam list',
    fix: 'Remove or rephrase the flagged term.',
  },
  url_in_title: {
    label: 'URL detected in post title',
    fix: 'Move the link to the post body.',
  },
  high_url_density: {
    label: 'Post body contains too many links (>15% of words)',
    fix: 'Reduce the number of links and add more original text.',
  },
  excessive_caps: {
    label: '3+ words in ALL CAPS',
    fix: 'Use normal capitalisation in your title.',
  },
  excessive_punctuation: {
    label: '3+ consecutive ! or ? marks',
    fix: 'Use standard punctuation.',
  },
  very_new_account: {
    label: 'Account is very new (< 7 days old)',
    fix: 'This flag clears automatically as you participate more in the community.',
  },
};

// ─── STOPWORDS for keyword extraction ────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'are', 'from', 'have', 'been',
  'was', 'not', 'but', 'you', 'they', 'your', 'our', 'will', 'can', 'all',
  'about', 'just', 'more', 'how', 'what', 'when', 'who', 'why', 'its', 'is',
  'it', 'be', 'has', 'had', 'an', 'a', 'in', 'on', 'at', 'to', 'of', 'or',
  'by', 'up', 'do', 'did', 'get', 'got', 'my', 'me', 'we', 'he', 'she', 'if',
  'so', 'as', 'out', 'no', 'go', 'see', 'use', 'would', 'could', 'should',
  'post', 'reddit', 'sub', 'subreddit', 'removed', 'flagged', 'spam',
]);

// ─── Response helpers ─────────────────────────────────────────────────────────

function freshnessBadge(lastBuilt: string | null): string {
  if (!lastBuilt) return '(data not yet available — run aggregate builder)';
  return `(data as of ${lastBuilt}, updated every 15 min)`;
}

function tierLabel(tier: string): string {
  const labels: Record<string, string> = {
    grace: 'Grace (new user)',
    untrusted: 'Untrusted (0-149)',
    low: 'Low (150-299)',
    neutral: 'Neutral (300-499)',
    trusted: 'Trusted (500-699)',
    highly_trusted: 'Highly Trusted (700+)',
  };
  return labels[tier] ?? tier;
}

// ─── Individual intent handlers ───────────────────────────────────────────────

async function handleWhyFlaggedPost(
  ctx: CoachContext,
  entities: ExtractedEntities,
  redis: RedisClient,
): Promise<string> {
  let postId = entities.postId;

  // Fallback: use most recent audit entry with post_flagged or post_removed action
  if (!postId) {
    const recent = ctx.auditLog.find(
      (e) => (e.action === 'post_flagged' || e.action === 'post_removed') && e.targetType === 'post',
    );
    if (recent) {
      postId = recent.targetId;
    }
  }

  if (!postId) {
    return [
      'I could not identify a specific post to look up.',
      '',
      'To check why a post was flagged, ask: "Why was post t3_[id] flagged?"',
      'You can find the post ID in the URL: reddit.com/r/sub/comments/[id]/...',
      '',
      'Your most recent audit events:',
      ...ctx.auditLog.slice(0, 3).map((e) => `  • [${e.action}] ${e.reason.slice(0, 80)}`),
    ].join('\n');
  }

  const scoreRaw = await redis.get(Keys.postScore(postId));
  if (!scoreRaw) {
    return [
      `I don't have a spam analysis for post ${postId}.`,
      '',
      'The post may have been submitted before SubGuardian was installed,',
      'or it passed all checks without triggering any signals.',
    ].join('\n');
  }

  const spam = JSON.parse(scoreRaw) as SpamScore;
  const flagThreshold = ctx.config.spamDetection.autoFlagThreshold;
  const removeThreshold = ctx.config.spamDetection.autoRemoveThreshold;

  const signalLines = spam.signals.map((sig) => {
    const copy = SIGNAL_COPY[sig];
    return copy ? `  • ${copy.label}` : `  • ${sig}`;
  });

  const action = spam.score >= removeThreshold ? 'AUTO-REMOVED' : spam.score >= flagThreshold ? 'FLAGGED for review' : 'passed (below thresholds)';

  return [
    `Post ${postId} spam analysis:`,
    '',
    `Score: ${spam.score.toFixed(2)}  |  Action: ${action}`,
    `Flag threshold: ${flagThreshold.toFixed(2)}  |  Remove threshold: ${removeThreshold.toFixed(2)}`,
    '',
    spam.signals.length > 0 ? 'Signals that fired:' : 'No signals fired.',
    ...signalLines,
    '',
    `Analysed at: ${new Date(spam.computedAt).toUTCString()}`,
  ].join('\n');
}

async function handleUserProfile(
  ctx: CoachContext,
  entities: ExtractedEntities,
  redis: RedisClient,
  reddit: { getUserByUsername: (name: string) => Promise<{ id: string } | null> } | null,
): Promise<string> {
  const username = entities.username;
  if (!username) {
    // Show recent flagged users from audit log
    const recentUsers = ctx.auditLog
      .filter((e) => e.targetType === 'user' || (e.targetType === 'post' && e.actor))
      .slice(0, 3)
      .map((e) => `  • ${e.actor} — ${e.action} (${new Date(e.timestamp).toUTCString()})`);

    return [
      "I didn't catch a specific username. Ask like: \"Is u/username a problem?\"",
      '',
      recentUsers.length > 0 ? 'Recent user activity in audit log:' : 'No recent user activity on record.',
      ...recentUsers,
    ].join('\n');
  }

  // Handle special usernames
  if (username.toLowerCase() === 'deleted') {
    return 'That account is deleted — no record exists in this subreddit.';
  }
  if (username.toLowerCase() === 'automoderator') {
    return 'AutoModerator is a Reddit system account — it is not tracked by SubGuardian.';
  }

  // Resolve username → userId
  let userId: string | null = null;
  if (reddit) {
    try {
      const user = await reddit.getUserByUsername(username);
      userId = user?.id ?? null;
      // Ensure userId has t2_ prefix
      if (userId && !userId.startsWith('t2_')) userId = `t2_${userId}`;
    } catch {
      userId = null;
    }
  }

  if (!userId) {
    return [
      `I don't have a record for u/${username} in this subreddit.`,
      'They may not have posted here yet, or the username might be spelled differently.',
      '',
      'Top trusted users in this sub:',
      ...ctx.topTrustUsers.slice(0, 3).map((u) => `  • u/${u.username} — Trust ${u.score}`),
    ].join('\n');
  }

  const [trustRaw, activityRaw] = await Promise.all([
    redis.get(Keys.userTrust(userId)),
    redis.get(Keys.userActivity(userId)),
  ]);

  if (!trustRaw) {
    return [
      `u/${username} exists on Reddit but has no SubGuardian trust record in r/${ctx.subredditName}.`,
      'They have not posted here while SubGuardian has been active.',
    ].join('\n');
  }

  const trust = JSON.parse(trustRaw) as TrustScore;
  const activity = activityRaw ? (JSON.parse(activityRaw) as ActivityCounters) : null;
  const c = trust.components;

  const verdict =
    (activity?.removedPosts ?? 0) > 0 && (activity?.actionedReportsAgainst ?? 0) > 0
      ? '⚠  This user has prior violations. Review borderline posts carefully.'
      : (activity?.removedPosts ?? 0) === 0 && (activity?.totalSubPosts ?? 0) > 5
        ? '✓  Clean record. Treat as a good-faith contributor.'
        : '— Insufficient data to make a strong recommendation yet.';

  return [
    `u/${username} — Trust ${trust.score} (${tierLabel(trust.tier)})`,
    '',
    'Activity in r/' + ctx.subredditName + ':',
    `  Total posts: ${activity?.totalSubPosts ?? 0}  |  Approved: ${activity?.approvedSubPosts ?? 0}  |  Removed: ${activity?.removedPosts ?? 0}`,
    `  Reports made (actioned): ${activity?.helpfulReportCount ?? 0}`,
    `  Reports received (actioned): ${activity?.actionedReportsAgainst ?? 0}`,
    `  Temp bans: ${activity?.tempBanCount ?? 0}`,
    '',
    'Trust components:',
    `  Account age:    +${c.accountAge.toFixed(0)}`,
    `  Subreddit karma: +${c.subKarma.toFixed(0)}`,
    `  Approval history: +${c.approvalRate.toFixed(0)}`,
    `  Positive signals: +${c.positiveSignals.toFixed(0)}`,
    `  Penalties:       −${c.penalties.toFixed(0)}`,
    '',
    verdict,
  ].join('\n');
}

function handleSuggestKeywords(ctx: CoachContext): string {
  const removals = ctx.auditLog.filter(
    (e) => (e.action === 'post_removed' || e.action === 'post_flagged') && e.reason,
  );

  if (removals.length < 10) {
    return [
      `Not enough removal data yet (${removals.length} removals on record).`,
      'Keep moderation active for a few days to build a keyword pattern.',
      '',
      'Currently configured keywords:',
      ctx.config.spamDetection.bannedKeywords.length > 0
        ? ctx.config.spamDetection.bannedKeywords.map((k) => `  • ${k}`).join('\n')
        : '  None configured yet.',
    ].join('\n');
  }

  // Extract tokens from removal reasons
  const removalTokenFreq: Record<string, number> = {};
  for (const entry of removals) {
    const tokens = entry.reason
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
    for (const t of tokens) {
      removalTokenFreq[t] = (removalTokenFreq[t] ?? 0) + 1;
    }
  }

  // Filter to tokens not already in banned list
  const existing = new Set(ctx.config.spamDetection.bannedKeywords.map((k) => k.toLowerCase()));
  const candidates = Object.entries(removalTokenFreq)
    .filter(([t, freq]) => freq >= 2 && !existing.has(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (candidates.length === 0) {
    return [
      'No new keyword candidates found from your recent removals.',
      'Your current removals are too varied to identify clear recurring patterns,',
      'or all frequent terms are already on your spam list.',
    ].join('\n');
  }

  const lines = candidates.map(
    ([kw, freq]) => `  • "${kw}" — appeared in ${freq} removal reason(s)`,
  );

  return [
    `Based on ${removals.length} removals in your audit log:`,
    '',
    'Top keyword candidates:',
    ...lines,
    '',
    'To add one: Config UI → Thresholds → Banned Keywords.',
    'Or use Shadow-Audit mode (when available) to test before going live.',
  ].join('\n');
}

function handleExplainConfig(ctx: CoachContext): string {
  const { config } = ctx;
  const kws = config.spamDetection.bannedKeywords;
  const raidGates = config.antiRaid.gates;

  return [
    `SubGuardian configuration for r/${ctx.subredditName}:`,
    '',
    `Spam detection: ${config.features.spamDetection ? 'ON' : 'OFF'}`,
    `  Auto-flag threshold:   ${config.spamDetection.autoFlagThreshold.toFixed(2)}`,
    `  Auto-remove threshold: ${config.spamDetection.autoRemoveThreshold.toFixed(2)}`,
    `  Banned keywords: ${kws.length > 0 ? kws.slice(0, 5).join(', ') + (kws.length > 5 ? ` (+${kws.length - 5} more)` : '') : 'none configured'}`,
    '',
    `Anti-raid: ${config.features.antiRaid ? 'ON' : 'OFF'} — Preset: ${ctx.preset}`,
    `  Min account age: ${raidGates.accountAgeDays.enabled ? raidGates.accountAgeDays.minimum + ' days' : 'gate off'}`,
    `  Min karma: ${raidGates.minKarma.enabled ? raidGates.minKarma.minimum : 'gate off'}`,
    `  Min trust score: ${raidGates.minTrustScore.enabled ? raidGates.minTrustScore.minimum : 'gate off'}`,
    `  Posts per day: ${raidGates.postsPerDay.enabled ? raidGates.postsPerDay.limit : 'gate off'}`,
    '',
    `Flair voting: ${config.flairVoting.enabled ? 'ON' : 'OFF'}`,
    `  Min trust to vote: ${config.flairVoting.minTrustToVote}`,
    `  Approval ratio: ${Math.round(config.flairVoting.approvalRatio * 100)}%`,
    '',
    `Kill switch: ${ctx.killSwitchActive ? '🔴 ON — all automation paused' : '🟢 OFF — running normally'}`,
  ].join('\n');
}

function handleExplainTrust(ctx: CoachContext): string {
  return [
    `SubGuardian Trust Score System — r/${ctx.subredditName}`,
    '',
    'Scores run 0–1000 and update after every moderation event.',
    '',
    '  Grace (new user)      First 5 approved posts — lighter scrutiny',
    '  Untrusted     0–149   Full spam checks, strictest gates',
    '  Low         150–299   Reduced report weight (0.5×)',
    '  Neutral     300–499   Normal (1.0× weight)',
    '  Trusted     500–699   Elevated report weight (1.5×)',
    '  Highly Trusted 700+   Bypasses ALL raid/strict mode gates',
    '',
    'Trust is built by:',
    '  +150 max from account age (1pt per 7.5 days)',
    '  +120 max from subreddit karma (log-scaled)',
    '  +15 per approved post (max +150)',
    '  +10/+5/+15 for awards, top posts, adopted flair proposals',
    '',
    'Trust is lost by:',
    '  −15 per removed post',
    '  −20 per actioned report against you',
    '  −75 per temp ban',
    '  −300 per permanent ban',
    '',
    `Min trust to vote on flair proposals: ${ctx.config.flairVoting.minTrustToVote}`,
    '',
    'Trust decays 5%/week for users inactive 90+ days (floor: 300).',
  ].join('\n');
}

function handleWhatDoFirst(ctx: CoachContext): string {
  const { config } = ctx;
  const kws = config.spamDetection.bannedKeywords;
  const items: string[] = [];
  let n = 1;

  if (kws.length < 3) {
    items.push(`${n++}. Add spam keywords — you have only ${kws.length} configured.`);
    items.push('   Tip: ask "Suggest spam keywords" for data-driven suggestions.');
  }
  if (!config.features.antiRaid) {
    items.push(`${n++}. Enable anti-raid mode — currently off.`);
    items.push('   Start with the Default preset in Config UI → Presets.');
  }
  if (!config.flairVoting.minTrustToVote || config.flairVoting.minTrustToVote === 0) {
    items.push(`${n++}. Set minTrustToVote in Config UI → Thresholds. Most subs use 300.`);
  }
  if (!config.features.flairAutoAssign) {
    items.push(`${n++}. Enable flair auto-assign — helps organise posts automatically.`);
  }
  if (!config.ai.apiKeyConfigured) {
    items.push(`${n++}. (Optional) Set LLM_API_KEY to unlock open Q&A in Coach.`);
  }

  if (items.length === 0) {
    return [
      `r/${ctx.subredditName} looks well configured.`,
      '',
      'Next steps:',
      '  • Review the audit log for any unexpected actions.',
      '  • Check the pending review queue for flagged posts.',
      '  • Monitor the spike detector alerts in modmail.',
    ].join('\n');
  }

  return [
    `Setup priority list for r/${ctx.subredditName}:`,
    '',
    ...items,
  ].join('\n');
}

function handleRaidStatus(ctx: CoachContext): string {
  const now = new Date();
  const hourLabels = Array.from({ length: 4 }, (_, i) => {
    const d = new Date(now.getTime() - (3 - i) * 3_600_000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`;
  });

  const hourLines = ctx.hourlyPostCounts.map(
    (count, i) => `  ${hourLabels[i]}: ${count} post${count !== 1 ? 's' : ''}`,
  );

  const maxCount = Math.max(...ctx.hourlyPostCounts);
  const avgCount = ctx.weekAvgStats.postsPerDay > 0 ? ctx.weekAvgStats.postsPerDay / 24 : 0;
  const spikeNote =
    avgCount > 0 && maxCount >= avgCount * 2.5
      ? `⚠  Volume spike detected — current peak is ${(maxCount / avgCount).toFixed(1)}× the hourly average.`
      : '  Volume looks normal — no spike detected.';

  return [
    `Raid / Spike Status — r/${ctx.subredditName}`,
    '',
    `Raid mode: ${ctx.raidModeActive ? `🔴 ACTIVE (${ctx.preset} preset)` : `🟢 Inactive (${ctx.preset} preset)`}`,
    ctx.raidModeActive
      ? `  Gates: min account age ${ctx.config.antiRaid.gates.accountAgeDays.minimum}d, min trust ${ctx.config.antiRaid.gates.minTrustScore.minimum}`
      : '',
    '',
    'Post volume (last 4 hours):',
    ...hourLines,
    '',
    spikeNote,
    ctx.raidModeActive ? '' : '  To activate raid preset: reply !raid to any spike modmail alert.',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

function handleStatsSummary(ctx: CoachContext): string {
  const { todayStats: t, weekAvgStats: a } = ctx;
  const removalRate = t.posts > 0 ? ((t.removed / t.posts) * 100).toFixed(1) : '0.0';
  const avgRemovalRate = a.postsPerDay > 0 ? ((a.removalsPerDay / a.postsPerDay) * 100).toFixed(1) : '0.0';
  const aboveAvg = a.removalsPerDay > 0 && t.removed > a.removalsPerDay * 1.5;

  if (!ctx.lastBuilt) {
    return [
      'SubGuardian is still warming up — no aggregate data collected yet.',
      '',
      'Run: Subreddit Menu → SubGuardian: [DEV] Trigger Job Now → aggregate_builder',
      'to seed the first data snapshot.',
    ].join('\n');
  }

  return [
    `Activity summary — r/${ctx.subredditName} ${freshnessBadge(ctx.lastBuilt)}`,
    '',
    'Today:',
    `  Posts: ${t.posts}  |  Approved: ${t.approved}  |  Flagged: ${t.flagged}  |  Removed: ${t.removed}`,
    `  Removal rate: ${removalRate}%`,
    '',
    '7-day averages:',
    `  ${a.postsPerDay} posts/day  |  ${a.removalsPerDay} removals/day (${avgRemovalRate}%)  |  ${a.flagsPerDay} flags/day`,
    '',
    aboveAvg
      ? `⚠  Today's removals are ${(t.removed / a.removalsPerDay).toFixed(1)}× your 7-day average — worth reviewing.`
      : '✓  Removal rate looks normal.',
  ].join('\n');
}

function handlePendingPosts(ctx: CoachContext): string {
  const flagged = ctx.auditLog.filter(
    (e) => e.action === 'post_flagged' && e.targetType === 'post',
  );
  const recentlyResolved = new Set(
    ctx.auditLog
      .filter((e) => e.action === 'post_approved' || e.action === 'post_removed')
      .map((e) => e.targetId),
  );
  const pending = flagged.filter((e) => !recentlyResolved.has(e.targetId)).slice(0, 5);

  return [
    `Pending Review — r/${ctx.subredditName}`,
    '',
    pending.length === 0
      ? '✓  No pending flagged posts found in recent audit log.'
      : `${pending.length} recently flagged post(s) (may not be exhaustive):`,
    ...pending.map(
      (e) =>
        `  • ${e.targetId} — score: ${e.score?.toFixed(2) ?? '?'}  [${e.reason.slice(0, 60)}]`,
    ),
    '',
    `Today: ${ctx.todayStats.flagged} flagged, ${ctx.todayStats.removed} removed, ${ctx.todayStats.approved} approved.`,
    '',
    'For the full queue: Dashboard → Pending Review tab.',
  ].join('\n');
}

async function handleAppealGuidance(
  ctx: CoachContext,
  entities: ExtractedEntities,
  redis: RedisClient,
  reddit: { getUserByUsername: (name: string) => Promise<{ id: string } | null> } | null,
): Promise<string> {
  const username = entities.username;
  if (!username) {
    return [
      'To get appeal guidance for a specific user, ask: "Handle appeal from u/username"',
      '',
      `Your appeals cooldown is ${ctx.config.appeals.cooldownDays} days.`,
      'To process an appeal: reply !appeal in the modmail thread from the user.',
    ].join('\n');
  }

  let userId: string | null = null;
  if (reddit) {
    try {
      const user = await reddit.getUserByUsername(username);
      userId = user?.id ?? null;
      if (userId && !userId.startsWith('t2_')) userId = `t2_${userId}`;
    } catch {
      userId = null;
    }
  }

  if (!userId) {
    return `I couldn't find a Reddit account for u/${username}. They may have been deleted or the username is different.`;
  }

  const [trustRaw, activityRaw, appealLogRaw] = await Promise.all([
    redis.get(Keys.userTrust(userId)),
    redis.get(Keys.userActivity(userId)),
    redis.get(Keys.userAppealLog(userId)),
  ]);

  if (!trustRaw) {
    return `u/${username} has no SubGuardian record in r/${ctx.subredditName} — they have not posted here while SubGuardian has been active.`;
  }

  const trust = JSON.parse(trustRaw) as TrustScore;
  const activity = activityRaw ? (JSON.parse(activityRaw) as ActivityCounters) : null;
  const appealLog: Array<{ timestamp: number; summary: string; outcome: string }> =
    appealLogRaw ? (JSON.parse(appealLogRaw) as typeof appealLog) : [];

  const ageDays = Math.floor(
    (trust.components.accountAge / 150) * (150 * 7.5),
  );

  let recommendation: string;
  if (appealLog.length === 1 && (activity?.removedPosts ?? 0) < 2 && ageDays > 180) {
    recommendation = 'First appeal, established account. Consider approving with a warning.';
  } else if (appealLog.length >= 3 || (activity?.tempBanCount ?? 0) >= 2) {
    recommendation = 'Repeat appealer or multiple bans. Review carefully — likely deny.';
  } else {
    recommendation = 'Mixed signals. Review the original removal reason and use your judgment.';
  }

  return [
    `Appeal guidance — u/${username}`,
    '',
    `Appeals on record: ${appealLog.length}  |  Last: ${appealLog.length > 0 ? new Date(appealLog[appealLog.length - 1]!.timestamp).toUTCString() : 'none'}`,
    '',
    'User context:',
    `  Trust: ${trust.score} (${tierLabel(trust.tier)})`,
    `  Approved posts: ${activity?.approvedSubPosts ?? 0}  |  Removed: ${activity?.removedPosts ?? 0}`,
    `  Temp bans: ${activity?.tempBanCount ?? 0}`,
    '',
    `Suggested approach: ${recommendation}`,
    '',
    'To get an AI summary: reply !appeal in the modmail thread from this user.',
  ].join('\n');
}

function handleDraftRemovalPM(ctx: CoachContext, entities: ExtractedEntities): string {
  const signal = entities.signalName;
  const copy = signal ? SIGNAL_COPY[signal] : null;
  const flagThreshold = ctx.config.spamDetection.autoFlagThreshold;

  const signalLine = copy
    ? `  • ${copy.label}`
    : '  • [describe the specific issue here]';
  const fixLine = copy ? copy.fix : '[Explain what they can do to get their post approved]';

  return [
    `Removal PM template for r/${ctx.subredditName}:`,
    '',
    '---',
    'Hi u/[AUTHOR] — your post "[TITLE]" was held for review on r/' + ctx.subredditName + '.',
    '',
    'What triggered it:',
    signalLine,
    `  Total score: [SCORE] (flag threshold: ${flagThreshold.toFixed(2)})`,
    '',
    'To get it approved:',
    `  ${fixLine}`,
    '',
    'After editing, reply to this message with:  !recheck',
    'SubGuardian will re-run the check automatically.',
    '',
    '*Automated message from SubGuardian. If you think this is wrong, contact the mods.*',
    '---',
    '',
    'Copy the template above and send it via Reddit\'s modmail or as a PM.',
    `Available signal types: ${Object.keys(SIGNAL_COPY).join(', ')}`,
  ].join('\n');
}

function handleSystemStatus(ctx: CoachContext): string {
  const features = ctx.config.features;
  const featureLines = [
    `  Spam detection:   ${features.spamDetection ? '✓ ON' : '✗ OFF'}`,
    `  Report handling:  ${features.reportHandling ? '✓ ON' : '✗ OFF'}`,
    `  Anti-raid:        ${features.antiRaid ? '✓ ON' : '✗ OFF'}`,
    `  Ban evasion:      ${features.banEvasion ? '✓ ON' : '✗ OFF'}`,
    `  Flair auto-assign:${features.flairAutoAssign ? '✓ ON' : '✗ OFF'}`,
    `  Trust scoring:    ${features.trustScoring ? '✓ ON' : '✗ OFF'}`,
  ];

  const aiMode =
    ctx.config.ai.apiKeyConfigured && ctx.config.ai.apiEndpoint
      ? 'LLM active (open questions enabled)'
      : ctx.config.ai.apiKeyConfigured
        ? 'Key set but endpoint missing — using heuristic mode'
        : 'Heuristic mode — set LLM_API_KEY to enable open questions';

  return [
    `SubGuardian System Status — r/${ctx.subredditName}`,
    '',
    `Kill switch: ${ctx.killSwitchActive ? '🔴 ON — all automation paused' : '🟢 OFF — running normally'}`,
    `Preset: ${ctx.preset}  |  Raid mode: ${ctx.raidModeActive ? '🔴 ACTIVE' : '🟢 Inactive'}`,
    '',
    `Aggregate data: ${ctx.lastBuilt ? `last built ${ctx.lastBuilt}` : 'no data yet — run aggregate_builder'}`,
    '',
    `AI: ${aiMode}`,
    '',
    `Redis: ~${ctx.redisUsagePct}% of 500 MB cap${ctx.redisUsagePct > 80 ? ' ⚠  APPROACHING LIMIT' : ''}`,
    '',
    'Feature toggles:',
    ...featureLines,
  ].join('\n');
}

function buildUnknownIntentResponse(): string {
  return [
    'I can answer questions about this specific subreddit. Try asking:',
    '',
    '  • "Why was [post id] flagged?"',
    '  • "Is u/[username] a problem?"',
    '  • "What should I do first as a new mod?"',
    '  • "Suggest spam keywords to block"',
    '  • "Explain the trust score system"',
    '  • "How many posts were removed today?"',
    '  • "What is the current system status?"',
    '  • "Is raid mode active?"',
    '  • "Show my config settings"',
    '',
    'For open-ended questions, configure an LLM API key in settings.',
  ].join('\n');
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

export async function computeCoachAnswer(
  ctx: CoachContext,
  intentId: IntentId,
  entities: ExtractedEntities,
  redis: RedisClient,
  reddit: { getUserByUsername: (name: string) => Promise<{ id: string } | null> } | null,
): Promise<string> {
  try {
    switch (intentId) {
      case 'WHY_FLAGGED_POST':
        return await handleWhyFlaggedPost(ctx, entities, redis);
      case 'USER_PROFILE':
        return await handleUserProfile(ctx, entities, redis, reddit);
      case 'SUGGEST_KEYWORDS':
        return handleSuggestKeywords(ctx);
      case 'EXPLAIN_CONFIG':
        return handleExplainConfig(ctx);
      case 'EXPLAIN_TRUST':
        return handleExplainTrust(ctx);
      case 'WHAT_DO_FIRST':
        return handleWhatDoFirst(ctx);
      case 'RAID_STATUS':
        return handleRaidStatus(ctx);
      case 'STATS_SUMMARY':
        return handleStatsSummary(ctx);
      case 'PENDING_POSTS':
        return handlePendingPosts(ctx);
      case 'APPEAL_GUIDANCE':
        return await handleAppealGuidance(ctx, entities, redis, reddit);
      case 'DRAFT_REMOVAL_PM':
        return handleDraftRemovalPM(ctx, entities);
      case 'SYSTEM_STATUS':
        return handleSystemStatus(ctx);
      case 'UNKNOWN':
      default:
        return buildUnknownIntentResponse();
    }
  } catch (err) {
    return [
      'Something went wrong while processing your question.',
      err instanceof Error ? `Details: ${err.message}` : '',
      '',
      buildUnknownIntentResponse(),
    ].join('\n');
  }
}

export async function computeCoachAnswerFromQuery(
  question: string,
  ctx: CoachContext,
  redis: RedisClient,
  reddit: { getUserByUsername: (name: string) => Promise<{ id: string } | null> } | null,
  lastEntityRaw: string | null,
): Promise<{ answer: string; resolvedEntity: string | null }> {
  let lastEntity = null;
  if (lastEntityRaw) {
    try {
      lastEntity = JSON.parse(lastEntityRaw) as import('../utils/intentScoring.js').LastEntity;
    } catch { /* ignore */ }
  }

  const scores = scoreIntents(question, lastEntity);
  const entities = scores[0]?.entities ?? {};
  const intentId = disambiguate(scores, entities);

  let resolvedEntity: string | null = null;
  if (entities.username) {
    resolvedEntity = JSON.stringify({ type: 'username', value: entities.username });
  } else if (entities.postId) {
    resolvedEntity = JSON.stringify({ type: 'postId', value: entities.postId });
  }

  const answer = await computeCoachAnswer(
    ctx,
    intentId === 'UNKNOWN' || scores[0] === undefined || scores[0].score < MIN_INTENT_SCORE
      ? 'UNKNOWN'
      : intentId,
    entities,
    redis,
    reddit,
  );

  return { answer, resolvedEntity };
}

export { buildUnknownIntentResponse };
