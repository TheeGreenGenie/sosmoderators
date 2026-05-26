import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import type { FlairProposal } from '../redis/schema.js';
import { Keys, weekKey } from '../redis/schema.js';
import { getConfig } from '../redis/config.js';
import { getTrustScore } from '../redis/users.js';

interface VoteState {
  proposalJson: string;
  upVotes: number;
  downVotes: number;
  approvalPct: number;
  hoursLeft: number;
  existingVote: string | null;
  canVote: boolean;
  minTrust: number;
  userTrust: number;
  quorumReached: boolean;
  quorum: number;
}

export function renderFlairVotePost(context: Context): JSX.Element {
  const proposalId = (context.postData?.['proposalId'] as string | undefined) ?? '';

  const [stateJson, setStateJson] = context.useState(async (): Promise<string | null> => {
    if (!proposalId) return null;
    const [proposalRaw, upRaw, downRaw, config] = await Promise.all([
      context.redis.get(Keys.flairProposal(proposalId)),
      context.redis.get(Keys.flairVotesUp(proposalId)),
      context.redis.get(Keys.flairVotesDown(proposalId)),
      getConfig(context.redis),
    ]);
    if (!proposalRaw) return null;
    const proposal = JSON.parse(proposalRaw) as FlairProposal;
    const upVotes = parseInt(upRaw ?? '0');
    const downVotes = parseInt(downRaw ?? '0');
    const total = upVotes + downVotes;
    const approvalPct = total > 0 ? Math.round((upVotes / total) * 100) : 0;
    const msLeft = proposal.endsAt - Date.now();
    const hoursLeft = Math.max(0, Math.round(msLeft / 3_600_000));
    const userId = context.userId ?? '';
    const existingVote = userId ? await context.redis.get(Keys.flairVote(proposalId, userId)) : null;
    const trustRecord = userId ? await getTrustScore(context.redis, userId) : null;
    const quorum = proposal.minVotes ?? config.flairVoting.minVotes ?? 0;
    const quorumReached = quorum > 0 && total >= quorum;
    if (proposal.status === 'active' && msLeft <= 0) {
      await context.scheduler.runJob({ name: 'flair_vote_tallier', runAt: new Date(), data: { forceAll: true } });
    }
    const canVote =
      !!userId &&
      !existingVote &&
      !quorumReached &&
      proposal.status === 'active' &&
      msLeft > 0 &&
      (trustRecord?.score ?? 0) >= config.flairVoting.minTrustToVote;
    const s: VoteState = {
      proposalJson: proposalRaw,
      upVotes, downVotes, approvalPct, hoursLeft,
      existingVote: existingVote ?? null,
      canVote, minTrust: config.flairVoting.minTrustToVote,
      userTrust: trustRecord?.score ?? 0, quorumReached, quorum,
    };
    return JSON.stringify(s);
  });

  if (!stateJson) {
    return (
      <vstack alignment="center middle" height="100%" width="100%" backgroundColor="neutral-background">
        <text size="large" color="neutral-content-weak">Proposal not found.</text>
      </vstack>
    );
  }

  const s = JSON.parse(stateJson) as VoteState;
  const proposal = JSON.parse(s.proposalJson) as FlairProposal;
  const { upVotes, downVotes, approvalPct, hoursLeft, existingVote, canVote, minTrust, userTrust, quorumReached, quorum } = s;
  const total = upVotes + downVotes;
  const closed = proposal.status !== 'active' || hoursLeft === 0 || quorumReached;

  async function castVote(direction: 'up' | 'down'): Promise<void> {
    const userId = context.userId ?? '';
    if (!userId) return;
    const lockKey = Keys.flairVoteLock(proposalId, userId);
    const locked = await context.redis.set(lockKey, '1', { nx: true, expiration: new Date(Date.now() + 10_000) });
    if (!locked) return;
    await context.redis.set(Keys.flairVote(proposalId, userId), direction, {
      expiration: new Date(proposal.endsAt + 86_400_000),
    });
    const [newUp, newDown] = await Promise.all([
      direction === 'up'
        ? context.redis.incrBy(Keys.flairVotesUp(proposalId), 1)
        : context.redis.get(Keys.flairVotesUp(proposalId)).then((v) => parseInt(v ?? '0')),
      direction === 'down'
        ? context.redis.incrBy(Keys.flairVotesDown(proposalId), 1)
        : context.redis.get(Keys.flairVotesDown(proposalId)).then((v) => parseInt(v ?? '0')),
    ]);
    const newTotal = newUp + newDown;
    const newPct = newTotal > 0 ? Math.round((newUp / newTotal) * 100) : 0;
    const wk = weekKey();
    await Promise.all([
      context.redis.zIncrBy(Keys.leaderboardContributionsWeekly(wk), userId, 1),
      context.redis.zIncrBy(Keys.leaderboardContributions, userId, 1),
    ]);
    if (quorum > 0 && newTotal >= quorum) {
      await context.scheduler.runJob({ name: 'flair_vote_tallier', runAt: new Date(), data: { forceAll: true } });
    }
    const updated: VoteState = { ...s, upVotes: newUp, downVotes: newDown, approvalPct: newPct, existingVote: direction, canVote: false };
    setStateJson(JSON.stringify(updated));
    context.ui.showToast(direction === 'up' ? 'Vote cast — yes!' : 'Vote cast — no.');
  }

  const isApproved = proposal.status === 'approved';
  const isDenied = proposal.status !== 'active' && proposal.status !== 'approved';
  const statusColor = isApproved ? '#00aa44' : isDenied ? '#ff4444' : '#0079d3';
  const progressColor = approvalPct >= 60 ? '#00aa44' : approvalPct >= 40 ? '#ffaa00' : '#ff4444';
  const barWidth = `${Math.max(2, approvalPct)}%`;

  return (
    <vstack height="100%" width="100%" alignment="center top">

      {/* Header strip */}
      <vstack
        width="100%"
        backgroundColor={isApproved ? '#00aa4422' : isDenied ? '#ff444422' : '#0079d322'}
        padding="medium"
        gap="small"
        alignment="center middle"
      >
        <text size="small" color={statusColor} weight="bold">
          {isApproved ? '✅ FLAIR ADDED' : isDenied ? '❌ VOTE CLOSED' : '🗳️ COMMUNITY VOTE'}
        </text>
        <text size="xlarge" weight="bold" alignment="center middle">
          {proposal.flair}
        </text>
        <text size="small" color="neutral-content-weak" alignment="center middle">
          {closed
            ? isApproved
              ? `Approved with ${approvalPct}% support`
              : quorumReached
              ? 'Vote limit reached — tallying results…'
              : 'Voting has ended'
            : hoursLeft > 0
            ? `${hoursLeft}h left to vote${quorum > 0 ? ` · ${total}/${quorum} votes` : ` · ${total} vote${total !== 1 ? 's' : ''}`}`
            : 'Closing…'}
        </text>
      </vstack>

      {/* Approval bar */}
      <vstack width="100%" padding="medium" gap="small">
        <hstack width="100%" alignment="start middle" gap="small">
          <text size="small" weight="bold" color="#00aa44">👍 {upVotes}</text>
          <hstack grow height="12px" backgroundColor="#33333333" cornerRadius="full">
            {approvalPct > 0 && (
              <hstack height="12px" grow={false} width={`${approvalPct}%` as `${number}%`} backgroundColor={progressColor} cornerRadius="full" />
            )}
          </hstack>
          <text size="small" weight="bold" color="#ff4444">{downVotes} 👎</text>
        </hstack>
        <hstack width="100%" alignment="center middle">
          <text size="small" color="neutral-content-weak">
            {total === 0 ? 'No votes yet' : `${approvalPct}% approval · ${total} vote${total !== 1 ? 's' : ''}`}
          </text>
        </hstack>
      </vstack>

      {/* Vote action area */}
      <vstack width="100%" padding="medium" gap="small">
        {existingVote ? (
          <vstack
            width="100%"
            backgroundColor="neutral-background"
            padding="medium"
            cornerRadius="medium"
            alignment="center middle"
            gap="small"
          >
            <text size="large">{existingVote === 'up' ? '👍' : '👎'}</text>
            <text size="small" color="neutral-content-weak">
              You voted {existingVote === 'up' ? 'yes' : 'no'} · thanks for participating!
            </text>
          </vstack>
        ) : closed ? (
          <vstack
            width="100%"
            backgroundColor="neutral-background"
            padding="medium"
            cornerRadius="medium"
            alignment="center middle"
          >
            <text size="small" color="neutral-content-weak">This vote is closed.</text>
          </vstack>
        ) : canVote ? (
          <hstack width="100%" gap="small">
            <button appearance="primary" grow onPress={() => castVote('up')}>
              👍  Yes, add it
            </button>
            <button appearance="secondary" grow onPress={() => castVote('down')}>
              👎  No thanks
            </button>
          </hstack>
        ) : (
          <vstack
            width="100%"
            backgroundColor="neutral-background"
            padding="medium"
            cornerRadius="medium"
            alignment="center middle"
            gap="small"
          >
            <text size="small" color="neutral-content-weak">
              {!context.userId
                ? 'Log in to vote.'
                : userTrust < minTrust
                ? `You need a trust score of ${minTrust} to vote (yours: ${userTrust}).`
                : 'Voting is closed.'}
            </text>
          </vstack>
        )}
      </vstack>

      {/* Footer */}
      <vstack width="100%" padding="medium" alignment="center middle">
        <text size="xsmall" color="neutral-content-weak">
          Proposed by u/{proposal.proposedByUsername} · Powered by SubGuardian
        </text>
      </vstack>

    </vstack>
  );
}
