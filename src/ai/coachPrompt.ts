/**
 * LLM path for SubGuardian Coach.
 * When a key + endpoint are configured, the full CoachContext is serialized
 * into the system prompt and the mod's question is sent as the user message.
 * Falls back to the heuristic path on any error or timeout.
 */

import type { RedisClient } from '@devvit/public-api';
import type { CoachContext } from './coachContext.js';
import type { ExtractedEntities } from '../utils/intentScoring.js';
import {
  computeCoachAnswer,
  computeCoachAnswerFromQuery,
  buildUnknownIntentResponse,
} from './coachHeuristics.js';

const COACH_TIMEOUT_MS = 6_000;

export function buildCoachSystemPrompt(ctx: CoachContext): string {
  // Keep the context compact — only send fields the LLM can act on
  const compactCtx = {
    subredditName: ctx.subredditName,
    preset: ctx.preset,
    killSwitchActive: ctx.killSwitchActive,
    raidModeActive: ctx.raidModeActive,
    lastBuilt: ctx.lastBuilt,
    todayStats: ctx.todayStats,
    weekAvgStats: ctx.weekAvgStats,
    redisUsagePct: ctx.redisUsagePct,
    config: {
      spamDetection: ctx.config.spamDetection,
      antiRaid: ctx.config.antiRaid,
      flairVoting: ctx.config.flairVoting,
      features: ctx.config.features,
      ai: { provider: ctx.config.ai.provider, apiKeyConfigured: ctx.config.ai.apiKeyConfigured },
    },
    recentAuditLog: ctx.auditLog.slice(0, 15).map((e) => ({
      action: e.action,
      targetId: e.targetId,
      actor: e.actor,
      reason: e.reason.slice(0, 120),
      timestamp: new Date(e.timestamp).toUTCString(),
    })),
    topTrustUsers: ctx.topTrustUsers,
    hourlyPostCounts: ctx.hourlyPostCounts,
  };

  return [
    `You are SubGuardian Coach, a moderation co-pilot for r/${ctx.subredditName}.`,
    'Your knowledge is grounded exclusively in the context block below.',
    'Be concise — mods are busy. Max 5 sentences per response unless a list is clearer.',
    'Never fabricate data not present in the context block.',
    'If a question is outside moderation of this subreddit, say so briefly.',
    '',
    '--- SUBREDDIT CONTEXT ---',
    JSON.stringify(compactCtx, null, 2),
    '--- END CONTEXT ---',
  ].join('\n');
}

async function callLLMCoach(
  question: string,
  systemPrompt: string,
  endpoint: string,
  apiKey: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COACH_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        task: 'coach',
        systemPrompt,
        question,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as { answer?: string; response?: string; content?: string };
    return data.answer ?? data.response ?? data.content ?? null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Primary entry point for the Coach tab — handles both LLM and heuristic paths. */
export async function askCoach(
  question: string,
  ctx: CoachContext,
  redis: RedisClient,
  reddit: { getUserByUsername: (name: string) => Promise<{ id: string } | null> } | null,
  lastEntityRaw: string | null,
): Promise<{ answer: string; resolvedEntity: string | null }> {
  const { config } = ctx;

  // LLM path: only if both key and endpoint are configured
  if (config.ai.apiKeyConfigured && config.ai.apiEndpoint && config.ai.apiKey) {
    const systemPrompt = buildCoachSystemPrompt(ctx);
    const llmAnswer = await callLLMCoach(
      question,
      systemPrompt,
      config.ai.apiEndpoint,
      config.ai.apiKey,
    );
    if (llmAnswer) {
      return { answer: llmAnswer, resolvedEntity: null };
    }
    // Fall through to heuristic on LLM failure
  }

  // Heuristic path
  return computeCoachAnswerFromQuery(question, ctx, redis, reddit, lastEntityRaw);
}

/** For chip buttons that hardcode an intent — skips the scoring step. */
export async function askCoachForIntent(
  intentId: import('../utils/intentScoring.js').IntentId,
  entities: ExtractedEntities,
  ctx: CoachContext,
  redis: RedisClient,
  reddit: { getUserByUsername: (name: string) => Promise<{ id: string } | null> } | null,
): Promise<string> {
  try {
    return await computeCoachAnswer(ctx, intentId, entities, redis, reddit);
  } catch {
    return buildUnknownIntentResponse();
  }
}

/** Status string for the Coach tab header. */
export function coachModeLabel(ctx: CoachContext): string {
  if (ctx.config.ai.apiKeyConfigured && ctx.config.ai.apiEndpoint) {
    return 'LLM active — open questions enabled';
  }
  if (ctx.config.ai.apiKeyConfigured) {
    return 'Key set, endpoint missing — heuristic mode (set endpoint in Config UI)';
  }
  return 'Heuristic mode — chips work without LLM key';
}
