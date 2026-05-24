import type { ScheduledJobEvent, JobContext } from '@devvit/public-api';
import { Keys, weekKey } from '../redis/schema.js';

/**
 * Runs every Sunday at 20:00 UTC.
 * Finds the top contributor for the week, creates a highlight post, and pins it.
 */
export async function runWeeklyHighlight(
  _event: ScheduledJobEvent<undefined>,
  context: JobContext
): Promise<void> {
  const redis = context.redis;
  const subredditName = context.subredditName ?? '';
  console.log(`[WeeklyHighlight] job started`);

  const wk = weekKey();
  const members = await redis.zRange(
    Keys.leaderboardContributionsWeekly(wk),
    0, 0,
    { by: 'rank', reverse: true }
  );

  if (members.length === 0) {
    console.log(`[WeeklyHighlight] no contributors this week, skipping`);
    return;
  }

  const top = members[0];
  if (!top) return;

  const username = (await redis.get(Keys.userUsername(top.member))) ?? top.member;
  const score = Math.round(top.score);

  // Remove old highlight post if it exists
  const oldPostId = await redis.get(Keys.weeklyHighlightPostId);
  if (oldPostId) {
    try {
      await context.reddit.remove(oldPostId, false);
    } catch {
      // Already gone
    }
  }

  const post = await context.reddit.submitPost({
    subredditName,
    title: `🏆 Top Contributor of the Week: u/${username}`,
    text: [
      `Congratulations to **u/${username}** for being this week's top contributor with **${score} contribution points**!`,
      ``,
      `Contribution points are earned by:`,
      `- ✅ Getting posts approved (+1 each)`,
      `- 🏷️ Proposing flairs that the community adopts (+5 each)`,
      `- ⭐ Receiving bonus points for high-engagement posts (normalized to sub activity)`,
      ``,
      `*This post is generated automatically each week by SubGuardian.*`,
    ].join('\n'),
  });

  await redis.set(Keys.weeklyHighlightPostId, post.id);

  // Try to sticky the post (position 2 leaves position 1 for mods)
  try {
    await post.sticky(2);
  } catch {
    console.log(`[WeeklyHighlight] could not sticky post (may already have 2 stickies)`);
  }

  console.log(`[WeeklyHighlight] posted highlight for u/${username} — postId=${post.id}`);
}
