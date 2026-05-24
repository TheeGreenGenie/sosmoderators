import type { SpamScore } from '../redis/schema.js';
import type { SubConfig } from '../redis/schema.js';
import { extractUrls, countCapsWords } from '../utils/regex.js';

export interface SpamInputData {
  title: string;
  selftext: string;
  url: string | null;
  isTitleDuplicate: boolean;
  isSelftextDuplicate: boolean;
  isDomainBanned: boolean;
  userTrustScore: number;
  accountAgeDays: number;
}

interface ScoringSignal {
  name: string;
  weight: number;
  triggered: boolean;
}

export function computeSpamScore(data: SpamInputData, config: SubConfig): SpamScore {
  const signals: ScoringSignal[] = [];

  signals.push({ name: 'title_duplicate', weight: 0.45, triggered: data.isTitleDuplicate });
  signals.push({ name: 'selftext_duplicate', weight: 0.40, triggered: data.isSelftextDuplicate });
  signals.push({ name: 'domain_banned', weight: 0.55, triggered: data.isDomainBanned });

  // Banned keyword check in title + selftext
  const combined = `${data.title} ${data.selftext}`.toLowerCase();
  const hasBannedKeyword = config.spamDetection.bannedKeywords.some((kw) =>
    combined.includes(kw.toLowerCase())
  );
  signals.push({ name: 'banned_keyword', weight: 0.50, triggered: hasBannedKeyword });

  // URL in title is a strong spam signal
  const hasUrlInTitle = extractUrls(data.title).length > 0;
  signals.push({ name: 'url_in_title', weight: 0.30, triggered: hasUrlInTitle });

  // URL density heuristic: many links in a short post
  const urls = extractUrls(data.selftext);
  const selftextWords = data.selftext.trim().split(/\s+/).length;
  const urlDensityHigh = selftextWords > 0 && urls.length / selftextWords > 0.15;
  signals.push({ name: 'high_url_density', weight: 0.25, triggered: urlDensityHigh });

  // ALL CAPS abuse
  const capsWords = countCapsWords(data.title);
  signals.push({ name: 'excessive_caps', weight: 0.25, triggered: capsWords >= 3 });

  // Excessive punctuation (3+ consecutive ! or ?)
  const excessivePunct = /[!?]{3,}/.test(data.title) || /[!?]{3,}/.test(data.selftext);
  signals.push({ name: 'excessive_punctuation', weight: 0.25, triggered: excessivePunct });

  // Very new account
  signals.push({ name: 'very_new_account', weight: 0.25, triggered: data.accountAgeDays < 7 });

  // Sum triggered weights directly (no normalization) — individual signals are additive
  const triggered = signals.filter((s) => s.triggered);
  const rawScore = triggered.reduce((sum, s) => sum + s.weight, 0);
  let score = Math.min(1, rawScore);

  // Trust discount: highly trusted users get a discount on spam score
  if (data.userTrustScore >= 700) {
    score *= 0.6;
  } else if (data.userTrustScore >= 500) {
    score *= 0.8;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score,
    signals: triggered.map((s) => s.name),
    computedAt: Date.now(),
  };
}

export function getSpamAction(
  score: number,
  config: SubConfig,
  signals: string[] = []
): 'remove' | 'flag' | 'approve' {
  if (score >= config.spamDetection.autoRemoveThreshold) return 'remove';
  // Duplicate body is never approved regardless of score
  if (signals.includes('selftext_duplicate')) return 'flag';
  if (score >= config.spamDetection.autoFlagThreshold) return 'flag';
  return 'approve';
}
