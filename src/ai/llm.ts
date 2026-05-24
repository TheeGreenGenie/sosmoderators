import type { AIProvider, AIAnalysisResult, UserHistory, ContentContext } from './interface.js';
import type { SubConfig } from '../redis/schema.js';
import { HeuristicProvider } from './heuristic.js';

/**
 * LLMProvider stub — calls an external LLM API and caches results.
 * Redis caching is handled by callers (modmail.ts, postSubmit.ts) — this class
 * is responsible only for making and parsing the API call.
 *
 * Fill in `API_ENDPOINT` and auth when App Review is approved for external HTTP.
 */
export class LLMProvider implements AIProvider {
  private readonly config: SubConfig['ai'];
  private readonly fallback: HeuristicProvider;

  constructor(config: SubConfig['ai']) {
    this.config = config;
    this.fallback = new HeuristicProvider();
  }

  async analyzeAppeal(
    appealText: string,
    userHistory: UserHistory
  ): Promise<AIAnalysisResult> {
    try {
      const result = await this.callAPI({
        task: 'appeal',
        appealText,
        userHistory,
      });
      return result;
    } catch {
      return this.fallback.analyzeAppeal(appealText, userHistory);
    }
  }

  async analyzeContent(
    content: string,
    context: ContentContext
  ): Promise<AIAnalysisResult> {
    try {
      const result = await this.callAPI({ task: 'content', content, context });
      return result;
    } catch {
      return this.fallback.analyzeContent(content, context);
    }
  }

  async suggestFlair(
    content: string,
    existingFlairs: string[]
  ): Promise<{ suggested: string; confidence: number }> {
    try {
      const result = await this.callAPI({ task: 'flair', content, existingFlairs });
      return result as unknown as { suggested: string; confidence: number };
    } catch {
      return this.fallback.suggestFlair(content, existingFlairs);
    }
  }

  private async callAPI(payload: Record<string, unknown>): Promise<AIAnalysisResult> {
    const endpoint = this.config.apiEndpoint;
    const apiKey = this.config.apiKey;
    if (!endpoint) throw new Error('LLM API endpoint not configured');
    if (!apiKey) throw new Error('LLM API key not configured — run: devvit settings set LLM_API_KEY <key>');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }

    return response.json() as Promise<AIAnalysisResult>;
  }
}
