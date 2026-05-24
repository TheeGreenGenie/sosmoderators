import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import { getTrustScore, getAppealLog, isAppealOnCooldown, appendAppeal } from '../../redis/users.js';
import { getAIProvider } from '../../ai/interface.js';
import { getConfig } from '../../redis/config.js';
import { logAction } from '../../moderation/auditLog.js';
import type { AIAnalysisResult } from '../../ai/interface.js';

// Placeholder values — in production these come from the menu action context
const EXAMPLE_USER_ID = 'example_user';
const EXAMPLE_APPEAL_TEXT = 'I believe my post was removed unfairly. I followed all the rules.';

interface AppealState {
  result: AIAnalysisResult;
  appealCount: number;
  onCooldown: boolean;
}

export function createAppealSummaryView(_outerContext: Context): Devvit.CustomPostComponent {
  return function AppealSummaryView(ctx: Context): JSX.Element {
    const redis = ctx.redis;

    // useState requires JSONValue — serialize the AI result to string
    const [stateJson] = ctx.useState(async () => {
      const config = await getConfig(redis);
      const [trustRecord, appealLog, onCooldown] = await Promise.all([
        getTrustScore(redis, EXAMPLE_USER_ID),
        getAppealLog(redis, EXAMPLE_USER_ID),
        isAppealOnCooldown(redis, EXAMPLE_USER_ID, config.appeals.cooldownDays),
      ]);

      const ai = getAIProvider(config);
      const history = {
        trustScore: trustRecord?.score ?? 300,
        removedPosts: 0,
        tempBanCount: 0,
        permBanHistory: 0,
        appealCount: appealLog.length,
        lastAppealTs: appealLog[0]?.timestamp ?? null,
      };

      const result = await ai.analyzeAppeal(EXAMPLE_APPEAL_TEXT, history);

      await appendAppeal(redis, EXAMPLE_USER_ID, {
        timestamp: Date.now(),
        summary: result.summary,
        outcome: 'pending',
      });

      await logAction(redis, {
        timestamp: Date.now(),
        action: 'appeal_summary_generated',
        targetId: EXAMPLE_USER_ID,
        targetType: 'user',
        actor: 'SubGuardian',
        reason: result.reasoning,
        score: result.confidence,
      });

      return JSON.stringify({ result, appealCount: appealLog.length, onCooldown } satisfies AppealState);
    });

    if (!stateJson) {
      return (
        <vstack alignment="center middle" height="100%">
          <text>Analyzing appeal...</text>
        </vstack>
      );
    }

    const { result, appealCount, onCooldown } = JSON.parse(stateJson) as AppealState;

    const actionColor =
      result.suggestedAction === 'approve'
        ? '#00aa44'
        : result.suggestedAction === 'remove'
        ? '#ff4444'
        : '#ffaa00';

    return (
      <vstack gap="medium" padding="medium">
        <text size="xlarge" weight="bold">Appeal Summary</text>

        {onCooldown && (
          <hstack backgroundColor="#ffaa0033" padding="small" cornerRadius="medium">
            <text color="#ffaa00">
              ⚠️ Appeal #{appealCount + 1} — user has appealed {appealCount} time(s) recently
            </text>
          </hstack>
        )}

        <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
          <text weight="bold">Summary</text>
          <text>{result.summary}</text>
        </vstack>

        {result.flags.length > 0 && (
          <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
            <text weight="bold">Flags</text>
            {result.flags.map((f: string) => (
              <text key={f} color="#ff6b6b">• {f}</text>
            ))}
          </vstack>
        )}

        <hstack alignment="start middle" gap="medium">
          <text weight="bold">Suggested Action:</text>
          <text color={actionColor} weight="bold">
            {result.suggestedAction.toUpperCase()}
          </text>
          <text size="small" color="neutral-content-weak">
            Confidence: {(result.confidence * 100).toFixed(0)}%
          </text>
        </hstack>

        <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
          <text weight="bold" size="small">Reasoning</text>
          <text size="small" color="neutral-content-weak">{result.reasoning}</text>
        </vstack>

        <hstack gap="small">
          <button appearance="primary" grow>Accept Appeal</button>
          <button appearance="destructive" grow>Reject Appeal</button>
        </hstack>
      </vstack>
    );
  };
}
