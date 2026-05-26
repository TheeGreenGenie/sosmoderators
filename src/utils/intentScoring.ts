/**
 * Intent classification and entity extraction for SubGuardian Coach.
 * Pure functions — zero Devvit dependencies, unit-testable.
 */

export type IntentId =
  | 'WHY_FLAGGED_POST'
  | 'USER_PROFILE'
  | 'SUGGEST_KEYWORDS'
  | 'EXPLAIN_CONFIG'
  | 'EXPLAIN_TRUST'
  | 'WHAT_DO_FIRST'
  | 'RAID_STATUS'
  | 'STATS_SUMMARY'
  | 'PENDING_POSTS'
  | 'APPEAL_GUIDANCE'
  | 'DRAFT_REMOVAL_PM'
  | 'SYSTEM_STATUS'
  | 'UNKNOWN';

export interface ExtractedEntities {
  username?: string;
  postId?: string;
  signalName?: string;
  timeRange?: 'today' | 'week' | 'yesterday';
  configField?: string;
}

export interface LastEntity {
  type: 'username' | 'postId';
  value: string;
}

export interface IntentScore {
  intent: IntentId;
  score: number;
  entities: ExtractedEntities;
}

interface IntentDefinition {
  id: IntentId;
  strong: string[];
  medium: string[];
  weak: string[];
  requiresEntity?: keyof ExtractedEntities;
}

export const MIN_INTENT_SCORE = 0.15;

const PRONOUNS = /\b(they|their|them|this user|that user|that post|it|the post|the user)\b/i;

const INTENT_DEFINITIONS: IntentDefinition[] = [
  {
    id: 'WHY_FLAGGED_POST',
    strong: ['why flagged', 'why removed', 'why was', 'why did', 'flagged for', 'removed for', 'what signal', 'spam score', 'caught by', 'what triggered'],
    medium: ['flagged', 'removed', 'score', 'signal', 'triggered', 'caught', 'held', 'blocked', 'rejected'],
    weak: ['why', 'post', 'ban'],
    requiresEntity: 'postId',
  },
  {
    id: 'USER_PROFILE',
    strong: ['is a problem', 'trust score', 'bad actor', 'user history', 'tell me about u/', 'check u/', 'look up u/', 'is u/', 'good user', 'reliable user'],
    medium: ['user', 'account', 'trust', 'who is', 'reputation', 'history', 'behaviour', 'behavior', 'violations', 'banned'],
    weak: ['profile', 'score', 'standing', 'check'],
    requiresEntity: 'username',
  },
  {
    id: 'SUGGEST_KEYWORDS',
    strong: ['suggest keywords', 'recommend keywords', 'what keywords', 'keyword suggestions', 'spam words', 'block words', 'words to ban', 'add to spam list'],
    medium: ['keyword', 'spam list', 'ban list', 'block', 'phrase', 'term', 'pattern', 'suggest'],
    weak: ['word', 'text', 'string'],
  },
  {
    id: 'EXPLAIN_CONFIG',
    strong: ['what is my config', 'show config', 'current settings', 'my settings', 'configured as', 'what are my thresholds', 'current thresholds'],
    medium: ['config', 'setting', 'threshold', 'configured', 'setup', 'configured to', 'anti-raid', 'auto-remove', 'auto-flag'],
    weak: ['how', 'what', 'configured', 'set'],
    requiresEntity: 'configField',
  },
  {
    id: 'EXPLAIN_TRUST',
    strong: ['how does trust work', 'explain trust', 'trust system', 'trust tiers', 'how is trust', 'trust score system', 'what is trusted', 'highly trusted'],
    medium: ['trust', 'tier', 'grace', 'untrusted', 'neutral tier', 'trusted tier', 'score system'],
    weak: ['level', 'rank', 'reputation'],
  },
  {
    id: 'WHAT_DO_FIRST',
    strong: ['what should i do', 'new mod', 'getting started', 'first steps', 'how do i start', 'help me set up', 'what to do first', 'priority', 'where do i begin'],
    medium: ['help', 'start', 'first', 'guide', 'setup', 'configure', 'advice', 'suggest', 'recommend'],
    weak: ['new', 'begin', 'initial', 'basics'],
  },
  {
    id: 'RAID_STATUS',
    strong: ['raid mode', 'is raid', 'raid active', 'raid status', 'post spike', 'volume spike', 'influx of posts', 'coordinated', 'under attack'],
    medium: ['raid', 'spike', 'surge', 'influx', 'attack', 'wave', 'volume', 'flood', 'burst'],
    weak: ['posts', 'activity', 'traffic'],
  },
  {
    id: 'STATS_SUMMARY',
    strong: ['how many posts', 'stats today', 'post count', 'removal rate', 'how many removed', 'activity summary', 'today stats', 'daily stats'],
    medium: ['stats', 'numbers', 'count', 'total', 'average', 'summary', 'report', 'metrics'],
    weak: ['today', 'week', 'daily', 'activity'],
    requiresEntity: 'timeRange',
  },
  {
    id: 'PENDING_POSTS',
    strong: ['pending review', 'modqueue', 'posts pending', 'review queue', 'flagged posts', 'awaiting review', 'what needs review'],
    medium: ['pending', 'queue', 'review', 'waiting', 'backlog'],
    weak: ['posts', 'check'],
  },
  {
    id: 'APPEAL_GUIDANCE',
    strong: ['ban appeal', 'handle appeal', 'appeal from', 'should i approve', 'unban', 'lift ban', 'appeal history'],
    medium: ['appeal', 'unban', 'ban', 'dispute', 'reinstate', 'restore'],
    weak: ['banned', 'case', 'decision'],
    requiresEntity: 'username',
  },
  {
    id: 'DRAFT_REMOVAL_PM',
    strong: ['draft removal message', 'removal template', 'write a removal', 'pm template', 'message to send', 'removal reason message'],
    medium: ['draft', 'template', 'write', 'compose', 'removal message', 'removal pm'],
    weak: ['message', 'pm', 'removal'],
    requiresEntity: 'signalName',
  },
  {
    id: 'SYSTEM_STATUS',
    strong: ['system status', 'is everything ok', 'kill switch', 'is subguardian running', 'bot status', 'is automation on', 'current mode'],
    medium: ['status', 'running', 'active', 'working', 'operational', 'health check', 'kill switch', 'automation'],
    weak: ['on', 'off', 'active', 'running'],
  },
];

// ─── Entity Extraction ────────────────────────────────────────────────────────

const USERNAME_RE = /\bu\/([A-Za-z0-9_-]{3,20})\b(?:'s)?|(?:^|\s)user\s+([A-Za-z0-9_-]{3,20})/i;
const POST_ID_RE = /\bt3_([a-z0-9]{4,10})\b|post\s+(?:id\s+)?([a-z0-9]{4,10})\b/i;
const SIGNAL_NAMES = ['title_duplicate', 'selftext_duplicate', 'domain_banned', 'banned_keyword', 'url_in_title', 'high_url_density', 'excessive_caps', 'excessive_punctuation', 'very_new_account'];
const CONFIG_FIELDS = ['threshold', 'keyword', 'anti-raid', 'antiraid', 'flair', 'trust', 'report', 'rate limit', 'ratelimit'];

export function extractEntities(query: string): ExtractedEntities {
  const q = query.toLowerCase();
  const entities: ExtractedEntities = {};

  // Username
  const usernameMatch = USERNAME_RE.exec(query);
  if (usernameMatch) {
    const raw = (usernameMatch[1] ?? usernameMatch[2] ?? '').replace(/'s$/, '');
    if (raw && raw.toLowerCase() !== 'deleted' && raw.toLowerCase() !== 'automoderator' && raw.length >= 3) {
      entities.username = raw;
    }
  }

  // Post ID
  const postMatch = POST_ID_RE.exec(q);
  if (postMatch) {
    entities.postId = postMatch[1] ?? postMatch[2];
  }

  // Time range
  if (/\byesterday\b/.test(q)) entities.timeRange = 'yesterday';
  else if (/\bthis week\b|\blast 7 days?\b|\bweekly\b/.test(q)) entities.timeRange = 'week';
  else if (/\btoday\b|\bright now\b|\bcurrent\b/.test(q)) entities.timeRange = 'today';

  // Signal name
  for (const sig of SIGNAL_NAMES) {
    if (q.includes(sig.replace(/_/g, ' ')) || q.includes(sig)) {
      entities.signalName = sig;
      break;
    }
  }

  // Config field
  for (const field of CONFIG_FIELDS) {
    if (q.includes(field)) {
      entities.configField = field;
      break;
    }
  }

  return entities;
}

// ─── Intent Scoring ───────────────────────────────────────────────────────────

function computeTermScore(query: string, def: IntentDefinition): number {
  let score = 0;

  for (const term of def.strong) {
    if (query.includes(term)) score += 0.4;
  }
  for (const term of def.medium) {
    if (query.includes(term)) score += 0.25;
  }
  for (const term of def.weak) {
    if (query.includes(term)) score += 0.1;
  }

  return Math.min(score, 1.0);
}

export function scoreIntents(query: string, lastEntity: LastEntity | null): IntentScore[] {
  const q = query.toLowerCase();
  let resolvedQuery = q;

  // Pronoun resolution: inject last entity into query
  if (lastEntity && PRONOUNS.test(q) && !USERNAME_RE.test(q) && !POST_ID_RE.test(q)) {
    if (lastEntity.type === 'username') {
      resolvedQuery = q + ` u/${lastEntity.value}`;
    } else {
      resolvedQuery = q + ` post ${lastEntity.value}`;
    }
  }

  const entities = extractEntities(resolvedQuery);

  const scores = INTENT_DEFINITIONS.map((def) => {
    let score = computeTermScore(resolvedQuery, def);

    // Entity bonus: +0.2 if the required entity is present
    if (def.requiresEntity && entities[def.requiresEntity] !== undefined) {
      score = Math.min(score + 0.2, 1.0);
    }

    return { intent: def.id, score, entities };
  });

  return scores.sort((a, b) => b.score - a.score);
}

export function disambiguate(
  scores: IntentScore[],
  entities: ExtractedEntities,
): IntentId {
  const top = scores[0];
  const second = scores[1];

  if (!top || top.score < MIN_INTENT_SCORE) return 'UNKNOWN';

  // If top two are within 0.08, pick by entity match or broader intent
  if (second && top.score - second.score < 0.08) {
    // Prefer the intent whose required entity is present
    const topDef = INTENT_DEFINITIONS.find((d) => d.id === top.intent);
    const secondDef = INTENT_DEFINITIONS.find((d) => d.id === second.intent);
    if (topDef?.requiresEntity && entities[topDef.requiresEntity]) return top.intent;
    if (secondDef?.requiresEntity && entities[secondDef.requiresEntity]) return second.intent;
    // Otherwise pick the one that needs no entity (broader)
    if (!topDef?.requiresEntity) return top.intent;
    if (!secondDef?.requiresEntity) return second.intent;
  }

  return top.intent;
}
