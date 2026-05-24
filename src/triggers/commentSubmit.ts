import type { TriggerEventType, TriggerContext } from '@devvit/public-api';
import { triggerGuard } from '../moderation/killSwitch.js';
import { addHourlyToxicity, addToxicityAgg } from '../redis/aggregates.js';
import { computeToxicityScore } from '../scoring/toxicityScore.js';
import { Keys } from '../redis/schema.js';
import type { FlairSuggestion } from '../redis/schema.js';
import { getConfig } from '../redis/config.js';

export async function onCommentSubmit(event: TriggerEventType['CommentSubmit'], context: TriggerContext): Promise<void> {
  const redis = context.redis;
  if (!event.comment) return;
  const commentId = event.comment.id;

  const guard = await triggerGuard(redis, `comment:${commentId}`);
  if (!guard.proceed) return;

  const text = event.comment.body ?? '';
  const toxicity = computeToxicityScore(text);

  await Promise.all([
    addToxicityAgg(redis, toxicity.score),
    addHourlyToxicity(redis, toxicity.score),
  ]);

  // Flair confirmation: check if this comment is from the post author replying "yes"
  const postId = event.comment.postId;
  if (!postId) return;

  const suggestionRaw = await redis.get(Keys.flairSuggestion(postId));
  if (!suggestionRaw) return;

  const suggestion = JSON.parse(suggestionRaw) as FlairSuggestion;
  const commentAuthorId = event.author?.id ?? '';

  // Only the original post author can confirm
  if (commentAuthorId !== suggestion.postAuthorId) return;

  // Accept "yes" or the flair name itself (case-insensitive)
  const normalised = text.trim().toLowerCase();
  const flairNormalised = suggestion.flair.toLowerCase();
  if (normalised !== 'yes' && normalised !== flairNormalised) return;

  // Check that this confirmation is the most recent (within 7 days of suggestion)
  const config = await getConfig(redis);
  const subName = context.subredditName ?? '';

  try {
    await context.reddit.setPostFlair({
      postId,
      subredditName: subName,
      text: suggestion.flair,
    });
  } catch {
    console.log(`[CommentSubmit] flair apply failed — postId=${postId}`);
    return;
  }

  // Remove suggestion so further replies are ignored
  await redis.del(Keys.flairSuggestion(postId));

  // Delete the bot's suggestion comment to keep the thread clean
  if (suggestion.commentId) {
    try {
      await context.reddit.remove(suggestion.commentId, false);
    } catch {
      // Comment may already be deleted
    }
  }

  // Acknowledge to the confirming commenter
  const authorName = event.author?.name ?? '';
  if (authorName) {
    try {
      await context.reddit.sendPrivateMessage({
        to: authorName,
        subject: `Flair applied on r/${subName}`,
        text: [
          `Hi u/${authorName},`,
          ``,
          `The **"${suggestion.flair}"** flair has been applied to your post.`,
          ``,
          `*This is an automated message from SubGuardian.*`,
        ].join('\n'),
      });
    } catch {
      // PM not critical
    }
  }

  console.log(`[CommentSubmit] flair confirmed — postId=${postId} flair=${suggestion.flair}`);
  void config; // config loaded for future extensibility (e.g. per-sub PM opt-out)
}
