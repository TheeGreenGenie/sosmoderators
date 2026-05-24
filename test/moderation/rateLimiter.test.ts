import { checkRateLimit, enqueueRetry, drainRetryQueue } from '../../src/moderation/rateLimiter';
import type { RetryItem } from '../../src/moderation/rateLimiter';
import type { RedisClient } from '@devvit/public-api';

// Minimal in-memory Redis mock
function makeRedisMock(): RedisClient {
  const store: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const hashes: Record<string, Record<string, string>> = {};
  return {
    async get(k: string) { return store[k] ?? null; },
    async set(k: string, v: string) { store[k] = v; },
    async del(...keys: string[]) { keys.forEach(k => delete store[k]); },
    async hSet(k: string, fields: Record<string, string>) { hashes[k] = { ...(hashes[k] ?? {}), ...fields }; },
    async hGetAll(k: string) { return hashes[k] ?? {}; },
    async hDel(k: string, fields: string[]) { fields.forEach(f => { if (hashes[k]) delete hashes[k]![f]; }); },
    async lPush(k: string, ...vals: string[]) {
      lists[k] = lists[k] ?? [];
      lists[k]!.unshift(...vals);
      return lists[k]!.length;
    },
    async rPop(k: string) {
      const list = lists[k];
      if (!list || list.length === 0) return null;
      return list.pop() ?? null;
    },
  } as unknown as RedisClient;
}

describe('checkRateLimit', () => {
  it('allows first request', async () => {
    const redis = makeRedisMock() as unknown as import('@devvit/public-api').RedisClient;
    const result = await checkRateLimit(redis, 'removal');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(29);
  });

  it('blocks when counter reaches limit', async () => {
    const redis = makeRedisMock() as unknown as import('@devvit/public-api').RedisClient;
    // Manually set counter to limit
    const now = Date.now();
    const windowMs = 60_000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    await (redis as unknown as { set: (k: string, v: string) => Promise<void> }).set(
      `ratelimit:removal:${windowStart}`,
      '30'
    );
    await (redis as unknown as { set: (k: string, v: string) => Promise<void> }).set(
      `ratelimit:global:${windowStart}`,
      '0'
    );

    const result = await checkRateLimit(redis, 'removal');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe('enqueueRetry + drainRetryQueue', () => {
  it('enqueues and drains a retry item', async () => {
    const redis = makeRedisMock() as unknown as import('@devvit/public-api').RedisClient;
    const item = { action: 'removal' as const, payload: '{}', retries: 0, queuedAt: Date.now() };

    await enqueueRetry(redis, item);

    const handled: RetryItem[] = [];
    // Mock rate limit to allow
    const now = Date.now();
    const windowMs = 60_000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    await (redis as unknown as { set: (k: string, v: string) => Promise<void> }).set(
      `ratelimit:removal:${windowStart}`,
      '0'
    );
    await (redis as unknown as { set: (k: string, v: string) => Promise<void> }).set(
      `ratelimit:global:${windowStart}`,
      '0'
    );

    await drainRetryQueue(redis, async (i) => { handled.push(i); });
    expect(handled).toHaveLength(1);
  });

  it('discards items that exceed RATE_LIMIT_RETRY_MAX', async () => {
    const redis = makeRedisMock() as unknown as import('@devvit/public-api').RedisClient;
    const item = { action: 'removal' as const, payload: '{}', retries: 3, queuedAt: Date.now() };
    await enqueueRetry(redis, item);
    // drainRetryQueue won't see it because enqueueRetry skips retries >= max
    const handled: RetryItem[] = [];
    await drainRetryQueue(redis, async (i) => { handled.push(i); });
    expect(handled).toHaveLength(0);
  });
});
