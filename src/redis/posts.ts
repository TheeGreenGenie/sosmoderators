import type { RedisClient } from '@devvit/public-api';
import type { SpamScore, ReportRecord, ReportEntry } from './schema.js';
import { Keys, dateKey } from './schema.js';
import { normalizeTitle, extractDomain } from '../utils/regex.js';

// ─── Title / Hash Cache ───────────────────────────────────────────────────────

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export function hashTitle(title: string): string {
  return simpleHash(normalizeTitle(title));
}

export function hashText(text: string): string {
  return simpleHash(text.toLowerCase().trim());
}

const TITLE_CACHE_TTL_DAYS = 30;
const TITLE_CACHE_TTL_MS = TITLE_CACHE_TTL_DAYS * 86_400_000;

export async function isTitleDuplicate(redis: RedisClient, title: string): Promise<boolean> {
  const hash = hashTitle(title);
  const now = Date.now();
  const cutoff = now - TITLE_CACHE_TTL_MS;
  // Remove stale entries before checking
  await redis.zRemRangeByScore(Keys.cacheTitles, 0, cutoff);
  const score = await redis.zScore(Keys.cacheTitles, hash);
  return score !== undefined && score > cutoff;
}

export async function addTitleToCache(redis: RedisClient, title: string): Promise<void> {
  const hash = hashTitle(title);
  await redis.zAdd(Keys.cacheTitles, { score: Date.now(), member: hash });
}

export async function isSelftextDuplicate(redis: RedisClient, text: string): Promise<boolean> {
  if (!text || text.trim().length < 10) return false;
  const hash = hashText(text);
  const now = Date.now();
  const cutoff = now - TITLE_CACHE_TTL_MS;
  await redis.zRemRangeByScore(Keys.cacheSelftextHashes, 0, cutoff);
  const score = await redis.zScore(Keys.cacheSelftextHashes, hash);
  return score !== undefined && score > cutoff;
}

export async function addSelftextToCache(redis: RedisClient, text: string): Promise<void> {
  if (!text || text.trim().length < 10) return;
  const hash = hashText(text);
  await redis.zAdd(Keys.cacheSelftextHashes, { score: Date.now(), member: hash });
}

export async function isDomainBanned(redis: RedisClient, url: string): Promise<boolean> {
  const domain = extractDomain(url);
  if (!domain) return false;
  const val = await redis.hGet(Keys.cacheDomains, domain);
  return val !== undefined && parseInt(val) > 0;
}

export async function incrementDomainBlock(redis: RedisClient, domain: string): Promise<void> {
  const current = await redis.hGet(Keys.cacheDomains, domain);
  const next = (parseInt(current ?? '0') + 1).toString();
  await redis.hSet(Keys.cacheDomains, { [domain]: next });
}

// ─── Spam Scores ─────────────────────────────────────────────────────────────

export async function getSpamScore(redis: RedisClient, postId: string): Promise<SpamScore | null> {
  const raw = await redis.get(Keys.postScore(postId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpamScore;
  } catch {
    return null;
  }
}

export async function setSpamScore(
  redis: RedisClient,
  postId: string,
  score: SpamScore
): Promise<void> {
  await redis.set(Keys.postScore(postId), JSON.stringify(score), {
    expiration: new Date(Date.now() + 7 * 86_400 * 1000),
  });
}

// ─── Report Records ───────────────────────────────────────────────────────────

export async function getReportRecord(
  redis: RedisClient,
  postId: string
): Promise<ReportRecord | null> {
  const raw = await redis.get(Keys.postReports(postId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReportRecord;
  } catch {
    return null;
  }
}

export async function addReport(
  redis: RedisClient,
  postId: string,
  entry: ReportEntry
): Promise<ReportRecord> {
  const existing = await getReportRecord(redis, postId) ?? {
    postId,
    reports: [],
    weightedCount: 0,
    cibFlag: false,
    lastUpdated: Date.now(),
  };
  existing.reports.push(entry);
  existing.lastUpdated = Date.now();
  await redis.set(Keys.postReports(postId), JSON.stringify(existing), {
    expiration: new Date(Date.now() + 90 * 86_400 * 1000),
  });
  return existing;
}

export async function updateReportRecord(
  redis: RedisClient,
  postId: string,
  record: ReportRecord
): Promise<void> {
  await redis.set(Keys.postReports(postId), JSON.stringify(record), {
    expiration: new Date(Date.now() + 90 * 86_400 * 1000),
  });
}

// ─── Daily Post Counter ───────────────────────────────────────────────────────

export async function getPostCountToday(
  redis: RedisClient,
  userId: string
): Promise<number> {
  const key = `${Keys.aggPostsDaily(dateKey())}:user:${userId}`;
  const val = await redis.get(key);
  return parseInt(val ?? '0');
}

export async function incrementPostCountToday(
  redis: RedisClient,
  userId: string
): Promise<void> {
  const key = `${Keys.aggPostsDaily(dateKey())}:user:${userId}`;
  const current = await redis.get(key);
  await redis.set(key, String(parseInt(current ?? '0') + 1), { expiration: new Date(Date.now() + 2 * 86_400 * 1000) });
}
