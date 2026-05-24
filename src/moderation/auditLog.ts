import type { RedisClient } from '@devvit/public-api';
import type { AuditEntry } from '../redis/schema.js';
import { Keys } from '../redis/schema.js';

const AUDIT_LOG_TTL_MS = 30 * 86_400_000;

export async function logAction(redis: RedisClient, entry: AuditEntry): Promise<void> {
  // Use score=timestamp, member=JSON (append random suffix to guarantee uniqueness)
  const member = JSON.stringify({ ...entry, _u: Math.random().toString(36).slice(2) });
  await redis.zAdd(Keys.auditLog, { score: entry.timestamp, member });
  // Trim entries older than 30 days
  await redis.zRemRangeByScore(Keys.auditLog, 0, Date.now() - AUDIT_LOG_TTL_MS);
}

export async function getAuditLog(
  redis: RedisClient,
  page: number = 0,
  pageSize: number = 25
): Promise<AuditEntry[]> {
  const total = await redis.zCard(Keys.auditLog);
  if (total === 0) return [];
  // Newest first: work from the high end of the rank range
  const endRank = total - 1 - page * pageSize;
  const startRank = Math.max(0, endRank - pageSize + 1);
  if (endRank < 0) return [];
  const raw = await redis.zRange(Keys.auditLog, startRank, endRank, { by: 'rank' });
  return raw
    .reverse()
    .flatMap(({ member }) => {
      try {
        const { _u: _, ...entry } = JSON.parse(member) as AuditEntry & { _u: string };
        return [entry];
      } catch {
        return [];
      }
    });
}

export async function getAuditLogByType(
  redis: RedisClient,
  actionType: string
): Promise<AuditEntry[]> {
  const total = await redis.zCard(Keys.auditLog);
  if (total === 0) return [];
  const raw = await redis.zRange(Keys.auditLog, 0, total - 1, { by: 'rank', reverse: true });
  return raw.flatMap(({ member }) => {
    try {
      const { _u: _, ...entry } = JSON.parse(member) as AuditEntry & { _u: string };
      return entry.action === actionType ? [entry] : [];
    } catch {
      return [];
    }
  });
}
