import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import type { ActivityCounters, ModCaseRecord, PostMeta, SpamScore, TrustScore } from '../../redis/schema.js';
import { Keys } from '../../redis/schema.js';
import { getActivity, getTrustScore } from '../../redis/users.js';
import { logAction } from '../../moderation/auditLog.js';
import { signalLabel } from '../../utils/pmTemplates.js';

export interface FlaggedPostItem {
  id: string;
  title: string;
  spamScore: number;
  reportCount: number;
  score: number;
  signals: string[];
  recovery?: boolean;
}

interface CaseFileState {
  meta: PostMeta | null;
  trust: TrustScore | null;
  activity: ActivityCounters;
  similarCases: ModCaseRecord[];
  inRecovery: boolean;
}

function signalBucket(signals: string[]): string {
  return [...signals].sort().join(',');
}

export async function writeCaseRecord(
  context: Context,
  postId: string,
  title: string,
  signals: string[],
  decision: 'approved' | 'removed',
  modNote: string,
): Promise<void> {
  const record: ModCaseRecord = {
    postId,
    title,
    decision,
    modNote,
    actor: context.userId ?? 'mod',
    timestamp: Date.now(),
  };
  const key = Keys.modCases(signalBucket(signals));
  await context.redis.zAdd(key, { score: record.timestamp, member: JSON.stringify(record) });
  await context.redis.expire(key, 90 * 86_400);
}

function suggestVerdict(spamScore: SpamScore, activity: ActivityCounters, autoRemoveThreshold: number): { verdict: 'approve' | 'remove'; reasoning: string } {
  if (activity.removedPosts === 0 && spamScore.score < 0.70) {
    return { verdict: 'approve', reasoning: 'first offense, score below strong-remove threshold' };
  }
  if (spamScore.score >= autoRemoveThreshold) {
    return { verdict: 'remove', reasoning: 'score above auto-remove threshold' };
  }
  if (activity.removedPosts >= 2) {
    return { verdict: 'remove', reasoning: 'repeat prior removals' };
  }
  return { verdict: 'approve', reasoning: 'borderline score and no strong repeat-offender signal' };
}

export function CaseFile(context: Context, post: FlaggedPostItem, onBack: () => void): JSX.Element {
  const [note, setNote] = context.useState<string>('');
  const [stateJson] = context.useState(async (): Promise<string> => {
    const metaRaw = await context.redis.get(Keys.postMeta(post.id));
    const meta = metaRaw ? (JSON.parse(metaRaw) as PostMeta) : null;
    const [trust, activity, recoveryRaw, casesRaw] = await Promise.all([
      meta?.authorId ? getTrustScore(context.redis, meta.authorId) : Promise.resolve(null),
      meta?.authorId ? getActivity(context.redis, meta.authorId) : Promise.resolve({
        totalSubPosts: 0,
        approvedSubPosts: 0,
        removedPosts: 0,
        topPostCount: 0,
        helpfulReportCount: 0,
        actionedReportsAgainst: 0,
        tempBanCount: 0,
        permBanHistory: 0,
        awardsReceived: 0,
        proposedFlairsAdopted: 0,
        lastActivityTs: 0,
      }),
      context.redis.get(Keys.postRecovery(post.id)),
      context.redis.zRange(Keys.modCases(signalBucket(post.signals)), 0, 2, { by: 'rank', reverse: true }),
    ]);
    const similarCases = casesRaw.flatMap(({ member }) => {
      try {
        return [JSON.parse(member) as ModCaseRecord];
      } catch {
        return [];
      }
    });
    return JSON.stringify({ meta, trust, activity, similarCases, inRecovery: !!recoveryRaw });
  });
  const state = JSON.parse(stateJson) as CaseFileState;

  const spamScore: SpamScore = { score: post.spamScore, signals: post.signals, computedAt: Date.now() };
  const suggestion = suggestVerdict(spamScore, state.activity, 0.85);

  async function act(decision: 'approved' | 'removed'): Promise<void> {
    if (decision === 'approved') {
      await context.reddit.approve(post.id);
      try {
        await context.reddit.setPostFlair({
          postId: post.id,
          subredditName: context.subredditName ?? '',
          text: '',
        });
      } catch { /* non-fatal */ }
    } else {
      await context.reddit.remove(post.id, false);
    }
    await writeCaseRecord(context, post.id, post.title, post.signals, decision, note);
    await logAction(context.redis, {
      timestamp: Date.now(),
      action: decision === 'approved' ? 'post_approved' : 'post_removed',
      targetId: post.id,
      targetType: 'post',
      actor: context.userId ?? 'mod',
      reason: note || `Case File ${decision}`,
      score: post.spamScore,
    });
    context.ui.showToast(`Post ${decision}.`);
    onBack();
  }

  const noteForm = context.useForm(
    {
      title: 'Add case note',
      fields: [{ type: 'paragraph', name: 'note', label: 'Moderator note', required: false }],
      acceptLabel: 'Save',
    },
    async (values) => {
      setNote((values['note'] as string | undefined) ?? '');
    },
  );

  return (
    <vstack gap="small" padding="medium">
      <hstack alignment="start middle" gap="small">
        <button size="small" appearance="secondary" onPress={onBack}>Back</button>
        <text weight="bold" grow>Modqueue Case File</text>
        {state.inRecovery ? <text size="small" color="#ffaa00" weight="bold">Recovery</text> : null}
      </hstack>

      <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="small" gap="small">
        <text weight="bold" wrap>POST: "{post.title}"</text>
        <text size="small" color="neutral-content-weak">
          Author: u/{state.meta?.authorName ?? 'unknown'} | Trust {state.trust?.score ?? 300} ({state.trust?.tier ?? 'neutral'})
        </text>
      </vstack>

      <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="small" gap="small">
        <text weight="bold">Why flagged</text>
        {post.signals.map((signal) => <text key={signal} size="small">- {signalLabel(signal)}</text>)}
        <text size="small" color="neutral-content-weak">Total: {post.spamScore.toFixed(2)}</text>
      </vstack>

      <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="small" gap="small">
        <text weight="bold">Author history in r/{context.subredditName ?? ''}</text>
        <text size="small">- {state.activity.removedPosts} prior violations | {state.activity.approvedSubPosts} approved posts</text>
        <text size="small">- {state.activity.actionedReportsAgainst} actioned reports against them</text>
      </vstack>

      <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="small" gap="small">
        <text weight="bold">Similar past cases</text>
        {state.similarCases.length === 0 ? (
          <text size="small" color="neutral-content-weak">No precedent yet for this signal mix.</text>
        ) : state.similarCases.map((c) => (
          <text key={`${c.postId}:${c.timestamp}`} size="small" wrap>
            - {new Date(c.timestamp).toISOString().slice(0, 10)} {c.decision.toUpperCase()}: {c.modNote || c.title}
          </text>
        ))}
      </vstack>

      <vstack backgroundColor="neutral-background-selected" padding="medium" cornerRadius="small" gap="small">
        <text weight="bold">SubGuardian suggests: {suggestion.verdict.toUpperCase()}</text>
        <text size="small" color="neutral-content-weak">{suggestion.reasoning}</text>
        {note ? <text size="small" wrap>Note: {note}</text> : null}
      </vstack>

      <hstack gap="small">
        <button size="small" appearance="secondary" onPress={() => context.ui.showForm(noteForm)}>Add note</button>
        <button size="small" appearance="primary" grow onPress={() => act('approved')}>Approve</button>
        <button size="small" appearance="destructive" grow onPress={() => act('removed')}>Remove</button>
      </hstack>
    </vstack>
  );
}
