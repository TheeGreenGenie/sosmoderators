import type { TriggerEventType, TriggerContext } from '@devvit/public-api';
import { triggerGuard, isFeatureEnabled } from '../moderation/killSwitch.js';
import { checkBanEvasion } from '../moderation/banEvasion.js';
import { getConfig } from '../redis/config.js';
import { getTrustScore, getActivity, setGrace, removeGrace, isInGrace, setTrustScore, updateActivity } from '../redis/users.js';
import { isTitleDuplicate, isSelftextDuplicate, isDomainBanned, addTitleToCache, addSelftextToCache, getPostCountToday, incrementPostCountToday } from '../redis/posts.js';
import { setSpamScore } from '../redis/posts.js';
import { incrementPostAgg, incrementHourlyPost, incrementHourlyNewUser } from '../redis/aggregates.js';
import { computeSpamScore, getSpamAction } from '../scoring/spamScore.js';
import { buildTrustScore } from '../scoring/trustScore.js';
import { extractUrls, extractDomain } from '../utils/regex.js';
import { removePost, flairPost, sendModAlert } from '../moderation/actions.js';
import { getAIProvider } from '../ai/interface.js';
import { FLAIR_CONFIDENCE, TRUST } from '../utils/constants.js';
import type { ActivityCounters, FlairSuggestion, PostMeta, RecoveryRecord, ShadowAuditEntry, SpamScore } from '../redis/schema.js';
import { Keys, weekKey } from '../redis/schema.js';
import { formatWhyRemovedPM, signalLabel, signalFix } from '../utils/pmTemplates.js';
import { logAction } from '../moderation/auditLog.js';

export async function onPostSubmit(event: TriggerEventType['PostSubmit'], context: TriggerContext): Promise<void> {
  const redis = context.redis;
  const eventId = event.post?.id ?? '';
  console.log(`[PostSubmit] fired — postId=${eventId}`);

  const guard = await triggerGuard(redis, `post:${eventId}`);
  if (!guard.proceed) {
    console.log(`[PostSubmit] aborted — reason=${guard.reason}`);
    return;
  }
  const spamEnabled = await isFeatureEnabled(redis, 'spamDetection');
  if (!spamEnabled) {
    console.log(`[PostSubmit] spamDetection feature disabled — skipping spam checks`);
  }

  const config = await getConfig(redis);
  const post = event.post;
  const author = event.author;
  if (!post || !author) {
    console.log(`[PostSubmit] missing post or author`);
    return;
  }

  const userId = author.id ?? '';
  const postId = post.id ?? '';

  // Always overwrite so renames are picked up immediately
  if (userId && author.name) {
    await redis.set(Keys.userUsername(userId), author.name);
  }

  await cachePostMeta(redis, {
    postId,
    title: post.title ?? '',
    selftext: post.selftext ?? '',
    url: post.url ?? null,
    authorId: userId,
    authorName: author.name ?? '',
    permalink: post.permalink ?? '',
    createdAt: Date.now(),
  });

  // Fetch / initialize user state
  let trustRecord = await getTrustScore(redis, userId);
  const activity = await getActivity(redis, userId);
  const inGrace = await isInGrace(redis, userId);

  // Initialize new user
  if (!trustRecord) {
    await setGrace(redis, userId);
    const newTrust = buildTrustScore(
      {
        accountAgeDays: 0,
        subKarma: 0,
        totalSubPosts: 0,
        approvedSubPosts: 0,
        removedPosts: 0,
        actionedReportsAgainst: 0,
        tempBanCount: 0,
        permBanHistory: 0,
        awardsReceived: 0,
        topPostCount: 0,
        helpfulReportCount: 0,
        proposedFlairsAdopted: 0,
      },
      true
    );
    await setTrustScore(redis, userId, newTrust);
    trustRecord = newTrust;
    await incrementHourlyNewUser(redis);
  }

  // Ban evasion check
  if (config.features.banEvasion) {
    const username = author.name ?? '';
    const evasionResult = await checkBanEvasion(redis, username, 0, Date.now());
    if (evasionResult.suspicious) {
      await sendModAlert(
        context,
        redis,
        'Possible Ban Evasion Detected',
        `User u/${username} may be evading a ban.\n\n` +
          `Reason: ${evasionResult.reason ?? 'Username similarity'}\n` +
          `Post: https://reddit.com${post.permalink ?? ''}`
      );
    }
  }

  // Anti-raid check
  if (config.features.antiRaid && config.antiRaid.enabled) {
    const antiRaidResult = await antiRaidCheck(userId, author, config, redis);
    if (antiRaidResult.blocked) {
      await removePost({
        context,
        redis,
        targetId: post.id ?? '',
        targetType: 'post',
        actor: 'SubGuardian:antiRaid',
        reason: antiRaidResult.reason ?? 'Anti-raid gate triggered',
      });
      await incrementPostAgg(redis, 'removed');
      await applyTrustPenalty(redis, userId, 30);
      return;
    }
  }

  // Per-user post rate limit: max 2 posts per 5 min — sosmoderators exempt, togglable via config
  const isMod = (author.name ?? '') === 'sosmoderators';
  const rateLimitEnabled = (await getConfig(redis)).features.postRateLimit ?? true;
  if (!isMod && rateLimitEnabled) {
    const POST_RATE_WINDOW_MS = 5 * 60_000;
    const POST_RATE_MAX = 2;
    const rateLimitKey = `ratelimit:posts:user:${userId}`;
    const now = Date.now();
    await redis.zRemRangeByScore(rateLimitKey, 0, now - POST_RATE_WINDOW_MS);
    const recentCount = (await redis.zRange(rateLimitKey, 0, -1)).length;
    console.log(`[PostSubmit] rate check — userId=${userId} recentPostsIn5min=${recentCount}`);
    if (recentCount >= POST_RATE_MAX) {
      await removePost({
        context,
        redis,
        targetId: post.id ?? '',
        targetType: 'post',
        actor: 'SubGuardian:rateLimit',
        reason: `Rate limit: >${POST_RATE_MAX} posts in 5 minutes`,
      });
      await incrementPostAgg(redis, 'removed');
      await applyTrustPenalty(redis, userId, 30);
      console.log(`[PostSubmit] rate limited — postId=${post.id ?? ''}`);
      return;
    }
    await redis.zAdd(rateLimitKey, { score: now, member: post.id ?? String(now) });
    await redis.expire(rateLimitKey, 310);
  }

  // sosmoderators is a super-user — skip all automated moderation
  if (isMod) {
    console.log(`[PostSubmit] sosmoderators post — skipping all automated processing`);
    await incrementPostAgg(redis, 'total');
    await incrementHourlyPost(redis);
    return;
  }

  // Spam scoring (skipped when spamDetection is disabled)
  let spamFlagged = false;
  if (spamEnabled) {
  const postUrl = post.url ?? null;
  const domains = postUrl ? [postUrl] : extractUrls(post.selftext ?? '').map(u => extractDomain(u) ?? '');
  const domainBanned = await Promise.any(
    domains.map(d => isDomainBanned(redis, d).then(r => r ? Promise.resolve(true) : Promise.reject()))
  ).catch(() => false);

  const titleDup = await isTitleDuplicate(redis, post.title ?? '');
  const selftextDup = await isSelftextDuplicate(redis, post.selftext ?? '');

  const spamInput = {
    title: post.title ?? '',
    selftext: post.selftext ?? '',
    url: postUrl,
    isTitleDuplicate: titleDup,
    isSelftextDuplicate: selftextDup,
    isDomainBanned: domainBanned,
    userTrustScore: trustRecord.score,
    accountAgeDays: 0,
  };

  const spamScore = computeSpamScore(spamInput, config);
  await setSpamScore(redis, postId, spamScore);
  console.log(`[PostSubmit] spam score=${spamScore.score.toFixed(2)} signals=${spamScore.signals.join(',')}`);

  // Shadow-Audit: scan for shadow keywords independently of live banned keywords
  await checkShadowAudit(redis, postId, post.title ?? '', post.selftext ?? '', spamScore.score, config.shadowAudit.keywords);
  await checkShadowThreshold(redis, postId, post.title ?? '', spamScore.score, config);

  const spamAction = getSpamAction(spamScore.score, config, spamScore.signals);
  console.log(`[PostSubmit] action=${spamAction}`);
  const isFirstOffense = activity.removedPosts === 0 && activity.actionedReportsAgainst === 0;
  // Only offer recovery for signals the author can actually fix by editing the body.
  // Title signals (url_in_title, excessive_caps, etc.) cannot be changed after submission.
  const BODY_FIXABLE = new Set(['selftext_duplicate', 'domain_banned', 'banned_keyword', 'high_url_density']);
  const hasFixableSignal = spamScore.signals.some((s) => BODY_FIXABLE.has(s));

  if (spamAction === 'remove') {
    const reason = `Spam score ${spamScore.score.toFixed(2)}: ${spamScore.signals.join(', ')}`;
    await removePost({
      context,
      redis,
      targetId: postId,
      targetType: 'post',
      actor: isFirstOffense ? 'SubGuardian:recovery' : 'SubGuardian:spam',
      reason,
      score: spamScore.score,
    });
    await recordFlaggedPost(redis, postId, post.title ?? '', spamScore);
    await sendContextualPM(context, redis, postId, userId, author.name ?? '', post.title ?? '', spamScore, config, hasFixableSignal);
    if (isFirstOffense && hasFixableSignal) {
      await startRecoveryWindow(redis, postId, userId, author.name ?? '', spamScore.score);
      await incrementPostAgg(redis, 'flagged');
      await logAction(redis, {
        timestamp: Date.now(),
        action: 'recovery_started',
        targetId: postId,
        targetType: 'post',
        actor: 'SubGuardian',
        reason,
        score: spamScore.score,
      });
      return;
    }
    await incrementPostAgg(redis, 'removed');
    const updated = await updateActivity(redis, userId, { removedPosts: activity.removedPosts + 1 });
    await recomputeTrust(redis, userId, updated, await isInGrace(redis, userId));
    await applyTrustPenalty(redis, userId, 30);
    return;
  }

  if (spamAction === 'flag') {
    const flagReason = `Spam score ${spamScore.score.toFixed(2)}: ${spamScore.signals.join(', ')}`;
    await flairPost({
      context,
      redis,
      targetId: postId,
      targetType: 'post',
      actor: 'SubGuardian:spam',
      reason: flagReason,
      flairText: '⚠️ Needs Review',
    });
    const authorName = author.name ?? '';
    await sendContextualPM(context, redis, postId, userId, authorName, post.title ?? '', spamScore, config, hasFixableSignal);
    await postModCaseBrief(context, post.id ?? '', post.title ?? '', authorName, spamScore, trustRecord, activity, isFirstOffense && hasFixableSignal, config);
    // Record in flagged posts list for dashboard (capped at 50, 7-day TTL)
    const flaggedKey = 'dashboard:flagged_posts';
    const flaggedRaw = await redis.get(flaggedKey);
    const flaggedList: Array<{ id: string; title: string; spamScore: number; reportCount: number; score: number; signals: string[] }> =
      flaggedRaw ? (JSON.parse(flaggedRaw) as Array<{ id: string; title: string; spamScore: number; reportCount: number; score: number; signals: string[] }>) : [];
    flaggedList.unshift({ id: post.id ?? '', title: (post.title ?? '').slice(0, 80), spamScore: spamScore.score, reportCount: 0, score: 0, signals: spamScore.signals });
    if (flaggedList.length > 50) flaggedList.length = 50;
    await redis.set(flaggedKey, JSON.stringify(flaggedList), { expiration: new Date(Date.now() + 7 * 86_400 * 1000) });
    if (isFirstOffense && hasFixableSignal) {
      await startRecoveryWindow(redis, postId, userId, authorName, spamScore.score);
      await logAction(redis, {
        timestamp: Date.now(),
        action: 'recovery_started',
        targetId: postId,
        targetType: 'post',
        actor: 'SubGuardian',
        reason: flagReason,
        score: spamScore.score,
      });
    } else {
      await applyTrustPenalty(redis, userId, 30);
    }
    console.log(`[PostSubmit] flagged, held, and author notified — postId=${post.id ?? ''}`);
    await incrementPostAgg(redis, 'flagged');
    spamFlagged = true;
  }
  } // end spamEnabled

  if (!spamFlagged) {
    // Approved — add to caches
    await addTitleToCache(redis, post.title ?? '');
    if (post.selftext) await addSelftextToCache(redis, post.selftext);

    // Append title to rolling list for topic frequency aggregation (max 500)
    const recentRaw = await redis.get('agg:recent_titles');
    const recentTitles: string[] = recentRaw ? (JSON.parse(recentRaw) as string[]) : [];
    recentTitles.unshift(post.title ?? '');
    if (recentTitles.length > 500) recentTitles.length = 500;
    await redis.set('agg:recent_titles', JSON.stringify(recentTitles), {
      expiration: new Date(Date.now() + 30 * 86_400 * 1000),
    });
    await incrementPostAgg(redis, 'approved');

    // Store author for aggregateBuilder context-aware scoring
    await redis.set(Keys.postAuthorId(post.id ?? ''), userId, {
      expiration: new Date(Date.now() + 30 * 86_400 * 1000),
    });

    // Award 1 base contribution point to weekly leaderboard
    const wk = weekKey();
    await redis.zIncrBy(Keys.leaderboardContributionsWeekly(wk), userId, 1);

    // Flair pipeline: title tag → AI auto-apply → AI suggestion (comment + PM)
    // Merge config.flairList with actual Reddit flair templates so the mod only
    // needs to create templates in one place (mod tools → post flair).
    let effectiveFlairList = [...config.flairList];
    try {
      const redditTemplates = await context.reddit.getPostFlairTemplates(context.subredditName ?? '');
      const templateNames = redditTemplates.map((t) => t.text);
      for (const name of templateNames) {
        if (!effectiveFlairList.some((f) => f.toLowerCase() === name.toLowerCase())) {
          effectiveFlairList.push(name);
        }
      }
    } catch (e) {
      console.log(`[PostSubmit] getPostFlairTemplates failed: ${e}`);
    }
    if (config.features.flairAutoAssign && effectiveFlairList.length > 0) {
      const title = post.title ?? '';
      let appliedViaTag = false;

      // Step 1: title tag (opt-in via flairTitleTags feature toggle)
      if (config.features.flairTitleTags) {
        const tagMatch = /^\[([^\]]+)\]/.exec(title);
        if (tagMatch) {
          const tag = (tagMatch[1] ?? '').trim();
          const matched = effectiveFlairList.find(
            (f) => f.toLowerCase() === tag.toLowerCase()
          );
          if (matched) {
            await flairPost({
              context,
              redis,
              targetId: post.id ?? '',
              targetType: 'post',
              actor: 'SubGuardian:flair',
              reason: `Title tag [${tag}] matched flair`,
              flairText: matched,
            });
            appliedViaTag = true;
          }
        }
      }

      // Step 2: AI (only if title tag didn't match)
      if (!appliedViaTag) {
        const ai = getAIProvider(config);
        const { suggested, confidence } = await ai.suggestFlair(
          `${title} ${post.selftext ?? ''}`,
          effectiveFlairList
        );
        console.log(`[PostSubmit] AI flair — suggested="${suggested ?? 'none'}" confidence=${confidence.toFixed(2)} autoApplyThreshold=${FLAIR_CONFIDENCE.AUTO_APPLY} suggestThreshold=${FLAIR_CONFIDENCE.SUGGEST}`);

        if (confidence >= FLAIR_CONFIDENCE.AUTO_APPLY && suggested) {
          await flairPost({
            context,
            redis,
            targetId: post.id ?? '',
            targetType: 'post',
            actor: 'SubGuardian:flair',
            reason: `Auto-flair confidence ${confidence.toFixed(2)}`,
            flairText: suggested,
          });
        } else if (confidence >= FLAIR_CONFIDENCE.SUGGEST && suggested) {
          // Medium confidence → post comment + PM, store suggestion
          const authorName = author.name ?? '';
          const subName = context.subredditName ?? '';
          const suggestionText = [
            `Hi u/${authorName}! SubGuardian thinks your post might fit the **"${suggested}"** flair.`,
            ``,
            `Reply **"yes"** to this comment to apply it, or ignore this message if you'd prefer a different flair.`,
            ``,
            `*Automated suggestion from SubGuardian.*`,
          ].join('\n');

          let commentId: string | null = null;
          const rawPostId = post.id ?? '';
          const commentTargetId = rawPostId.startsWith('t3_') ? rawPostId : `t3_${rawPostId}`;
          console.log(`[PostSubmit] attempting comment — rawPostId="${rawPostId}" commentTargetId="${commentTargetId}" subreddit="${context.subredditName ?? ''}"`);
          try {
            const botComment = await context.reddit.submitComment({
              id: commentTargetId,
              text: suggestionText,
            });
            commentId = botComment.id;
            console.log(`[PostSubmit] flair suggestion comment posted — commentId=${commentId} flair="${suggested}"`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`[PostSubmit] flair suggestion comment failed — postId=${commentTargetId} error="${msg}"`);
          }

          if (authorName) {
            const pmCooldownKey = `pm:flair:${userId}`;
            const recentPm = await redis.get(pmCooldownKey);
            if (!recentPm) {
              try {
                await context.reddit.sendPrivateMessage({
                  to: authorName,
                  subject: `Flair suggestion for your post on r/${subName}`,
                  text: [
                    `Hi u/${authorName},`,
                    ``,
                    `SubGuardian suggests the **"${suggested}"** flair for your post **"${title}"**.`,
                    ``,
                    `To apply it, reply to the bot's comment on your post with **"yes"**.`,
                    ``,
                    `*Automated suggestion from SubGuardian.*`,
                  ].join('\n'),
                });
                await redis.set(pmCooldownKey, '1', { expiration: new Date(Date.now() + 30 * 60_000) });
              } catch (e) {
                const msg = String(e);
                if (msg.includes('NOT_WHITELISTED_BY_USER_MESSAGE')) {
                  console.log(`[PostSubmit] flair suggestion PM skipped — user has DMs disabled (${authorName})`);
                } else {
                  console.log(`[PostSubmit] flair suggestion PM failed — ${msg}`);
                }
              }
            } else {
              console.log(`[PostSubmit] flair suggestion PM skipped — cooldown active for userId=${userId}`);
            }
          }

          const suggestion: FlairSuggestion = {
            flair: suggested,
            commentId,
            suggestedAt: Date.now(),
            postAuthorId: userId,
          };
          await redis.set(
            Keys.flairSuggestion(post.id ?? ''),
            JSON.stringify(suggestion),
            { expiration: new Date(Date.now() + 7 * 86_400 * 1000) }
          );
          console.log(`[PostSubmit] flair suggested — postId=${post.id ?? ''} flair=${suggested}`);
        }
      }
    }

    // Update grace tier
    const updatedActivity = await updateActivity(redis, userId, {
      totalSubPosts: activity.totalSubPosts + 1,
      approvedSubPosts: activity.approvedSubPosts + 1,
    });
    if (inGrace && updatedActivity.approvedSubPosts >= TRUST.GRACE_POST_THRESHOLD) {
      await removeGrace(redis, userId);
    }
    await recomputeTrust(redis, userId, updatedActivity, await isInGrace(redis, userId));
  }

  await incrementPostAgg(redis, 'total');
  await incrementPostCountToday(redis, userId);
  await incrementHourlyPost(redis);
}

async function cachePostMeta(
  redis: import('@devvit/public-api').RedisClient,
  meta: PostMeta,
): Promise<void> {
  if (!meta.postId) return;
  await redis.set(Keys.postMeta(meta.postId), JSON.stringify(meta), {
    expiration: new Date(Date.now() + 30 * 86_400_000),
  });
}

async function recordFlaggedPost(
  redis: import('@devvit/public-api').RedisClient,
  postId: string,
  title: string,
  spamScore: SpamScore,
): Promise<void> {
  const flaggedKey = 'dashboard:flagged_posts';
  const flaggedRaw = await redis.get(flaggedKey);
  const flaggedList: Array<{ id: string; title: string; spamScore: number; reportCount: number; score: number; signals: string[]; recovery?: boolean }> =
    flaggedRaw ? (JSON.parse(flaggedRaw) as Array<{ id: string; title: string; spamScore: number; reportCount: number; score: number; signals: string[]; recovery?: boolean }>) : [];
  flaggedList.unshift({ id: postId, title: title.slice(0, 80), spamScore: spamScore.score, reportCount: 0, score: 0, signals: spamScore.signals });
  const deduped = flaggedList.filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
  if (deduped.length > 50) deduped.length = 50;
  await redis.set(flaggedKey, JSON.stringify(deduped), { expiration: new Date(Date.now() + 7 * 86_400_000) });
}

async function startRecoveryWindow(
  redis: import('@devvit/public-api').RedisClient,
  postId: string,
  userId: string,
  username: string,
  originalScore: number,
): Promise<void> {
  const record: RecoveryRecord = {
    userId,
    username,
    originalScore,
    expiresAt: Date.now() + 86_400_000,
  };
  await redis.set(Keys.postRecovery(postId), JSON.stringify(record), {
    expiration: new Date(Date.now() + 25 * 3_600_000),
  });
}

async function sendContextualPM(
  context: TriggerContext,
  redis: import('@devvit/public-api').RedisClient,
  postId: string,
  userId: string,
  authorName: string,
  title: string,
  spamScore: SpamScore,
  config: import('../redis/schema.js').SubConfig,
  includeRecheck = true,
): Promise<void> {
  if (!authorName) return;
  await Promise.all([
    redis.set(Keys.postRecheckUser(userId || authorName), postId, {
      expiration: new Date(Date.now() + 7 * 86_400_000),
    }),
    redis.set(Keys.postRecheckUser(authorName), postId, {
      expiration: new Date(Date.now() + 7 * 86_400_000),
    }),
  ]);
  try {
    await context.reddit.sendPrivateMessage({
      to: authorName,
      subject: `Your post on r/${context.subredditName ?? ''} has been held for review`,
      text: formatWhyRemovedPM(spamScore, config, authorName, title, context.subredditName ?? '', includeRecheck),
    });
  } catch {
    // DMs disabled - skip silently.
  }
}

async function antiRaidCheck(
  userId: string,
  author: { karma?: number; accountAgeDays?: number },
  config: import('../redis/schema.js').SubConfig,
  redis: import('@devvit/public-api').RedisClient
): Promise<{ blocked: boolean; reason: string | null }> {
  // Highly trusted users (≥700) always bypass raid gates
  const trustRecord = await getTrustScore(redis, userId);
  const trustScore = trustRecord?.score ?? 0;
  if (trustScore >= 700) {
    console.log(`[antiRaidCheck] userId=${userId} trustScore=${trustScore} — bypassing all gates (highly trusted)`);
    return { blocked: false, reason: null };
  }

  const gates = config.antiRaid.gates;

  if (gates.accountAgeDays.enabled) {
    const ageDays = author.accountAgeDays ?? 0;
    if (ageDays < gates.accountAgeDays.minimum) {
      return { blocked: true, reason: `Account too new: ${ageDays}d (min ${gates.accountAgeDays.minimum}d)` };
    }
  }

  if (gates.minKarma.enabled) {
    const karma = author.karma ?? 0;
    if (karma < gates.minKarma.minimum) {
      return { blocked: true, reason: `Karma too low: ${karma} (min ${gates.minKarma.minimum})` };
    }
  }

  if (gates.minTrustScore.enabled && trustScore < gates.minTrustScore.minimum) {
    return { blocked: true, reason: `Trust score too low: ${trustScore} (min ${gates.minTrustScore.minimum})` };
  }

  if (gates.postsPerDay.enabled) {
    const todayCount = await getPostCountToday(redis, userId);
    if (todayCount >= gates.postsPerDay.limit) {
      return { blocked: true, reason: `Post limit: ${todayCount}/${gates.postsPerDay.limit} today` };
    }
  }

  return { blocked: false, reason: null };
}

async function applyTrustPenalty(
  redis: import('@devvit/public-api').RedisClient,
  userId: string,
  points: number
): Promise<void> {
  const raw = await redis.get(Keys.userTrust(userId));
  if (!raw) return;
  const trust = JSON.parse(raw) as { score: number; tier: string; [k: string]: unknown };
  const newScore = Math.max(TRUST.MIN, trust.score - points);
  const tier =
    newScore <= TRUST.TIER_UNTRUSTED_MAX ? 'untrusted' :
    newScore <= TRUST.TIER_LOW_MAX ? 'low' :
    newScore <= TRUST.TIER_NEUTRAL_MAX ? 'neutral' :
    newScore <= TRUST.TIER_TRUSTED_MAX ? 'trusted' : 'highly_trusted';
  await redis.set(Keys.userTrust(userId), JSON.stringify({ ...trust, score: newScore, tier, lastUpdated: Date.now() }));
  await redis.zAdd(Keys.leaderboardTrust, { score: newScore, member: userId });
  console.log(`[applyTrustPenalty] userId=${userId} -${points} => ${newScore} (${tier})`);
}

async function postModCaseBrief(
  context: TriggerContext,
  postId: string,
  title: string,
  authorName: string,
  spamScore: SpamScore,
  trustRecord: import('../redis/schema.js').TrustScore | null,
  activity: ActivityCounters,
  isFirstOffense: boolean,
  config: import('../redis/schema.js').SubConfig,
): Promise<void> {
  const verdict = isFirstOffense && spamScore.score < 0.70
    ? 'APPROVE — first offense, score below strong-remove threshold'
    : spamScore.score >= config.spamDetection.autoRemoveThreshold
      ? 'REMOVE — score above auto-remove threshold'
      : activity.removedPosts >= 2
        ? 'REMOVE — repeat prior removals'
        : 'APPROVE — borderline score, no strong repeat-offender signal';

  const signalLines = spamScore.signals
    .map((s) => `- **${signalLabel(s)}** — ${signalFix(s)}`)
    .join('\n');

  const subName = context.subredditName ?? '';
  const postUrl = `https://reddit.com/r/${subName}/comments/${postId.replace('t3_', '')}`;

  const mailBody = [
    `**Case Brief — flagged post in r/${subName}**`,
    ``,
    `**Post:** [${title.slice(0, 80)}](${postUrl})`,
    `**Author:** u/${authorName} | Trust: ${trustRecord?.score ?? 300} (${trustRecord?.tier ?? 'neutral'})`,
    ``,
    `**Why flagged** (score: ${spamScore.score.toFixed(2)} | flag threshold: ${config.spamDetection.autoFlagThreshold.toFixed(2)}):`,
    signalLines || '- No specific signals recorded',
    ``,
    `**Author history in r/${subName}:**`,
    `- ${activity.approvedSubPosts} approved posts`,
    `- ${activity.removedPosts} prior removals`,
    `- ${activity.actionedReportsAgainst} actioned reports against them`,
    isFirstOffense ? `\n**First offense** — Recovery PM sent. Author has 24 h to edit and reply !recheck.` : '',
    ``,
    `**SubGuardian suggests: ${verdict}**`,
  ].filter((l) => l !== undefined).join('\n');

  const commentTargetId = postId.startsWith('t3_') ? postId : `t3_${postId}`;
  let mailUrl = 'https://mod.reddit.com/mail/all';

  try {
    const result = await context.reddit.modMail.createConversation({
      subredditName: subName,
      subject: `[SubGuardian] Flagged post: "${title.slice(0, 60)}"`,
      body: mailBody,
      isAuthorHidden: false,
    });
    const convId: string = (result as { conversation?: { id?: string } }).conversation?.id ?? '';
    if (convId) mailUrl = `https://mod.reddit.com/mail/all/${convId}`;
    console.log(`[PostSubmit] mod case brief modmail sent — convId=${convId}`);
  } catch (e) {
    console.log(`[PostSubmit] mod case brief modmail failed — ${String(e)}`);
  }

  const commentText = `**[SubGuardian]** This post has been flagged for mod review. [View case brief in Modmail](${mailUrl})`;

  try {
    const comment = await context.reddit.submitComment({ id: commentTargetId, text: commentText });
    await comment.distinguish(true);
  } catch (e) {
    console.log(`[PostSubmit] mod case brief comment failed — ${String(e)}`);
  }
}

async function checkShadowAudit(
  redis: import('@devvit/public-api').RedisClient,
  postId: string,
  title: string,
  selftext: string,
  spamScore: number,
  shadowKeywords: string[],
): Promise<void> {
  if (shadowKeywords.length === 0) return;
  const content = (title + ' ' + selftext).toLowerCase();
  const now = Date.now();
  for (const kw of shadowKeywords) {
    if (!content.includes(kw.toLowerCase())) continue;
    const entry: ShadowAuditEntry = {
      postId,
      title: title.slice(0, 120),
      score: spamScore,
      matchedKeyword: kw,
      timestamp: now,
    };
    const listKey = Keys.shadowAuditList(kw);
    // Store as sorted set: score=timestamp, member=JSON (unique suffix avoids duplicate member error)
    await redis.zAdd(listKey, { score: now, member: JSON.stringify({ ...entry, _u: postId }) });
    // Trim to 200 entries: remove entries older than 25h (shadow window + buffer)
    await redis.zRemRangeByScore(listKey, 0, now - 25 * 3_600_000);
    console.log(`[ShadowAudit] keyword="${kw}" matched postId=${postId} score=${spamScore.toFixed(2)}`);
  }
}

async function checkShadowThreshold(
  redis: import('@devvit/public-api').RedisClient,
  postId: string,
  title: string,
  spamScore: number,
  config: import('../redis/schema.js').SubConfig,
): Promise<void> {
  if (!config.shadowAudit.thresholdTestActive) return;
  const candidate = config.shadowAudit.thresholdTestValue;
  if (spamScore < candidate || spamScore >= config.spamDetection.autoFlagThreshold) return;
  const entry: ShadowAuditEntry = {
    postId,
    title: title.slice(0, 120),
    score: spamScore,
    matchedKeyword: `threshold:${candidate.toFixed(2)}`,
    timestamp: Date.now(),
  };
  const listKey = Keys.shadowAuditList(`threshold:${candidate.toFixed(2)}`);
  await redis.zAdd(listKey, { score: entry.timestamp, member: JSON.stringify({ ...entry, _u: postId }) });
  await redis.zRemRangeByScore(listKey, 0, Date.now() - 25 * 3_600_000);
}

async function recomputeTrust(
  redis: import('@devvit/public-api').RedisClient,
  userId: string,
  activity: ActivityCounters,
  inGrace: boolean
): Promise<void> {
  const existingRaw = await redis.get(Keys.userTrust(userId));
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as Record<string, unknown>;
    if (existing['devOverride']) {
      console.log(`[recomputeTrust] skipping — devOverride set for userId=${userId}`);
      return;
    }
  }
  const input = {
    accountAgeDays: 0,
    subKarma: 0,
    totalSubPosts: activity.totalSubPosts,
    approvedSubPosts: activity.approvedSubPosts,
    removedPosts: activity.removedPosts,
    actionedReportsAgainst: activity.actionedReportsAgainst,
    tempBanCount: activity.tempBanCount,
    permBanHistory: activity.permBanHistory,
    awardsReceived: activity.awardsReceived,
    topPostCount: activity.topPostCount,
    helpfulReportCount: activity.helpfulReportCount,
    proposedFlairsAdopted: activity.proposedFlairsAdopted,
  };
  const newTrust = buildTrustScore(input, inGrace);
  console.log(`[recomputeTrust] input=${JSON.stringify(input)} inGrace=${inGrace} => score=${newTrust.score} tier=${newTrust.tier}`);
  await setTrustScore(redis, userId, newTrust);
}
