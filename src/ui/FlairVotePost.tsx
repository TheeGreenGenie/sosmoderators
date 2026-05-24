import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import type { FlairProposal } from '../redis/schema.js';
import { Keys, weekKey } from '../redis/schema.js';
import { getConfig } from '../redis/config.js';
import { getTrustScore } from '../redis/users.js';

interface VoteState {
  proposalJson: string;  // FlairProposal serialized — avoids JSONValue index signature issue
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

  const [stateJson] = context.useState(async () => {
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
    const existingVote = userId
      ? await context.redis.get(Keys.flairVote(proposalId, userId))
      : null;

    const trustRecord = userId ? await getTrustScore(context.redis, userId) : null;
    const quorum = proposal.minVotes ?? config.flairVoting.minVotes ?? 0;
    const quorumReached = quorum > 0 && total >= quorum;

    // Auto-tally: if the proposal is still active but time has expired, schedule tallier immediately
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
      upVotes,
      downVotes,
      approvalPct,
      hoursLeft,
      existingVote: existingVote ?? null,
      canVote,
      minTrust: config.flairVoting.minTrustToVote,
      userTrust: trustRecord?.score ?? 0,
      quorumReached,
      quorum,
    };
    return JSON.stringify(s);
  });

  if (!stateJson) {
    return (
      <vstack alignment="center middle" height="100%" width="100%">
        <text color="neutral-content-weak">Proposal not found.</text>
      </vstack>
    );
  }

  const s = JSON.parse(stateJson) as VoteState;
  const proposal = JSON.parse(s.proposalJson) as FlairProposal;
  const { upVotes, downVotes, approvalPct, hoursLeft, existingVote, canVote, minTrust, userTrust, quorumReached, quorum } = s;
  const closed = proposal.status !== 'active' || hoursLeft === 0 || quorumReached;

  async function castVote(direction: 'up' | 'down'): Promise<void> {
    const userId = context.userId ?? '';
    if (!userId) return;

    // Idempotency lock: NX ensures only the first of any rapid duplicate clicks goes through
    const lockKey = Keys.flairVoteLock(proposalId, userId);
    const locked = await context.redis.set(lockKey, '1', {
      nx: true,
      expiration: new Date(Date.now() + 10_000),
    });
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
    context.ui.showToast(`Vote recorded: ${direction === 'up' ? '👍' : '👎'}`);

    // Award +1 contribution point to the voter on both weekly and all-time leaderboards
    const wk = weekKey();
    await Promise.all([
      context.redis.zIncrBy(Keys.leaderboardContributionsWeekly(wk), userId, 1),
      context.redis.zIncrBy(Keys.leaderboardContributions, userId, 1),
    ]);

    // Auto-tally: quorum just reached
    if (quorum > 0 && newUp + newDown >= quorum) {
      await context.scheduler.runJob({ name: 'flair_vote_tallier', runAt: new Date(), data: { forceAll: true } });
    }
  }

  const statusLabel = proposal.status === 'approved' ? 'Added!' : proposal.status !== 'active' ? 'Not Added' : null;

  return (
    <vstack height="100%" width="100%" gap="medium" padding="medium">
      <vstack gap="small">
        <text size="xlarge" weight="bold">Flair Vote</text>
        <text size="small" color="neutral-content-weak">
          Proposed by u/{proposal.proposedByUsername}
        </text>
      </vstack>

      <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
        <text size="large" weight="bold">{proposal.flair}</text>
        {statusLabel ? (
          <text size="small" color={proposal.status === 'approved' ? '#00aa44' : '#ff4444'} weight="bold">
            {statusLabel}
          </text>
        ) : quorumReached ? (
          <text size="small" color="neutral-content-weak">Vote limit reached — tallying soon.</text>
        ) : (
          <text size="small" color="neutral-content-weak">
            ⏱ {hoursLeft}h remaining{quorum > 0 ? ` · ${upVotes + downVotes}/${quorum} votes` : ''}
          </text>
        )}
      </vstack>

      <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
        <hstack gap="medium">
          <text size="small" color="#00aa44" weight="bold">👍 {upVotes}</text>
          <text size="small" color="#ff4444" weight="bold">👎 {downVotes}</text>
          <text size="small" color="neutral-content-weak">({approvalPct}% approval)</text>
        </hstack>
        <hstack backgroundColor="#00aa44" height="8px" width={`${approvalPct}%`} cornerRadius="small" />
      </vstack>

      {!closed && (
        <vstack gap="small">
          {existingVote ? (
            <text size="small" color="neutral-content-weak">
              You voted {existingVote === 'up' ? '👍' : '👎'}
            </text>
          ) : canVote ? (
            <hstack gap="small">
              <button appearance="primary" grow onPress={() => castVote('up')}>
                👍 Upvote
              </button>
              <button appearance="secondary" grow onPress={() => castVote('down')}>
                👎 Downvote
              </button>
            </hstack>
          ) : (
            <text size="small" color="neutral-content-weak">
              {!context.userId
                ? 'Log in to vote.'
                : userTrust < minTrust
                ? `Trust score ${userTrust} / ${minTrust} required to vote.`
                : 'Voting is closed.'}
            </text>
          )}
        </vstack>
      )}
    </vstack>
  );
}
