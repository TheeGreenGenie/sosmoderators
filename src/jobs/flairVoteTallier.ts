import type { ScheduledJobEvent, JobContext } from '@devvit/public-api';
import type { FlairProposal } from '../redis/schema.js';
import { Keys } from '../redis/schema.js';
import { getConfig, setConfig } from '../redis/config.js';
import { getActivity, updateActivity, setTrustScore } from '../redis/users.js';
import { buildTrustScore } from '../scoring/trustScore.js';
import { isInGrace } from '../redis/users.js';
import { VOTE_APPROVAL_RATIO } from '../utils/constants.js';

/**
 * Runs every hour. Checks active flair proposals for expiry,
 * tallies votes, approves/rejects, and awards credit to proposers.
 */
export async function runFlairVoteTallier(
  event: ScheduledJobEvent<{ forceAll?: boolean } | undefined>,
  context: JobContext,
  forceAllOverride?: boolean
): Promise<void> {
  const forceAll = forceAllOverride ?? (event.data as { forceAll?: boolean } | undefined)?.forceAll ?? false;
  const redis = context.redis;
  console.log(`[FlairVoteTallier] job started forceAll=${forceAll}`);

  const listRaw = await redis.get(Keys.flairProposalList);
  console.log(`[FlairVoteTallier] proposalList raw="${listRaw}"`);
  if (!listRaw) {
    console.log(`[FlairVoteTallier] no proposal list found — exiting`);
    return;
  }

  const proposalIds: string[] = JSON.parse(listRaw) as string[];
  console.log(`[FlairVoteTallier] ${proposalIds.length} proposal(s) to check: ${proposalIds.join(', ')}`);
  const remaining: string[] = [];
  const config = await getConfig(redis);

  for (const id of proposalIds) {
    const proposalRaw = await redis.get(Keys.flairProposal(id));
    if (!proposalRaw) {
      console.log(`[FlairVoteTallier] proposal ${id} — not found in Redis, skipping`);
      continue;
    }

    const proposal = JSON.parse(proposalRaw) as FlairProposal;
    console.log(`[FlairVoteTallier] proposal ${id}: flair="${proposal.flair}" status=${proposal.status} endsAt=${new Date(proposal.endsAt).toISOString()} now=${new Date().toISOString()} forceAll=${forceAll}`);

    if (proposal.status !== 'active') {
      console.log(`[FlairVoteTallier] proposal ${id} — status=${proposal.status}, skipping`);
      continue;
    }

    if (!forceAll && Date.now() < proposal.endsAt) {
      console.log(`[FlairVoteTallier] proposal ${id} — not yet expired (${Math.round((proposal.endsAt - Date.now()) / 60000)}m remaining), keeping active`);
      remaining.push(id);
      continue;
    }

    // Tally
    const [upRaw, downRaw] = await Promise.all([
      redis.get(Keys.flairVotesUp(id)),
      redis.get(Keys.flairVotesDown(id)),
    ]);
    const upVotes = parseInt(upRaw ?? '0');
    const downVotes = parseInt(downRaw ?? '0');
    const total = upVotes + downVotes;
    const approvalRatio = total > 0 ? upVotes / total : 0;
    const requiredRatio = proposal.approvalPct ?? config.flairVoting.approvalRatio ?? VOTE_APPROVAL_RATIO;
    const quorum = proposal.minVotes ?? config.flairVoting.minVotes ?? 0;
    const approved = approvalRatio >= requiredRatio && total >= quorum;
    console.log(`[FlairVoteTallier] tally: up=${upVotes} down=${downVotes} total=${total} approvalRatio=${approvalRatio.toFixed(2)} requiredRatio=${requiredRatio} quorum=${quorum} quorumMet=${total >= quorum} approved=${approved}`);

    proposal.status = approved ? 'approved' : 'rejected';
    await redis.set(Keys.flairProposal(id), JSON.stringify(proposal));
    console.log(`[FlairVoteTallier] proposal ${id} → ${proposal.status} (${upVotes}↑ ${downVotes}↓)`);

    if (approved) {
      const subName = context.subredditName ?? '';

      // Add flair to SubGuardian config list
      const flairAlreadyExists = config.flairList.includes(proposal.flair);
      console.log(`[FlairVoteTallier] adding flair "${proposal.flair}" to config (already exists: ${flairAlreadyExists})`);
      if (!flairAlreadyExists) {
        config.flairList.push(proposal.flair);
        await setConfig(redis, config);
        console.log(`[FlairVoteTallier] flair "${proposal.flair}" saved to config. New flairList: ${config.flairList.join(', ')}`);
      }

      // Create the Reddit post flair template if it doesn't already exist
      try {
        const existingTemplates = await context.reddit.getPostFlairTemplates(subName);
        const templateExists = existingTemplates.some(
          (t) => t.text.toLowerCase() === proposal.flair.toLowerCase()
        );
        console.log(`[FlairVoteTallier] Reddit flair template "${proposal.flair}" exists=${templateExists}`);
        if (!templateExists) {
          const created = await context.reddit.createPostFlairTemplate({
            subredditName: subName,
            text: proposal.flair,
            allowableContent: 'all',
            allowUserEdits: false,
            modOnly: false,
          });
          console.log(`[FlairVoteTallier] created Reddit flair template "${proposal.flair}" id=${created.id}`);
        }
      } catch (e) {
        console.log(`[FlairVoteTallier] failed to create flair template: ${e}`);
      }

      // Award proposer: increment proposedFlairsAdopted + recompute trust + weekly contribution points
      const proposerId = proposal.proposedByUserId;
      if (proposerId) {
        const [activity, inGrace] = await Promise.all([
          getActivity(redis, proposerId),
          isInGrace(redis, proposerId),
        ]);
        const updatedActivity = await updateActivity(redis, proposerId, {
          proposedFlairsAdopted: activity.proposedFlairsAdopted + 1,
        });
        const newTrust = buildTrustScore(
          {
            accountAgeDays: 0,
            subKarma: 0,
            totalSubPosts: updatedActivity.totalSubPosts,
            approvedSubPosts: updatedActivity.approvedSubPosts,
            removedPosts: updatedActivity.removedPosts,
            actionedReportsAgainst: updatedActivity.actionedReportsAgainst,
            tempBanCount: updatedActivity.tempBanCount,
            permBanHistory: updatedActivity.permBanHistory,
            awardsReceived: updatedActivity.awardsReceived,
            topPostCount: updatedActivity.topPostCount,
            helpfulReportCount: updatedActivity.helpfulReportCount,
            proposedFlairsAdopted: updatedActivity.proposedFlairsAdopted,
          },
          inGrace
        );
        await setTrustScore(redis, proposerId, newTrust);

        // +5 contribution points for adopted flair
        const { weekKey } = await import('../redis/schema.js');
        const wk = weekKey();
        await redis.zIncrBy(Keys.leaderboardContributionsWeekly(wk), proposerId, 5);
      }
    }
  }

  // Write back only still-active proposals
  await redis.set(Keys.flairProposalList, JSON.stringify(remaining));
  console.log(`[FlairVoteTallier] done — ${remaining.length} active proposals remain`);
}
