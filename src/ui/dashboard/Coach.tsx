import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import { buildCoachContext } from '../../ai/coachContext.js';
import { askCoach, askCoachForIntent, coachModeLabel } from '../../ai/coachPrompt.js';
import { Keys } from '../../redis/schema.js';
import type { CoachHistoryMessage } from '../../redis/schema.js';
import { logAction } from '../../moderation/auditLog.js';

const CHIP_LAST_ENTITY_TTL = 600; // 10 minutes in seconds

interface ChipDef {
  label: string;
  intent: import('../../utils/intentScoring.js').IntentId;
}

const CHIPS: ChipDef[] = [
  { label: 'Stats today', intent: 'STATS_SUMMARY' },
  { label: 'System status', intent: 'SYSTEM_STATUS' },
  { label: 'Explain trust', intent: 'EXPLAIN_TRUST' },
  { label: 'New mod guide', intent: 'WHAT_DO_FIRST' },
  { label: 'Suggest keywords', intent: 'SUGGEST_KEYWORDS' },
  { label: 'Last flagged post', intent: 'WHY_FLAGGED_POST' },
];

// ─── Section parsing ──────────────────────────────────────────────────────────

interface Section {
  header: string;    // first line — always shown
  body: string;      // remaining lines — shown/hidden via toggle
  collapsible: boolean;
}

/**
 * Splits a Coach answer string into display sections.
 * Responses use blank lines (\n\n) as natural section dividers.
 * A section is collapsible when its first line is a non-indented heading
 * with body lines following it (e.g. "Trust is built by:\n  ...").
 */
function parseSections(text: string): Section[] {
  return text
    .split('\n\n')
    .filter((s) => s.trim().length > 0)
    .map((s): Section => {
      const lines = s.split('\n');
      const firstLine = lines[0] ?? '';
      const bodyLines = lines.slice(1);
      const hasBody = bodyLines.some((l) => l.trim().length > 0);
      const firstIsIndented = firstLine.startsWith(' ') || firstLine.startsWith('\t');

      // Only collapsible when there's a clear non-indented heading with body content
      if (!firstIsIndented && hasBody) {
        return {
          header: firstLine,
          body: bodyLines.join('\n'),
          collapsible: true,
        };
      }

      // Everything else: show the whole block as plain text, no toggle
      return { header: s, body: '', collapsible: false };
    });
}

// ─── Section renderer (defined outside component — no Devvit hooks used) ──────

function renderSection(
  section: Section,
  index: number,
  isCollapsed: boolean,
  onToggle: () => void,
): JSX.Element {
  if (!section.collapsible) {
    return (
      <vstack key={String(index)}>
        <text
          size="small"
          wrap
          color={
            section.header.startsWith('⚠') ? '#ffaa00' :
            section.header.startsWith('✓') ? '#00aa44' :
            undefined
          }
        >
          {section.header}
        </text>
      </vstack>
    );
  }

  return (
    <vstack key={String(index)} gap="small">
      <hstack
        backgroundColor="neutral-background-selected"
        padding="small"
        cornerRadius="small"
        alignment="start middle"
        gap="small"
      >
        <text size="small" weight="bold" wrap grow>{section.header}</text>
        <button size="small" appearance="secondary" onPress={onToggle}>
          {isCollapsed ? '+' : '−'}
        </button>
      </hstack>
      {!isCollapsed && (
        <vstack backgroundColor="neutral-background" padding="small" cornerRadius="small">
          <text size="small" wrap>{section.body}</text>
        </vstack>
      )}
    </vstack>
  );
}

// ─── Coach tab component ──────────────────────────────────────────────────────

export function CoachTab(context: Context): JSX.Element {
  const [answer, setAnswer] = context.useState<string>('');
  const [isLoading, setIsLoading] = context.useState<boolean>(false);
  const [modeLabel, setModeLabel] = context.useState<string>('');
  // Tracks which section indices are currently collapsed (default: all expanded)
  const [collapsedSections, setCollapsedSections] = context.useState<number[]>([]);

  const [initialMode] = context.useState(async () => {
    const ctx = await buildCoachContext(context.redis, context.subredditName ?? '');
    return coachModeLabel(ctx);
  });

  const displayMode = modeLabel || initialMode;

  function makeRedditAdapter() {
    return {
      getUserByUsername: async (name: string) => {
        try {
          const user = await context.reddit.getUserByUsername(name);
          return user ? { id: user.id } : null;
        } catch {
          return null;
        }
      },
    };
  }

  function setNewAnswer(text: string): void {
    setAnswer(text);
    setCollapsedSections([]); // reset: all sections expanded for every new answer
  }

  async function reserveCoachTurn(userId: string): Promise<boolean> {
    const locked = await context.redis.set(Keys.coachRateLimit(userId), '1', {
      nx: true,
      expiration: new Date(Date.now() + 5_000),
    });
    if (!locked) {
      context.ui.showToast('Coach is rate limited: wait 5 seconds between questions.');
      return false;
    }
    return true;
  }

  async function appendHistory(userId: string, question: string, response: string): Promise<void> {
    const key = Keys.coachHistory(userId);
    const raw = await context.redis.get(key);
    const current: CoachHistoryMessage[] = raw ? (JSON.parse(raw) as CoachHistoryMessage[]) : [];
    const next: CoachHistoryMessage[] = [
      { role: 'user' as const, text: question.slice(0, 500), timestamp: Date.now() },
      { role: 'coach' as const, text: response.slice(0, 1500), timestamp: Date.now() },
      ...current,
    ].slice(0, 50);
    await context.redis.set(key, JSON.stringify(next), {
      expiration: new Date(Date.now() + 7 * 86_400_000),
    });
  }

  function toggleSection(index: number): void {
    setCollapsedSections(
      collapsedSections.includes(index)
        ? collapsedSections.filter((n) => n !== index)
        : [...collapsedSections, index],
    );
  }

  async function handleChip(intent: import('../../utils/intentScoring.js').IntentId): Promise<void> {
    if (isLoading) return;
    const userId = context.userId ?? 'anon';
    if (!(await reserveCoachTurn(userId))) return;
    setIsLoading(true);
    context.ui.showToast('Coach is checking subreddit context...');
    try {
      const ctx = await buildCoachContext(context.redis, context.subredditName ?? '');
      const result = await askCoachForIntent(intent, {}, ctx, context.redis, makeRedditAdapter());
      setNewAnswer(result);
      setModeLabel(coachModeLabel(ctx));
      await appendHistory(userId, `[chip:${intent}]`, result);
      await logAction(context.redis, {
        timestamp: Date.now(),
        action: 'coach_query',
        targetId: userId,
        targetType: 'user',
        actor: userId,
        reason: `[chip:${intent}]`,
      });
    } catch (err) {
      setNewAnswer('Something went wrong. Please try again.\n' + (err instanceof Error ? err.message : ''));
    }
    setIsLoading(false);
  }

  async function handleQuestion(question: string): Promise<void> {
    if (!question.trim() || isLoading) return;
    const userId = context.userId ?? 'anon';
    if (!(await reserveCoachTurn(userId))) return;
    setIsLoading(true);
    context.ui.showToast('Coach is checking subreddit context...');
    try {
      const lastEntityRaw = (await context.redis.get(Keys.coachLastEntity(userId))) ?? null;
      const ctx = await buildCoachContext(context.redis, context.subredditName ?? '');

      const { answer: result, resolvedEntity } = await askCoach(
        question,
        ctx,
        context.redis,
        makeRedditAdapter(),
        lastEntityRaw,
      );

      if (resolvedEntity) {
        await context.redis.set(Keys.coachLastEntity(userId), resolvedEntity, {
          expiration: new Date(Date.now() + CHIP_LAST_ENTITY_TTL * 1000),
        });
      }

      setNewAnswer(result);
      setModeLabel(coachModeLabel(ctx));
      await appendHistory(userId, question, result);
      await logAction(context.redis, {
        timestamp: Date.now(),
        action: 'coach_query',
        targetId: userId,
        targetType: 'user',
        actor: userId,
        reason: question.slice(0, 100),
      });
    } catch (err) {
      setNewAnswer('Something went wrong. Please try again.\n' + (err instanceof Error ? err.message : ''));
    }
    setIsLoading(false);
  }

  const coachForm = context.useForm(
    {
      title: 'Ask SubGuardian Coach',
      fields: [{ type: 'string', name: 'question', label: 'What would you like to know?', required: true }],
      acceptLabel: 'Ask',
      cancelLabel: 'Cancel',
    },
    async (values) => {
      const question = (values['question'] as string | undefined)?.trim() ?? '';
      await handleQuestion(question);
    },
  );

  const sections = parseSections(answer);
  const row1 = CHIPS.slice(0, 3);
  const row2 = CHIPS.slice(3);

  return (
    <vstack height="100%" width="100%" gap="small" padding="small">

      {/* Header */}
      <hstack alignment="start middle" gap="small">
        <text size="large" weight="bold" grow>SubGuardian Coach</text>
        <text size="xsmall" color="neutral-content-weak">
          {isLoading ? 'Thinking...' : displayMode}
        </text>
      </hstack>

      {/* Chip row 1 */}
      <hstack gap="small">
        {row1.map((chip) => (
          <button
            key={chip.intent}
            size="small"
            appearance="secondary"
            disabled={isLoading}
            onPress={() => handleChip(chip.intent)}
            grow
          >
            {chip.label}
          </button>
        ))}
      </hstack>

      {/* Chip row 2 */}
      <hstack gap="small">
        {row2.map((chip) => (
          <button
            key={chip.intent}
            size="small"
            appearance="secondary"
            disabled={isLoading}
            onPress={() => handleChip(chip.intent)}
            grow
          >
            {chip.label}
          </button>
        ))}
      </hstack>

      {/* Answer area — sections */}
      <vstack grow gap="small" padding="small" backgroundColor="neutral-background" cornerRadius="medium">
        {sections.length === 0 ? (
          <vstack height="100%" alignment="center middle">
            <text size="small" color="neutral-content-weak">
              {isLoading ? 'Coach is thinking...' : 'Tap a chip above or ask a custom question.'}
            </text>
          </vstack>
        ) : (
          sections.map((section, i) =>
            renderSection(section, i, collapsedSections.includes(i), () => toggleSection(i)),
          )
        )}
      </vstack>

      {/* Ask button */}
      <button
        appearance="primary"
        disabled={isLoading}
        onPress={() => context.ui.showForm(coachForm)}
      >
        {isLoading ? 'Thinking...' : 'Ask a question...'}
      </button>

    </vstack>
  );
}
