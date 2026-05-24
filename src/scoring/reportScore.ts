import type { ReportEntry, ReportRecord } from '../redis/schema.js';
import { CIB } from '../utils/constants.js';
import { getReportWeight, getTrustTier } from './trustScore.js';

export interface CIBResult {
  isCIB: boolean;
  isBurst: boolean;
  reportCount: number;
}

export function computeWeightedReportCount(reports: ReportEntry[]): number {
  return reports.reduce((sum, r) => {
    const tier = getTrustTier(r.reporterTrust, false);
    return sum + getReportWeight(tier);
  }, 0);
}

// CIB detection uses burst pattern + view/report ratio.
// High report/view ratio = organic community response, not CIB.
// Low ratio + burst = small group coordinating reports on a widely-seen post.
// viewCount=0 (new/test posts): burst alone is sufficient.
export function detectCIB(reports: ReportEntry[], viewCount: number): CIBResult {
  const reportCount = reports.length;
  if (reportCount < CIB.MIN_BURST_COUNT) {
    return { isCIB: false, isBurst: false, reportCount };
  }

  const timestamps = reports.map((r) => r.timestamp).sort((a, b) => a - b);
  const firstTs = timestamps[0] ?? 0;
  const lastTs = timestamps[timestamps.length - 1] ?? 0;
  const isBurst = lastTs - firstTs <= CIB.BURST_WINDOW_MS;

  if (!isBurst) return { isCIB: false, isBurst: false, reportCount };

  // If we have meaningful view data, check organic ratio.
  // A high report/view ratio means most viewers reported it — organic, not CIB.
  if (viewCount > 0) {
    const ratio = reportCount / viewCount;
    if (ratio >= CIB.ORGANIC_REPORT_RATIO) {
      return { isCIB: false, isBurst: true, reportCount };
    }
  }

  return { isCIB: true, isBurst: true, reportCount };
}

export function shouldAutoAction(
  record: ReportRecord,
  autoActionThreshold: number
): boolean {
  return !record.cibFlag && record.weightedCount >= autoActionThreshold;
}

export function checkViewReportRatio(
  viewCount: number,
  reportCount: number,
  threshold: number,
  minViews: number
): boolean {
  if (viewCount < minViews) return false;
  return reportCount / viewCount >= threshold;
}
