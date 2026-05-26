import type { ScheduledJobEvent, JobContext } from '@devvit/public-api';
import { Keys, dateKey, weekKey } from '../redis/schema.js';
import type { ShadowAuditEntry } from '../redis/schema.js';
import { getConfig } from '../redis/config.js';

const VOWELS_SET = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowel = (c: string): boolean => VOWELS_SET.has(c);

function fixStem(s: string): string {
  if (s.length < 2) return s;
  const last = s[s.length - 1]!;
  const prev = s[s.length - 2]!;
  if (last === prev && !isVowel(last) && last !== 'l' && last !== 's' && last !== 'z') {
    return s.slice(0, -1);
  }
  if (
    s.length >= 3 &&
    !isVowel(last) && last !== 'w' && last !== 'x' && last !== 'y' &&
    isVowel(prev) &&
    !isVowel(s[s.length - 3]!)
  ) {
    return s + 'e';
  }
  return s;
}

function stem(word: string): string {
  const n = word.length;
  let s: string;
  if (n > 5 && word.endsWith('ings')) { s = fixStem(word.slice(0, -4)); if (s.length >= 4) return s; }
  if (n > 5 && word.endsWith('ing'))  { s = fixStem(word.slice(0, -3)); if (s.length >= 4) return s; }
  if (n > 5 && word.endsWith('ied')) return word.slice(0, -3) + 'y';
  if (n > 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (n > 5 && word.endsWith('ed'))  { s = fixStem(word.slice(0, -2)); if (s.length >= 4) return s; }
  if (n > 6 && word.endsWith('ers')) { s = word.slice(0, -3); if (s.length >= 4) return s; }
  if (n > 5 && word.endsWith('er'))  { s = word.slice(0, -2); if (s.length >= 4) return s; }
  if (n > 6 && word.endsWith('est')) { s = word.slice(0, -3); if (s.length >= 4) return s; }
  if (n > 5 && word.endsWith('ly'))  { s = word.slice(0, -2); if (s.length >= 4) return s; }
  if (n > 4 && word.endsWith('es') && !word.endsWith('oes')) { s = word.slice(0, -2); if (s.length >= 4) return s; }
  if (n > 4 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) {
    s = word.slice(0, -1); if (s.length >= 4) return s;
  }
  return word;
}

const STOP_WORDS = new Set([
  // Articles / determiners
  'a','an','the','this','that','these','those','some','any','all','both',
  'each','every','either','neither','no','own','same','such','than','then',
  // Prepositions
  'in','on','at','to','for','of','with','by','from','into','onto','upon',
  'about','above','below','under','over','after','before','between','among',
  'through','during','within','without','against','along','around','behind',
  'beside','besides','despite','except','inside','outside','toward','towards',
  'until','upon','within',
  // Conjunctions
  'and','or','but','nor','so','yet','both','either','neither','whether',
  'although','because','since','unless','until','while','whereas','though',
  // Pronouns
  'i','me','my','mine','myself','you','your','yours','yourself','he','him',
  'his','himself','she','her','hers','herself','it','its','itself','we','us',
  'our','ours','ourselves','they','them','their','theirs','themselves',
  'who','whom','whose','which','what','whatever','whoever','whomever',
  // Common auxiliary / modal verbs
  'is','are','was','were','be','been','being','am','have','has','had',
  'having','do','does','did','doing','done','will','would','could','should',
  'shall','may','might','must','can','need','dare','ought','used',
  // Common full verbs (generic — unlikely to be topics)
  'get','got','gets','getting','gotten','give','gave','given','giving',
  'go','goes','went','gone','going','come','came','coming','take','took',
  'taken','taking','make','made','makes','making','know','knew','known',
  'knowing','think','thought','thinks','thinking','see','saw','seen','seeing',
  'look','looked','looks','looking','want','wants','wanted','wanting',
  'use','used','uses','using','find','found','finds','finding','try',
  'tried','tries','trying','tell','told','tells','telling','show','showed',
  'shown','shows','showing','feel','felt','feels','feeling','seem','seemed',
  'seems','work','works','worked','working','keep','kept','keeps','keeping',
  'let','lets','letting','put','puts','putting','say','said','says','saying',
  'call','calls','called','calling','ask','asks','asked','asking','turn',
  'turned','turns','turning','follow','follows','followed','following',
  'move','moved','moves','moving','live','lived','lives','living','mean',
  'means','meant','meaning','set','sets','setting','run','runs','ran',
  'running','hold','held','holds','holding','send','sent','sends','sending',
  'add','adds','added','adding','change','changed','changes','changing',
  'open','opens','opened','opening','close','closed','closes','closing',
  'read','reads','reading','start','started','starts','starting','stop',
  'stopped','stops','stopping','play','plays','played','playing',
  // Common adjectives (generic)
  'good','better','best','bad','worse','worst','big','bigger','biggest',
  'small','smaller','smallest','new','newer','newest','old','older','oldest',
  'high','higher','highest','low','lower','lowest','long','longer','longest',
  'short','wide','narrow','great','large','little','much','more','most',
  'less','least','many','few','nice','real','right','wrong','true','false',
  'free','full','open','close','hard','easy','early','late','fast','slow',
  'next','last','first','other','another','only','even','just','still',
  'also','very','quite','rather','pretty','really','actually','maybe',
  'often','always','never','ever','already','soon','again','once','here',
  'there','now','then','today','tomorrow','yesterday',
  // Common nouns (generic, not topical)
  'thing','things','something','nothing','everything','anything','someone',
  'anyone','everyone','nobody','somebody','everybody','person','people',
  'time','times','day','days','week','weeks','month','months','year','years',
  'way','ways','part','parts','place','places','case','point','world',
  'life','hand','side','home','name','fact','line','form','type','kind',
  'group','number','area','system','company','state','word','end','back',
  'example','information','experience','idea','question','result','problem',
  // Reddit/internet meta-words (the key additions)
  'post','posts','repost','thread','threads','comment','comments','reply',
  'replies','upvote','downvote','karma','award','awards','subreddit','reddit',
  'redditor','mods','mod','moderator','moderators','admin','admins','rule',
  'rules','flair','flairs','wiki','sidebar','link','title','body','text',
  'image','video','photo','photos','content','submission','crosspost',
  // Generic request / meta language
  'please','thanks','thank','help','update','edit','info','need','want',
  'asking','asked','question','looking','anyone','somebody','everyone',
  'thought','wondering','advice','tips','suggestion','suggestions','idea',
  'ideas','share','sharing','discuss','discussion','regarding','about',
  'related','similar','same','like','just','okay','sure','maybe','probably',
  'actually','basically','literally','honestly','seriously','definitely',
  'obviously','apparently','recently','currently','finally','already',
  'still','back','forward','since','while','until','though','although',
]);

function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w))
    .map(stem)
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

  // Build topic frequency from today's post title cache.
  // Prune/canonicalise existing members: remove stop words, short/numeric words,
  // and un-stemmed forms (e.g. "testing" → "test"). Scores for un-stemmed forms
  // are merged into their stem so no counts are lost.
  const topicKey = Keys.aggTopics(dateKey(now));
  const existingCount = await redis.zCard(topicKey);
  if (existingCount > 0) {
    const existing = await redis.zRange(topicKey, 0, existingCount - 1, { by: 'rank' });

    // Build a merged map: canonical (stemmed) form → accumulated score
    const merged = new Map<string, number>();
    let needsRebuild = false;

    for (const { member, score } of existing) {
      const canonical = stem(member);
      const isInvalid =
        canonical.length < 4 ||
        /^\d+$/.test(canonical) ||
        STOP_WORDS.has(canonical);

      if (isInvalid) {
        needsRebuild = true; // drop it entirely
        continue;
      }

      if (canonical !== member) needsRebuild = true; // un-stemmed form — merge into stem

      merged.set(canonical, (merged.get(canonical) ?? 0) + score);
    }

    if (needsRebuild) {
      await redis.del(topicKey);
      for (const [member, score] of merged) {
        await redis.zAdd(topicKey, { member, score });
      }
    }
  }

  // Then accumulate new keyword counts from recent post titles
  const recentTitles = await redis.get('agg:recent_titles');
  if (recentTitles) {
    const titles: string[] = JSON.parse(recentTitles) as string[];
    for (const title of titles) {
      for (const kw of extractKeywords(title)) {
        await redis.zIncrBy(topicKey, kw, 1);
      }
    }
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
