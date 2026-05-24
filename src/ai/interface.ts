import type { SubConfig } from '../redis/schema.js';
import { LLMProvider } from './llm.js';

export interface UserHistory {
  trustScore: number;
  removedPosts: number;
  tempBanCount: number;
  permBanHistory: number;
  appealCount: number;
  lastAppealTs: number | null;
}

export interface ContentContext {
  subredditName: string;
  postFlair: string | null;
  isLink: boolean;
  userTrustScore: number;
}

export interface AIAnalysisResult {
  summary: string;
  confidence: number;
  flags: string[];
  suggestedAction: 'approve' | 'flag' | 'remove' | 'none';
  reasoning: string;
}

export interface AIProvider {
  analyzeAppeal(
    appealText: string,
    userHistory: UserHistory
  ): Promise<AIAnalysisResult>;

  analyzeContent(
    content: string,
    context: ContentContext
  ): Promise<AIAnalysisResult>;

  suggestFlair(
    content: string,
    existingFlairs: string[]
  ): Promise<{ suggested: string; confidence: number }>;
}

// LLMProvider is always primary — it falls back to HeuristicProvider internally
// if the API endpoint/key are not configured or the call fails.
export function getAIProvider(config: SubConfig): AIProvider {
  return new LLMProvider(config.ai);
}
