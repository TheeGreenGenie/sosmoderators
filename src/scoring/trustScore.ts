import type { TrustScore, TrustComponents, TrustTier } from '../redis/schema.js';
import { TRUST } from '../utils/constants.js';

export interface TrustInputData {
  accountAgeDays: number;
  subKarma: number;
  totalSubPosts: number;
  approvedSubPosts: number;
  removedPosts: number;
  actionedReportsAgainst: number;
  tempBanCount: number;
  permBanHistory: number;
  awardsReceived: number;
  topPostCount: number;
  helpfulReportCount: number;
  proposedFlairsAdopted?: number;
}

export function computeTrustComponents(data: TrustInputData): TrustComponents {
  const accountAge = Math.min(data.accountAgeDays / 7.5, 150);

  const subKarma = Math.min(Math.log10(Math.max(data.subKarma, 1)) * 40, 120);

  // 15 points per approved post, capped at 150 — gradual accumulation
  const graceBonusActive = data.totalSubPosts < TRUST.GRACE_POST_THRESHOLD;
  const approvalRate = graceBonusActive
    ? Math.max(75, Math.min(data.approvedSubPosts * 15, 150))
    : Math.min(data.approvedSubPosts * 15, 150);

  const positiveSignals = Math.min(
    data.awardsReceived * 10 +
      data.topPostCount * 5 +
      data.helpfulReportCount * 3 +
      (data.proposedFlairsAdopted ?? 0) * 15,
    100
  );

  const penalties = Math.min(
    data.removedPosts * 15 +
      data.actionedReportsAgainst * 20 +
      data.tempBanCount * 75 +
      data.permBanHistory * 300,
    400
  );

  return {
    accountAge,
    subKarma,
    approvalRate,
    positiveSignals,
    penalties,
    graceBonusActive,
  };
}

export function finalTrustScore(components: TrustComponents): number {
  const raw =
    components.accountAge +
    components.subKarma +
    components.approvalRate +
    components.positiveSignals -
    components.penalties;
  return Math.max(TRUST.MIN, Math.min(TRUST.MAX, Math.round(raw)));
}

export function getTrustTier(score: number, inGrace: boolean): TrustTier {
  if (inGrace) return 'grace';
  if (score <= TRUST.TIER_UNTRUSTED_MAX) return 'untrusted';
  if (score <= TRUST.TIER_LOW_MAX) return 'low';
  if (score <= TRUST.TIER_NEUTRAL_MAX) return 'neutral';
  if (score <= TRUST.TIER_TRUSTED_MAX) return 'trusted';
  return 'highly_trusted';
}

export function getReportWeight(tier: TrustTier): number {
  switch (tier) {
    case 'untrusted':
      return 0.25;
    case 'low':
      return 0.5;
    case 'grace':
    case 'neutral':
      return 1.0;
    case 'trusted':
      return 1.5;
    case 'highly_trusted':
      return 2.5;
  }
}

export function buildTrustScore(data: TrustInputData, inGrace: boolean): TrustScore {
  const components = computeTrustComponents(data);
  const score = finalTrustScore(components);
  const tier = getTrustTier(score, inGrace);
  return { score, tier, components, lastUpdated: Date.now() };
}

export function applyDecay(
  current: TrustScore,
  inGrace: boolean
): TrustScore {
  if (inGrace) return current;
  if (current.score <= TRUST.TIER_UNTRUSTED_MAX) return current;

  const decayed = Math.round(current.score * (1 - TRUST.DECAY_RATE));
  const floored =
    current.score >= 500
      ? Math.max(decayed, TRUST.DECAY_FLOOR_TRUSTED)
      : decayed;

  const score = Math.max(TRUST.MIN, floored);
  const tier = getTrustTier(score, false);
  return { ...current, score, tier, lastUpdated: Date.now() };
}
