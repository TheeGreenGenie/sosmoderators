import { Devvit } from '@devvit/public-api';
import type { TriggerEventType, TriggerContext } from '@devvit/public-api';
import { triggerGuard, isFeatureEnabled } from '../moderation/killSwitch.js';
import { getConfig, setConfig, setPreset } from '../redis/config.js';
import { getTrustScore, getActivity, getAppealLog, isAppealOnCooldown, appendAppeal } from '../redis/users.js';
import { getAIProvider } from '../ai/interface.js';
import { logAction } from '../moderation/auditLog.js';
import type { AIAnalysisResult } from '../ai/interface.js';
import { Keys } from '../redis/schema.js';
import type { PostMeta, RecoveryRecord, SpamScore } from '../redis/schema.js';
import { computeSpamScore } from '../scoring/spamScore.js';
import { isTitleDuplicate, isSelftextDuplicate, isDomainBanned, setSpamScore } from '../redis/posts.js';
import { extractDomain, extractUrls } from '../utils/regex.js';
import { formatWhyRemovedPM } from '../utils/pmTemplates.js';

const KEYWORD_CMD = /^!keyword\s+(add|remove|list)\s*(.*)/i;
const VOTE_CONFIG_CMD = /^!vote\s+config\b/i;
const SHADOW_ACTIVATE_CMD = /^!shadow-activate\s+(.+)/i;
const RECHECK_CMD = /\b!recheck\b/i;
const RAID_CMD = /\b!raid\b/i;
const DEFAULT_KEYWORDS = ['crypto', 'OnlyFans', 'free money', 'click here'];

async function isModerator(context: TriggerContext, senderName: string): Promise<boolean> {
  if (!senderName) return false;
  const subredditName = context.subredditName ?? '';
  const modListing = context.reddit.getModerators({ subredditName });
  const allMods = await modListing.all();
  return allMods.some((m) => m?.username?.toLowerCase() === senderName.toLowerCase());
}

async function handleKeywordCommand(
  context: TriggerContext,
  messageBody: string,
  senderName: string
): Promise<boolean> {
  const match = messageBody.trim().match(KEYWORD_CMD);
  if (!match) return false;

  console.log(`[ModMail:keyword] sender=${senderName} cmd="${messageBody.trim().slice(0, 80)}"`);

  const subredditName = context.subredditName ?? '';
  const modListing = context.reddit.getModerators({ subredditName });
  const allMods = await modListing.all();
  const isMod = allMods.some((m) => m?.username?.toLowerCase() === senderName.toLowerCase());
  console.log(`[ModMail:keyword] isMod=${isMod} for sender=${senderName}`);

  if (!isMod) {
    await context.reddit.sendPrivateMessage({
      to: senderName,
      subject: 'SubGuardian — Keyword Management',
      text: 'Only moderators can manage banned keywords.',
    });
    return true;
  }

  const action = (match[1] ?? '').toLowerCase() as 'add' | 'remove' | 'list';
  const keyword = (match[2] ?? '').trim().toLowerCase();
  const config = await getConfig(context.redis);
  const current = config.spamDetection.bannedKeywords;

  if (action === 'list') {
    const custom = current.filter((k) => !DEFAULT_KEYWORDS.map((d) => d.toLowerCase()).includes(k.toLowerCase()));
    const reply = custom.length === 0
      ? `Default keywords: ${DEFAULT_KEYWORDS.join(', ')}\nNo custom keywords configured.`
      : `Default keywords: ${DEFAULT_KEYWORDS.join(', ')}\nCustom keywords: ${custom.join(', ')}`;
    await context.reddit.sendPrivateMessage({ to: senderName, subject: 'SubGuardian — Keyword List', text: reply });
    return true;
  }

  if (!keyword) {
    await context.reddit.sendPrivateMessage({
      to: senderName,
      subject: 'SubGuardian — Keyword Management',
      text: `Usage:\n  !keyword add <word>\n  !keyword remove <word>\n  !keyword list`,
    });
    return true;
  }

  if (action === 'add') {
    if (!current.some((k) => k.toLowerCase() === keyword)) {
      await setConfig(context.redis, {
        ...config,
        spamDetection: { ...config.spamDetection, bannedKeywords: [...current, keyword] },
      });
      console.log(`[ModMail:keyword] added "${keyword}" — total=${current.length + 1}`);
    }
    await context.reddit.sendPrivateMessage({
      to: senderName,
      subject: 'SubGuardian — Keyword Added',
      text: `"${keyword}" has been added to the banned keyword list.`,
    });
  } else {
    const next = current.filter((k) => k.toLowerCase() !== keyword);
    await setConfig(context.redis, {
      ...config,
      spamDetection: { ...config.spamDetection, bannedKeywords: next },
    });
    console.log(`[ModMail:keyword] removed "${keyword}" — total=${next.length}`);
    await context.reddit.sendPrivateMessage({
      to: senderName,
      subject: 'SubGuardian — Keyword Removed',
      text: `"${keyword}" has been removed from the banned keyword list.`,
    });
  }

  return true;
}

async function handleVoteConfig(
  context: TriggerContext,
  conversationId: string,
  messageBody: string,
  senderName: string
): Promise<boolean> {
  if (!VOTE_CONFIG_CMD.test(messageBody.trim())) return false;

  const subredditName = context.subredditName ?? '';
  const modListing = context.reddit.getModerators({ subredditName });
  const allMods = await modListing.all();
  const isMod = allMods.some((m) => m?.username?.toLowerCase() === senderName.toLowerCase());
  if (!isMod) return false;

  // Find the proposal linked to this conversation
  // Strip the "ModmailConversation_" prefix for comparison — the stored ID may be the short form
  const bareConvId = conversationId.replace(/^ModmailConversation_/i, '');
  const listRaw = await context.redis.get(Keys.flairProposalList);
  const proposalIds: string[] = listRaw ? (JSON.parse(listRaw) as string[]) : [];
  let proposalRaw: string | null = null;
  let proposalId = '';
  for (const id of proposalIds) {
    const raw = await context.redis.get(Keys.flairProposal(id));
    if (!raw) continue;
    const p = JSON.parse(raw) as import('../redis/schema.js').FlairProposal;
    const storedBare = (p.configConversationId ?? '').replace(/^ModmailConversation_/i, '');
    console.log(`[ModMail:voteConfig] checking proposal ${id}: storedConvId=${p.configConversationId} bare=${storedBare} vs ${bareConvId}`);
    if (storedBare === bareConvId) {
      proposalRaw = raw;
      proposalId = id;
      break;
    }
  }
  if (!proposalRaw || !proposalId) {
    console.log(`[ModMail:voteConfig] no proposal found for conversationId=${conversationId} (bare=${bareConvId})`);
    return true;
  }

  const proposal = JSON.parse(proposalRaw) as import('../redis/schema.js').FlairProposal;

  // Parse key:value pairs from the message
  const hoursMatch = /\bhours:(\d+)/i.exec(messageBody);
  const thresholdMatch = /\bthreshold:(0?\.\d+)/i.exec(messageBody);
  const minVotesMatch = /\bminVotes:(\d+)/i.exec(messageBody);

  const changes: string[] = [];
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1] ?? '48');
    proposal.endsAt = proposal.createdAt + hours * 3_600_000;
    changes.push(`duration → ${hours}h`);
  }
  if (thresholdMatch) {
    proposal.approvalPct = parseFloat(thresholdMatch[1] ?? '0.6');
    changes.push(`approval → ${Math.round(proposal.approvalPct * 100)}%`);
  }
  if (minVotesMatch) {
    proposal.minVotes = parseInt(minVotesMatch[1] ?? '0');
    changes.push(`minVotes → ${proposal.minVotes}`);
  }

  const cfg = await getConfig(context.redis);
  const subName = context.subredditName ?? '';
  const hours = Math.round((proposal.endsAt - proposal.createdAt) / 3_600_000);
  const thresholdPct = Math.round((proposal.approvalPct ?? cfg.flairVoting.approvalRatio) * 100);
  const quorum = proposal.minVotes ?? cfg.flairVoting.minVotes ?? 0;

  // Create the Devvit custom vote post first so we have its URL
  const votePost = await context.reddit.submitPost({
    subredditName: subName,
    title: `Community Vote: Should we add the "${proposal.flair}" flair?`,
    preview: Devvit.createElement('vstack', { alignment: 'center middle', height: '100%', width: '100%' },
      Devvit.createElement('text', {}, `Community vote: "${proposal.flair}"`)
    ),
    postData: { view: 'vote', proposalId },
  });
  proposal.postId = votePost.id;

  // Persist updated proposal (config changes + postId)
  await context.redis.set(Keys.flairProposal(proposalId), JSON.stringify(proposal));
  console.log(`[ModMail:voteConfig] updated proposal ${proposalId}: ${changes.join(', ') || 'defaults kept'}, postId=${proposal.postId}`);

  const voteUrl = votePost.url;

  // Announce publicly now that config is confirmed
  await context.reddit.submitPost({
    subredditName: subName,
    title: `📣 Community vote open: should we add the "${proposal.flair}" flair?`,
    text: [
      `The community has been talking a lot about **${proposal.flair}** lately and we're putting it to a vote!`,
      ``,
      `👉 **[Cast your vote here](${voteUrl})**`,
      ``,
      `Voting is open for **${hours} hours**. You need a minimum trust score of ${cfg.flairVoting.minTrustToVote} to vote.`,
      quorum > 0 ? `Minimum votes required: **${quorum}**.` : '',
      `Approval threshold: **${thresholdPct}%**.`,
      ``,
      `*Posted automatically by SubGuardian.*`,
    ].filter(Boolean).join('\n'),
  });

  // PM eligible members (top 50 by trust above minTrustToVote, skip DMs-disabled)
  const eligible = (await context.redis.zRange(Keys.leaderboardTrust, 0, 49, { by: 'rank', reverse: true }))
    .filter((m) => m.member.startsWith('t2_') && m.score >= cfg.flairVoting.minTrustToVote);
  let pmsSent = 0;
  for (const member of eligible) {
    const recipientName = await context.redis.get(Keys.userUsername(member.member));
    if (!recipientName || recipientName === 'sosmoderators') continue;
    try {
      await context.reddit.sendPrivateMessage({
        to: recipientName,
        subject: `Vote: should r/${subName} add the "${proposal.flair}" flair?`,
        text: [
          `Hi u/${recipientName},`,
          ``,
          `r/${subName} has opened a community vote on adding the **"${proposal.flair}"** flair.`,
          ``,
          `👉 [Cast your vote here](${voteUrl})`,
          ``,
          `Voting closes in ${hours} hours.`,
          ``,
          `*Automated message from SubGuardian. Reply STOP to opt out of future vote notifications.*`,
        ].join('\n'),
      });
      pmsSent++;
    } catch {
      // DMs disabled — skip silently
    }
  }

  await context.reddit.modMail.reply({
    conversationId,
    body: [
      changes.length > 0 ? `✅ Vote settings applied:\n${changes.map((c) => `- ${c}`).join('\n')}` : `✅ Using defaults.`,
      ``,
      `📣 Announcement post published and ${pmsSent} member${pmsSent !== 1 ? 's' : ''} notified.`,
    ].join('\n'),
  });

  return true;
}

async function handleShadowActivate(
  context: TriggerContext,
  messageBody: string,
  senderName: string,
): Promise<boolean> {
  const match = messageBody.trim().match(SHADOW_ACTIVATE_CMD);
  if (!match) return false;

  const subredditName = context.subredditName ?? '';
  const allMods = await context.reddit.getModerators({ subredditName }).all();
  const isMod = allMods.some((m) => m?.username?.toLowerCase() === senderName.toLowerCase());
  if (!isMod) return false;

  const keyword = (match[1] ?? '').trim().toLowerCase();
  if (!keyword) return false;

  const config = await getConfig(context.redis);
  const shadowKeywords = config.shadowAudit?.keywords ?? [];

  if (!shadowKeywords.some((k) => k.toLowerCase() === keyword)) {
    await context.reddit.sendPrivateMessage({
      to: senderName,
      subject: 'SubGuardian — Shadow Activate',
      text: `"${keyword}" is not in shadow-audit mode. Current shadow keywords: ${shadowKeywords.join(', ') || '(none)'}.`,
    });
    return true;
  }

  // Read shadow audit stats before clearing
  const listKey = Keys.shadowAuditList(keyword);
  const count = await context.redis.zCard(listKey);

  // Move keyword from shadow to live banned keywords
  const nextShadow = shadowKeywords.filter((k) => k.toLowerCase() !== keyword);
  const nextBanned = [...config.spamDetection.bannedKeywords];
  if (!nextBanned.some((k) => k.toLowerCase() === keyword)) {
    nextBanned.push(keyword);
  }

  await setConfig(context.redis, {
    ...config,
    shadowAudit: {
      ...config.shadowAudit,
      keywords: nextShadow,
      startedAt: nextShadow.length === 0 ? null : config.shadowAudit.startedAt,
    },
    spamDetection: { ...config.spamDetection, bannedKeywords: nextBanned },
  });

  // Delete the shadow audit list
  await context.redis.del(listKey);

  console.log(`[ShadowActivate] "${keyword}" promoted to live — caught ${count} posts in shadow mode`);

  await context.reddit.sendPrivateMessage({
    to: senderName,
    subject: 'SubGuardian — Shadow Keyword Activated',
    text: [
      `✅ "${keyword}" has been promoted from Shadow-Audit to your active spam keyword list.`,
      ``,
      `It caught **${count}** post${count !== 1 ? 's' : ''} during the shadow-audit period.`,
      ``,
      `From now on, posts containing "${keyword}" will trigger your normal spam detection rules.`,
    ].join('\n'),
  });

  return true;
}

async function computeCurrentSpamScore(
  context: TriggerContext,
  postId: string,
): Promise<{ spamScore: SpamScore; title: string; authorName: string }> {
  const redis = context.redis;
  const config = await getConfig(redis);
  const post = await context.reddit.getPostById(postId);
  const postLike = post as unknown as { title?: string; selftext?: string; url?: string | null; authorName?: string };
  const title = postLike.title ?? '';
  const selftext = postLike.selftext ?? '';
  const postUrl = postLike.url ?? null;
  const domains = postUrl ? [postUrl] : extractUrls(selftext).map((u) => extractDomain(u) ?? '');
  const domainBanned = await Promise.any(
    domains.map((d) => isDomainBanned(redis, d).then((result) => result ? Promise.resolve(true) : Promise.reject()))
  ).catch(() => false);

  const metaRaw = await redis.get(Keys.postMeta(postId));
  const meta = metaRaw ? (JSON.parse(metaRaw) as PostMeta) : null;
  const trust = meta?.authorId ? await getTrustScore(redis, meta.authorId) : null;

  const spamScore = computeSpamScore({
    title,
    selftext,
    url: postUrl,
    isTitleDuplicate: await isTitleDuplicate(redis, title),
    isSelftextDuplicate: await isSelftextDuplicate(redis, selftext),
    isDomainBanned: domainBanned,
    userTrustScore: trust?.score ?? 300,
    accountAgeDays: 0,
  }, config);
  await setSpamScore(redis, postId, spamScore);
  return { spamScore, title, authorName: postLike.authorName ?? meta?.authorName ?? '' };
}

async function handleRecheck(
  context: TriggerContext,
  conversationId: string,
  messageBody: string,
  senderId: string,
  senderName: string,
): Promise<boolean> {
  if (!RECHECK_CMD.test(messageBody)) return false;

  const cooldownKey = `recheck:cooldown:${senderId || senderName}`;
  const reserved = await context.redis.set(cooldownKey, '1', {
    nx: true,
    expiration: new Date(Date.now() + 10 * 60_000),
  });
  if (!reserved) {
    await context.reddit.modMail.reply({
      conversationId,
      body: 'Please wait 10 minutes before requesting another recheck.',
    });
    return true;
  }

  const postId =
    (await context.redis.get(Keys.postRecheck(conversationId))) ??
    (await context.redis.get(Keys.postRecheckUser(senderId))) ??
    (await context.redis.get(Keys.postRecheckUser(senderName)));

  if (!postId) {
    await context.reddit.modMail.reply({
      conversationId,
      body: 'I could not find a held post linked to this conversation. Please contact the mods directly.',
    });
    return true;
  }

  const recoveryRaw = await context.redis.get(Keys.postRecovery(postId));
  if (recoveryRaw) {
    const recovery = JSON.parse(recoveryRaw) as RecoveryRecord;
    if (Date.now() > recovery.expiresAt) {
      await context.reddit.modMail.reply({
        conversationId,
        body: 'The 24-hour review window has closed. Contact the mods directly.',
      });
      await logAction(context.redis, {
        timestamp: Date.now(),
        action: 'recovery_failed',
        targetId: postId,
        targetType: 'post',
        actor: senderName || senderId,
        reason: 'Recovery window expired',
      });
      return true;
    }
  }

  const config = await getConfig(context.redis);
  const { spamScore, title, authorName } = await computeCurrentSpamScore(context, postId);
  if (spamScore.score < config.spamDetection.autoFlagThreshold && !spamScore.signals.includes('selftext_duplicate')) {
    await context.reddit.approve(postId);
    await context.redis.del(Keys.postRecovery(postId));
    try {
      await context.reddit.setPostFlair({
        postId,
        subredditName: context.subredditName ?? '',
        text: '',
      });
    } catch { /* flair removal failed — non-fatal */ }
    await context.reddit.modMail.reply({
      conversationId,
      body: "Your post passed recheck - it's now live.",
    });
    await logAction(context.redis, {
      timestamp: Date.now(),
      action: 'recovery_approved',
      targetId: postId,
      targetType: 'post',
      actor: 'SubGuardian',
      reason: `Recheck score ${spamScore.score.toFixed(2)}`,
      score: spamScore.score,
    });
    return true;
  }

  await context.reddit.modMail.reply({
    conversationId,
    body: formatWhyRemovedPM(spamScore, config, authorName || senderName, title, context.subredditName ?? ''),
  });
  await logAction(context.redis, {
    timestamp: Date.now(),
    action: 'recovery_failed',
    targetId: postId,
    targetType: 'post',
    actor: 'SubGuardian',
    reason: `Recheck score ${spamScore.score.toFixed(2)}: ${spamScore.signals.join(', ')}`,
    score: spamScore.score,
  });
  return true;
}

async function handleRaidCommand(
  context: TriggerContext,
  conversationId: string,
  messageBody: string,
  senderName: string,
): Promise<boolean> {
  if (!RAID_CMD.test(messageBody.trim())) return false;
  if (!(await isModerator(context, senderName))) return false;

  const config = await getConfig(context.redis);
  await context.redis.set(Keys.raidMode, '1');
  await context.redis.set('sub:raid_mode:activated_at', String(Date.now()));
  await setPreset(context.redis, 'raid');
  await context.reddit.modMail.reply({
    conversationId,
    body: `Raid preset activated. Raid mode will auto-expire in ${config.antiRaid.raidDurationHours}h or you can deactivate it from the Config UI.`,
  });
  await context.reddit.modMail.createConversation({
    subredditName: context.subredditName ?? '',
    subject: 'SubGuardian Raid Preset Activated',
    body: `Raid preset activated by u/${senderName}.`,
    isAuthorHidden: false,
  });
  await logAction(context.redis, {
    timestamp: Date.now(),
    action: 'raid_preset_activated',
    targetId: 'raid',
    targetType: 'config',
    actor: senderName,
    reason: 'Activated via !raid modmail command',
  });
  return true;
}

function formatAppealReply(
  result: AIAnalysisResult,
  appealText: string,
  priorAppeals: number,
): string {
  const summaryLines = result.summary
    .split(/[.!?]\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
  const recommendation =
    result.suggestedAction === 'approve' ? 'APPROVE' :
    result.suggestedAction === 'remove' ? 'DENY' :
    'REVIEW MANUALLY';
  return [
    '--- SubGuardian Appeal Analysis ---',
    `Appeal history: ${priorAppeals === 0 ? 'First appeal on record' : `${priorAppeals + 1}th appeal on record`}`,
    '',
    'Summary:',
    ...(summaryLines.length > 0 ? summaryLines.map((line) => `  - ${line}`) : ['  - No concise summary available.']),
    '',
    `Recommendation: ${recommendation} (confidence: ${Math.round(result.confidence * 100)}%)`,
    `Reason: ${result.reasoning}`,
    '',
    '--- Original Appeal ---',
    appealText,
  ].join('\n');
}

export async function onModMail(event: TriggerEventType['ModMail'], context: TriggerContext): Promise<void> {
  const redis = context.redis;
  const conversationId = event.conversationId ?? `modmail:${Date.now()}`;
  console.log(`[ModMail] fired — conversationId=${conversationId}`);

  // Keyword and vote config commands bypass kill switch and dedup
  const senderName = event.messageAuthor?.name ?? '';
  if (senderName) {
    const conv = await context.reddit.modMail.getConversation({ conversationId: event.conversationId });
    const allMessages = conv.conversation?.messages ?? {};
    const byId = allMessages[event.messageId];
    // Fall back to the most-recently-authored message if ID lookup misses
    const messageBody = byId?.bodyMarkdown
      ?? Object.values(allMessages).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0]?.bodyMarkdown
      ?? '';
    console.log(`[ModMail] messageId=${event.messageId} bodyPreview="${messageBody.slice(0, 80)}"`);
    if (await handleRecheck(context, conversationId, messageBody, event.messageAuthor?.id ?? '', senderName)) return;
    if (await handleRaidCommand(context, conversationId, messageBody, senderName)) return;
    if (await handleVoteConfig(context, conversationId, messageBody, senderName)) return;
    if (await handleShadowActivate(context, messageBody, senderName)) return;
    if (await handleKeywordCommand(context, messageBody, senderName)) return;
  }

  const guard = await triggerGuard(redis, `modmail:${conversationId}`);
  if (!guard.proceed) {
    console.log(`[ModMail] aborted — reason=${guard.reason}`);
    return;
  }
  if (!(await isFeatureEnabled(redis, 'modmailRouting'))) {
    console.log(`[ModMail] modmailRouting feature disabled`);
    return;
  }

  const config = await getConfig(redis);
  const senderId = event.messageAuthor?.id ?? 'unknown';
  // Body is not in the trigger payload; fetch via Reddit API
  const conv = await context.reddit.modMail.getConversation({ conversationId: event.conversationId });
  const allMsgs = conv.conversation?.messages ?? {};
  const messageBody = allMsgs[event.messageId]?.bodyMarkdown
    ?? Object.values(allMsgs).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0]?.bodyMarkdown
    ?? '';

  const trustRecord = await getTrustScore(redis, senderId);
  const trustScore = trustRecord?.score ?? 300;

  const isAppeal = /\b(appeal|ban|remove|removed|unfair|unjust|mistake)\b/i.test(messageBody);
  console.log(`[ModMail] senderId=${senderId} isAppeal=${isAppeal} trustScore=${trustScore}`);

  if (isAppeal && config.features.trustScoring) {
    const onCooldown = await isAppealOnCooldown(redis, senderId, config.appeals.cooldownDays);

    const ai = getAIProvider(config);
    const activity = await getActivity(redis, senderId);
    const appealLog = await getAppealLog(redis, senderId);
    const history = {
      trustScore,
      removedPosts: activity.removedPosts,
      tempBanCount: activity.tempBanCount,
      permBanHistory: activity.permBanHistory,
      appealCount: appealLog.length,
      lastAppealTs: appealLog[0]?.timestamp ?? null,
    };

    // Check cache first (7-day TTL)
    const cacheKey = Keys.aiCacheAppeal(`${senderId}:${messageBody.slice(0, 100)}`);
    const cached = await redis.get(cacheKey);
    let result: AIAnalysisResult;
    if (cached) {
      result = JSON.parse(cached) as AIAnalysisResult;
    } else {
      result = await ai.analyzeAppeal(messageBody, history);
      await redis.set(cacheKey, JSON.stringify(result), {
        expiration: new Date(Date.now() + 7 * 86_400 * 1000),
      });
    }

    await appendAppeal(redis, senderId, {
      timestamp: Date.now(),
      summary: result.summary,
      outcome: 'pending',
    });

    await logAction(redis, {
      timestamp: Date.now(),
      action: 'modmail_appeal_classified',
      targetId: conversationId,
      targetType: 'user',
      actor: 'SubGuardian',
      reason: result.reasoning,
      score: result.confidence,
    });

    if (onCooldown) {
      await logAction(redis, {
        timestamp: Date.now(),
        action: 'modmail_appeal_cooldown_hit',
        targetId: senderId,
        targetType: 'user',
        actor: 'SubGuardian',
        reason: `Appeal within cooldown period (${config.appeals.cooldownDays} days)`,
      });
    }

    await context.reddit.modMail.reply({
      conversationId,
      body: formatAppealReply(result, messageBody, appealLog.length),
    });

    return;
  }

  // Route non-appeal modmail based on trust score + content quality
  const isLowQuality = trustScore < 150 || messageBody.trim().length < 20;

  await logAction(redis, {
    timestamp: Date.now(),
    action: isLowQuality ? 'modmail_low_priority' : 'modmail_standard',
    targetId: conversationId,
    targetType: 'user',
    actor: 'SubGuardian',
    reason: `Sender trust: ${trustScore}`,
  });
}
