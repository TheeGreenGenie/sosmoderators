import type { ScheduledJobEvent, JobContext } from '@devvit/public-api';
import { Keys, dateKey, weekKey } from '../redis/schema.js';
import type { ShadowAuditEntry } from '../redis/schema.js';
import { getConfig, setConfig } from '../redis/config.js';

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','has','have','had','do','does','did',
  'i','my','you','your','we','our','they','their','it','its','this','that',
  'not','no','so','if','as','by','up','out','can','will','just','how','what',
  'when','where','who','why','he','she','him','her','his','get','got',
]);

function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/**
 * Runs every 15 minutes.
 * Reads daily counters and writes rolling 7-day and 30-day averages
 * to pre-computed aggregate keys that the dashboard reads directly.
 */
export async function runAggregateBuilder(
  _event: ScheduledJobEvent<undefined>,
  context: JobContext
): Promise<void> {
  console.log(`[AggregateBuilder] job started`);
  const redis = context.redis;
  const now = new Date();

  // Compute 7-day averages for posts
  const sevenDayTotals = { total: 0, removed: 0, flagged: 0, approved: 0 };
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = Keys.aggPostsDaily(dateKey(d));
    const [total, removed, flagged, approved] = await Promise.all([
      redis.hGet(key, 'total'),
      redis.hGet(key, 'removed'),
      redis.hGet(key, 'flagged'),
      redis.hGet(key, 'approved'),
    ]);
    sevenDayTotals.total += parseInt(total ?? '0');
    sevenDayTotals.removed += parseInt(removed ?? '0');
    sevenDayTotals.flagged += parseInt(flagged ?? '0');
    sevenDayTotals.approved += parseInt(approved ?? '0');
  }

  const avgKey = 'agg:posts:7d_avg';
  await redis.hSet(avgKey, {
    total: String(Math.round(sevenDayTotals.total / 7)),
    removed: String(Math.round(sevenDayTotals.removed / 7)),
    flagged: String(Math.round(sevenDayTotals.flagged / 7)),
    approved: String(Math.round(sevenDayTotals.approved / 7)),
    computedAt: String(Date.now()),
  });

  // Build topic frequency from today's post title cache
  // Pull top 100 cached title hashes — we store raw titles in a parallel key
  const topicKey = Keys.aggTopics(dateKey(now));
  const recentTitles = await redis.get('agg:recent_titles');
  if (recentTitles) {
    const titles: string[] = JSON.parse(recentTitles) as string[];
    for (const title of titles) {
      for (const kw of extractKeywords(title)) {
        await redis.zIncrBy(topicKey, kw, 1);
      }
    }
    // Expire after 30 days
    await redis.expire(topicKey, 30 * 86_400);
  }

  // Context-aware contribution scoring: fetch top posts this week, normalize by sub avg score
  const wk = weekKey(now);
  const processedKey = Keys.contributionsProcessed(wk);
  const processedRaw = await redis.get(processedKey);
  const processed: string[] = processedRaw ? (JSON.parse(processedRaw) as string[]) : [];

  try {
    const topPosts = await context.reddit.getTopPosts({
      subredditName: context.subredditName ?? '',
      timeframe: 'week',
      limit: 25,
    }).all();

    if (topPosts.length > 0) {
      const scores = topPosts.map((p) => p.score);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      await redis.set(Keys.postScoreAvg, String(Math.round(avgScore)));

      for (const post of topPosts) {
        if (processed.includes(post.id)) continue;

        const authorId = await redis.get(Keys.postAuthorId(post.id));
        if (!authorId) continue;

        // Bonus points = normalized score, capped at 10x to prevent outliers dominating
        const multiplier = Math.min(10, Math.max(1, Math.round(post.score / avgScore)));
        // Only award bonus if post is performing above average (multiplier > 1)
        if (multiplier > 1) {
          await redis.zIncrBy(
            Keys.leaderboardContributionsWeekly(wk),
            authorId,
            multiplier - 1 // subtract 1 because postSubmit already gave the base point
          );
        }

        processed.push(post.id);
      }

      await redis.set(processedKey, JSON.stringify(processed), {
        expiration: new Date(Date.now() + 8 * 86_400 * 1000),
      });
    }
  } catch {
    console.log(`[AggregateBuilder] top posts fetch failed (may need App Review for reddit API in jobs)`);
  }

  // Shadow-Audit digest: send modmail report once 24h after shadow mode started
  await runShadowAuditDigest(context);

  // Record job completion timestamp
  await redis.set('agg:last_built', String(Date.now()));
  console.log(`[AggregateBuilder] done — 7d avg posts=${Math.round(sevenDayTotals.total / 7)}`);
}

const SHADOW_DIGEST_INTERVAL_MS = 24 * 3_600_000; // 24 hours

async function runShadowAuditDigest(context: JobContext): Promise<void> {
  const redis = context.redis;
  const config = await getConfig(redis);
  const shadowKeywords = config.shadowAudit?.keywords ?? [];
  const startedAt = config.shadowAudit?.startedAt ?? null;

  if (shadowKeywords.length === 0 || startedAt === null) return;

  const now = Date.now();
  if (now - startedAt < SHADOW_DIGEST_INTERVAL_MS) return; // not 24h yet

  const subredditName = context.subredditName ?? '';
  const digestLines: string[] = [
    `## Shadow-Audit Digest — r/${subredditName}`,
    ``,
    `Shadow mode has been running for ${Math.round((now - startedAt) / 3_600_000)}h.`,
    ``,
  ];

  let anyNewDigests = false;

  for (const kw of shadowKeywords) {
    const digestSentKey = Keys.shadowAuditDigestSent(kw);
    const lastSentRaw = await redis.get(digestSentKey);
    const lastSent = lastSentRaw ? parseInt(lastSentRaw) : 0;

    // Only send if no digest has been sent since this shadow run started
    if (lastSent >= startedAt) continue;

    const listKey = Keys.shadowAuditList(kw);
    const count = await redis.zCard(listKey);

    if (count === 0) {
      digestLines.push(`**"${kw}"** — caught 0 posts in the last 24h.`);
    } else {
      const rawMembers = await redis.zRange(listKey, 0, count - 1, { by: 'rank', reverse: true });
      const entries: ShadowAuditEntry[] = rawMembers.flatMap(({ member }) => {
        try {
          const { _u: _, ...entry } = JSON.parse(member) as ShadowAuditEntry & { _u: string };
          return [entry];
        } catch {
          return [];
        }
      });

      const samples = entries.slice(0, 5);
      digestLines.push(`**"${kw}"** — would have caught **${count}** post${count !== 1 ? 's' : ''} in the last 24h:`);
      for (const s of samples) {
        digestLines.push(`  • "${s.title}" (score: ${s.score.toFixed(2)})`);
      }
    }

    digestLines.push(
      ``,
      `To activate this rule now, reply: \`!shadow-activate ${kw}\``,
      ``,
    );

    await redis.set(digestSentKey, String(now));
    anyNewDigests = true;
  }

  if (!anyNewDigests) return;

  try {
    await context.reddit.modMail.createConversation({
      subredditName,
      subject: `SubGuardian Shadow-Audit Report — ${new Date().toDateString()}`,
      body: digestLines.join('\n'),
      isAuthorHidden: false,
    });
    console.log(`[ShadowAudit] digest sent for ${subredditName} — keywords: ${shadowKeywords.join(', ')}`);
  } catch (e) {
    console.log(`[ShadowAudit] digest modmail failed: ${e}`);
  }
}
