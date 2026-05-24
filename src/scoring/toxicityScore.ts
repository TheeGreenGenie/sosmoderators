import { countCapsWords, hasBadFaithPattern, PATTERNS } from '../utils/regex.js';

export interface ToxicityResult {
  score: number;
  signals: string[];
}

/** Heuristic toxicity scorer. Score is 0–1, higher = more toxic. */
export function computeToxicityScore(text: string): ToxicityResult {
  const signals: string[] = [];
  let score = 0;

  const capsWords = countCapsWords(text);
  if (capsWords >= 5) {
    signals.push('excessive_caps');
    score += 0.15;
  }

  if (hasBadFaithPattern(text)) {
    signals.push('bad_faith_language');
    score += 0.3;
  }

  if (PATTERNS.EXCESSIVE_PUNCTUATION.test(text)) {
    signals.push('excessive_punctuation');
    score += 0.1;
  }

  // Slur / keyword heuristic (very basic placeholder — real impl uses configurable list)
  const TOXIC_KEYWORDS = ['idiot', 'stupid', 'moron', 'hate you', 'kill yourself'];
  const lower = text.toLowerCase();
  const hitCount = TOXIC_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  if (hitCount > 0) {
    signals.push('toxic_keywords');
    score += Math.min(hitCount * 0.15, 0.45);
  }

  // Repeated chars as noise signal
  if (PATTERNS.REPEATED_CHARS.test(text)) {
    signals.push('repeated_chars');
    score += 0.05;
  }

  return { score: Math.min(1, score), signals };
}
