import type { RedisClient } from '@devvit/public-api';
import { SCHEMA_VERSION } from '../utils/constants.js';
import { Keys } from './schema.js';
import { DEFAULT_CONFIG } from './config.js';

type MigrationFn = (redis: RedisClient) => Promise<void>;

const migrations: Record<number, MigrationFn> = {
  1: migrateV0toV1,
  2: migrateV1toV2,
  3: migrateV2toV3,
};

async function migrateV0toV1(redis: RedisClient): Promise<void> {
  const existing = await redis.get(Keys.subConfig);
  if (!existing) {
    await redis.set(Keys.subConfig, JSON.stringify(DEFAULT_CONFIG));
  }
}

async function migrateV1toV2(redis: RedisClient): Promise<void> {
  // v2: trust score now stores full TrustComponents breakdown
  // Existing trust scores stored as plain numbers are reset to force recompute
  // (no batch scan available in Devvit Redis, so we rely on lazy recompute on next activity)
  await redis.set('migration:v2:note', 'trust scores will recompute lazily on next activity');
}

async function migrateV2toV3(redis: RedisClient): Promise<void> {
  // v3: added appeal_log key per user — no bulk migration needed, keys created on first appeal
  await redis.set('migration:v3:note', 'appeal_log keys created lazily on first appeal');
}

export async function runMigrations(redis: RedisClient): Promise<void> {
  const stored = parseInt((await redis.get(Keys.schemaVersion)) ?? '0');
  for (let v = stored + 1; v <= SCHEMA_VERSION; v++) {
    const fn = migrations[v];
    if (fn) {
      await fn(redis);
    }
    await redis.set(Keys.schemaVersion, String(v));
  }
}
