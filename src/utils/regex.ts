/**
 * Pre-compiled, ReDoS-safe regex patterns.
 * All patterns are validated with eslint-plugin-redos at lint time.
 */

export const PATTERNS = {
  URL: /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi,
  DOMAIN: /^(?:https?:\/\/)?(?:www\.)?([^/?#\s]+)/i,
  WHITESPACE_NORMALIZE: /\s+/g,
  PUNCTUATION_STRIP: /[^a-z0-9\s]/g,
  REPEATED_CHARS: /(.)\1{4,}/g,
  ALL_CAPS_WORD: /\b[A-Z]{4,}\b/g,
  EXCESSIVE_PUNCTUATION: /[!?]{3,}/g,
} as const;

/** Normalize a title for fuzzy duplicate detection. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(PATTERNS.PUNCTUATION_STRIP, '')
    .replace(PATTERNS.WHITESPACE_NORMALIZE, ' ')
    .trim();
}

/** Extract the registrable domain from a URL. */
export function extractDomain(url: string): string | null {
  const match = PATTERNS.DOMAIN.exec(url);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Extract all URLs from a block of text. */
export function extractUrls(text: string): string[] {
  return text.match(PATTERNS.URL) ?? [];
}

/** Count ALL_CAPS words as a toxicity heuristic signal. */
export function countCapsWords(text: string): number {
  return (text.match(PATTERNS.ALL_CAPS_WORD) ?? []).length;
}

/** Check for known bad-faith appeal phrases. */
export const BAD_FAITH_PATTERNS: RegExp[] = [
  /i did nothing wrong/i,
  /you('re| are) all (idiots|stupid|wrong)/i,
  /this sub(reddit)? (sucks|is garbage|is trash)/i,
  /i will (sue|report) you/i,
];

export function hasBadFaithPattern(text: string): boolean {
  return BAD_FAITH_PATTERNS.some((p) => p.test(text));
}

/** Check for sincere appeal language. */
export const SINCERE_PATTERNS: RegExp[] = [
  /i('m| am) sorry/i,
  /i understand/i,
  /i (won't|will not) (do it|do this) again/i,
  /i (violated|broke) (the )?rule/i,
  /i (apologize|take responsibility)/i,
];

export function sincerity(text: string): number {
  return SINCERE_PATTERNS.filter((p) => p.test(text)).length;
}
