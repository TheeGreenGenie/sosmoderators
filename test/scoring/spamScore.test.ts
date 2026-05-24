import { computeSpamScore, getSpamAction } from '../../src/scoring/spamScore';
import { DEFAULT_CONFIG } from '../../src/redis/config';

const baseInput = {
  title: 'A normal post title',
  selftext: 'Some normal content here.',
  url: null,
  isTitleDuplicate: false,
  isSelftextDuplicate: false,
  isDomainBanned: false,
  userTrustScore: 400,
  accountAgeDays: 180,
};

describe('computeSpamScore', () => {
  it('clean post scores near 0', () => {
    const result = computeSpamScore(baseInput, DEFAULT_CONFIG);
    expect(result.score).toBeLessThan(0.1);
    expect(result.signals).toHaveLength(0);
  });

  it('exact title duplicate scores above autoRemove threshold', () => {
    const result = computeSpamScore(
      { ...baseInput, isTitleDuplicate: true },
      DEFAULT_CONFIG
    );
    expect(result.score).toBeGreaterThan(0.15);
    expect(result.signals).toContain('title_duplicate');
  });

  it('banned keyword triggers the flag', () => {
    const config = {
      ...DEFAULT_CONFIG,
      spamDetection: { ...DEFAULT_CONFIG.spamDetection, bannedKeywords: ['spam_word'] },
    };
    const result = computeSpamScore(
      { ...baseInput, title: 'buy now spam_word cheap' },
      config
    );
    expect(result.signals).toContain('banned_keyword');
  });

  it('banned domain triggers flag', () => {
    const result = computeSpamScore(
      { ...baseInput, isDomainBanned: true },
      DEFAULT_CONFIG
    );
    expect(result.signals).toContain('domain_banned');
  });

  it('highly trusted users get score discount', () => {
    const normalResult = computeSpamScore(
      { ...baseInput, isTitleDuplicate: true, userTrustScore: 300 },
      DEFAULT_CONFIG
    );
    const trustedResult = computeSpamScore(
      { ...baseInput, isTitleDuplicate: true, userTrustScore: 750 },
      DEFAULT_CONFIG
    );
    expect(trustedResult.score).toBeLessThan(normalResult.score);
  });

  it('score stays within 0-1 range even with all signals', () => {
    const result = computeSpamScore(
      {
        ...baseInput,
        isTitleDuplicate: true,
        isSelftextDuplicate: true,
        isDomainBanned: true,
        title: 'BUY NOW BUY NOW BUY NOW',
        accountAgeDays: 1,
      },
      {
        ...DEFAULT_CONFIG,
        spamDetection: { ...DEFAULT_CONFIG.spamDetection, bannedKeywords: ['buy now'] },
      }
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe('getSpamAction', () => {
  it('score >= autoRemoveThreshold returns remove', () => {
    expect(getSpamAction(0.9, DEFAULT_CONFIG, [])).toBe('remove');
  });

  it('score >= autoFlagThreshold returns flag', () => {
    expect(getSpamAction(0.7, DEFAULT_CONFIG, [])).toBe('flag');
  });

  it('score below both thresholds returns approve', () => {
    expect(getSpamAction(0.3, DEFAULT_CONFIG, [])).toBe('approve');
  });

  it('selftext_duplicate always flags regardless of score', () => {
    expect(getSpamAction(0.1, DEFAULT_CONFIG, ['selftext_duplicate'])).toBe('flag');
  });
});
