import { Devvit } from '@devvit/public-api';
import type { TriggerEventType, TriggerContext } from '@devvit/public-api';
import { triggerGuard, isFeatureEnabled } from '../moderation/killSwitch.js';
import { getConfig, setConfig } from '../redis/config.js';
import { getTrustScore, isAppealOnCooldown, appendAppeal } from '../redis/users.js';
import { getAIProvider } from '../ai/interface.js';
import { logAction } from '../moderation/auditLog.js';
import type { AIAnalysisResult } from '../ai/interface.js';
import { Keys } from '../redis/schema.js';

const KEYWORD_CMD = /^!keyword\s+(add|remove|list)\s*(.*)/i;
const VOTE_CONFIG_CMD = /^!vote\s+config\b/i;
const DEFAULT_KEYWORDS = ['crypto', 'OnlyFans', 'free money', 'click here'];

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
    if (await handleVoteConfig(context, conversationId, messageBody, senderName)) return;
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
    const history = {
      trustScore,
      removedPosts: 0,
      tempBanCount: 0,
      permBanHistory: 0,
      appealCount: 0,
      lastAppealTs: null,
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
