import { isDuplicate } from '../../src/utils/dedup';

function makeRedisMock() {
  const store: Record<string, { value: string; expiresAt?: number }> = {};
  return {
    async get(k: string): Promise<string | null> {
      const entry = store[k];
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        delete store[k];
        return null;
      }
      return entry.value;
    },
    async set(k: string, v: string, opts?: { expireIn?: number }): Promise<void> {
      store[k] = {
        value: v,
        expiresAt: opts?.expireIn ? Date.now() + opts.expireIn * 1000 : undefined,
      };
    },
    async del(k: string): Promise<void> {
      delete store[k];
    },
  };
}

describe('isDuplicate', () => {
  it('returns false for a new event and sets the dedup key', async () => {
    const redis = makeRedisMock() as unknown as import('@devvit/public-api').RedisClient;
    const result = await isDuplicate(redis, 'event-abc');
    expect(result).toBe(false);
  });

  it('returns true for the same event called again within TTL', async () => {
    const redis = makeRedisMock() as unknown as import('@devvit/public-api').RedisClient;
    await isDuplicate(redis, 'event-xyz');
    const result = await isDuplicate(redis, 'event-xyz');
    expect(result).toBe(true);
  });

  it('different event IDs are independent', async () => {
    const redis = makeRedisMock() as unknown as import('@devvit/public-api').RedisClient;
    await isDuplicate(redis, 'event-1');
    const result = await isDuplicate(redis, 'event-2');
    expect(result).toBe(false);
  });

  it('returns false after TTL expires', async () => {
    const redis = makeRedisMock() as unknown as import('@devvit/public-api').RedisClient;
    await isDuplicate(redis, 'event-ttl');

    // Simulate TTL expiry by manipulating internal store via the mock
    const internal = redis as unknown as ReturnType<typeof makeRedisMock>;
    // Override with expired entry
    await internal.set('dedup:trigger:event-ttl', '1', { expireIn: -1 });

    const result = await isDuplicate(redis, 'event-ttl');
    expect(result).toBe(false);
  });
});
