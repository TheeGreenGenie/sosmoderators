import {
  computeTrustComponents,
  finalTrustScore,
  getTrustTier,
  buildTrustScore,
  applyDecay,
  type TrustInputData,
} from '../../src/scoring/trustScore';

const newUser: TrustInputData = {
  accountAgeDays: 0,
  subKarma: 0,
  totalSubPosts: 0,
  approvedSubPosts: 0,
  removedPosts: 0,
  actionedReportsAgainst: 0,
  tempBanCount: 0,
  permBanHistory: 0,
  awardsReceived: 0,
  topPostCount: 0,
  helpfulReportCount: 0,
};

const veteranUser: TrustInputData = {
  accountAgeDays: 365 * 3, // 3 years
  subKarma: 5000,
  totalSubPosts: 100,
  approvedSubPosts: 98,
  removedPosts: 2,
  actionedReportsAgainst: 0,
  tempBanCount: 0,
  permBanHistory: 0,
  awardsReceived: 10,
  topPostCount: 15,
  helpfulReportCount: 8,
};

describe('computeTrustComponents', () => {
  it('new user has grace bonus active', () => {
    const c = computeTrustComponents(newUser);
    expect(c.graceBonusActive).toBe(true);
  });

  it('new user gets neutral approval rate (75) in grace', () => {
    const c = computeTrustComponents(newUser);
    expect(c.approvalRate).toBe(75);
  });

  it('account at cap age (1125 days) hits accountAge max of 150', () => {
    const c = computeTrustComponents({ ...veteranUser, accountAgeDays: 1125 });
    expect(c.accountAge).toBe(150);
  });

  it('high karma is capped at subKarma max of 120', () => {
    const c = computeTrustComponents(veteranUser);
    expect(c.subKarma).toBe(120);
    expect(c.subKarma).toBeLessThanOrEqual(120);
  });

  it('penalties cap at 400', () => {
    const badActor: TrustInputData = {
      ...newUser,
      removedPosts: 50,
      actionedReportsAgainst: 20,
      tempBanCount: 5,
      permBanHistory: 1,
    };
    const c = computeTrustComponents(badActor);
    expect(c.penalties).toBe(400);
  });

  it('positive signals cap at 100', () => {
    const prolific: TrustInputData = {
      ...veteranUser,
      awardsReceived: 100,
      topPostCount: 100,
      helpfulReportCount: 100,
    };
    const c = computeTrustComponents(prolific);
    expect(c.positiveSignals).toBe(100);
  });
});

describe('finalTrustScore', () => {
  it('clamps to 0 minimum', () => {
    const c = computeTrustComponents({
      ...newUser,
      permBanHistory: 5,
    });
    const score = finalTrustScore(c);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('clamps to 1000 maximum', () => {
    const c = computeTrustComponents(veteranUser);
    const score = finalTrustScore(c);
    expect(score).toBeLessThanOrEqual(1000);
  });

  it('veteran user scores >= 450 (neutral to trusted range)', () => {
    const c = computeTrustComponents(veteranUser);
    const score = finalTrustScore(c);
    expect(score).toBeGreaterThanOrEqual(450);
  });
});

describe('getTrustTier', () => {
  it('grace in-progress returns grace tier', () => {
    expect(getTrustTier(500, true)).toBe('grace');
  });

  it('score 0 returns untrusted', () => {
    expect(getTrustTier(0, false)).toBe('untrusted');
  });

  it('score 149 returns untrusted', () => {
    expect(getTrustTier(149, false)).toBe('untrusted');
  });

  it('score 150 returns low', () => {
    expect(getTrustTier(150, false)).toBe('low');
  });

  it('score 500 returns trusted', () => {
    expect(getTrustTier(500, false)).toBe('trusted');
  });

  it('score 700 returns highly_trusted', () => {
    expect(getTrustTier(700, false)).toBe('highly_trusted');
  });
});

describe('applyDecay', () => {
  it('grace users are immune to decay', () => {
    const trust = buildTrustScore({ ...veteranUser, totalSubPosts: 3 }, true);
    const decayed = applyDecay(trust, true);
    expect(decayed.score).toBe(trust.score);
  });

  it('untrusted users (score <= 149) do not decay further', () => {
    const trust = buildTrustScore({ ...newUser, permBanHistory: 1 }, false);
    expect(trust.score).toBeLessThanOrEqual(149);
    const decayed = applyDecay(trust, false);
    expect(decayed.score).toBe(trust.score);
  });

  it('veteran user decays and bottoms out above TRUST.MIN when decay halts at untrusted threshold', () => {
    const trust = buildTrustScore(veteranUser, false);
    expect(trust.score).toBeGreaterThanOrEqual(450);

    // Apply many rounds of decay — halts once score <= TIER_UNTRUSTED_MAX (149)
    let current = trust;
    for (let i = 0; i < 50; i++) {
      current = applyDecay(current, false);
    }
    expect(current.score).toBeGreaterThanOrEqual(100);
  });

  it('5% decay applied correctly', () => {
    const trust = buildTrustScore({ ...veteranUser, totalSubPosts: 10 }, false);
    const before = trust.score;
    const decayed = applyDecay(trust, false);
    const expected = Math.round(before * 0.95);
    expect(decayed.score).toBeCloseTo(expected, -1);
  });
});
