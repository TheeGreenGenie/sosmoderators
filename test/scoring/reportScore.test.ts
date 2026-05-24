import {
  detectCIB,
  computeWeightedReportCount,
  shouldAutoAction,
  checkViewReportRatio,
} from '../../src/scoring/reportScore';
import type { ReportEntry, ReportRecord } from '../../src/redis/schema';
import { CIB } from '../../src/utils/constants';

function makeReport(
  reporterTrust: number,
  timestamp: number = Date.now(),
  reporterId: string = 'user1'
): ReportEntry {
  return { reporterId, reporterTrust, reason: 'test', timestamp };
}

describe('detectCIB', () => {
  it('detects CIB: majority low-trust, new accounts, burst window', () => {
    const now = Date.now();
    const reports = Array.from({ length: 10 }, (_, i) =>
      makeReport(100, now + i * 30_000, `user${i}`)
    );
    // 80% low-trust, all new accounts, all within 5 min
    const accountAges = reports.map(() => 10);
    const result = detectCIB(reports, accountAges);
    expect(result.isCIB).toBe(true);
    expect(result.isBurst).toBe(true);
  });

  it('does not flag legitimate mixed-trust pile-on spread over 2 hours', () => {
    const baseTs = Date.now() - 2 * 3600_000;
    const reports: ReportEntry[] = [
      makeReport(600, baseTs, 'u1'),
      makeReport(500, baseTs + 3600_000, 'u2'),
      makeReport(400, baseTs + 5400_000, 'u3'),
      makeReport(350, baseTs + 7200_000, 'u4'),
    ];
    const accountAges = [365, 200, 90, 120];
    const result = detectCIB(reports, accountAges);
    expect(result.isCIB).toBe(false);
    expect(result.isBurst).toBe(false);
  });

  it('returns isCIB: false for empty reports', () => {
    const result = detectCIB([], []);
    expect(result.isCIB).toBe(false);
    expect(result.reportCount).toBe(0);
  });

  it('burst window detection uses CIB.BURST_WINDOW_MS', () => {
    const now = Date.now();
    const justOutside = now + CIB.BURST_WINDOW_MS + 1;
    const reports = [makeReport(100, now), makeReport(100, justOutside)];
    const result = detectCIB(reports, [10, 10]);
    expect(result.isBurst).toBe(false);
  });
});

describe('computeWeightedReportCount', () => {
  it('highly trusted reporters weight at 2.5x', () => {
    const reports = [makeReport(800)];
    expect(computeWeightedReportCount(reports)).toBe(2.5);
  });

  it('untrusted reporters weight at 0.25x', () => {
    const reports = [makeReport(50)];
    expect(computeWeightedReportCount(reports)).toBe(0.25);
  });

  it('sums weights across multiple reporters', () => {
    const reports = [makeReport(800), makeReport(800)];
    expect(computeWeightedReportCount(reports)).toBe(5.0);
  });
});

describe('shouldAutoAction', () => {
  function makeRecord(weighted: number, cib: boolean): ReportRecord {
    return {
      postId: 'p1',
      reports: [],
      weightedCount: weighted,
      cibFlag: cib,
      lastUpdated: Date.now(),
    };
  }

  it('actions when weighted count meets threshold and no CIB', () => {
    expect(shouldAutoAction(makeRecord(5, false), 5)).toBe(true);
  });

  it('does not action when CIB flag is set even if threshold met', () => {
    expect(shouldAutoAction(makeRecord(10, true), 5)).toBe(false);
  });

  it('does not action below threshold', () => {
    expect(shouldAutoAction(makeRecord(3, false), 5)).toBe(false);
  });
});

describe('checkViewReportRatio', () => {
  it('returns true when ratio exceeds threshold with sufficient views', () => {
    expect(checkViewReportRatio(1000, 300, 0.2, 100)).toBe(true);
  });

  it('returns false when below minimum view count', () => {
    expect(checkViewReportRatio(50, 20, 0.2, 100)).toBe(false);
  });

  it('returns false when ratio below threshold', () => {
    expect(checkViewReportRatio(1000, 10, 0.2, 100)).toBe(false);
  });
});
