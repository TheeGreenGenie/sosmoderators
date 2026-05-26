import { Devvit } from '@devvit/public-api';

interface TopicEntry {
  topic: string;
  count: number;
}

interface ContentInterestsProps {
  topics: TopicEntry[];
  flairSuggestions: string[];
  dismissedTopics: string[];
  topicsMinimized: boolean;
  onDismiss: (topic: string) => void;
  onToggleMinimize: () => void;
  onAddFlair: (topic: string) => Promise<void>;
  onPutToVote: (topic: string) => Promise<void>;
}

export function ContentInterests({
  topics,
  flairSuggestions,
  dismissedTopics,
  topicsMinimized,
  onDismiss,
  onToggleMinimize,
  onAddFlair,
  onPutToVote,
}: ContentInterestsProps): JSX.Element {
  const visible = topics.filter((t) => !dismissedTopics.includes(t.topic)).slice(0, 8);
  const maxCount = visible.length > 0 ? Math.max(...visible.map((t) => t.count)) : 1;

  return (
    <vstack gap="small" padding="small">

      {/* Topics section header — always visible */}
      <hstack alignment="start middle" gap="small" padding="small" backgroundColor="neutral-background" cornerRadius="medium">
        <text size="medium" weight="bold" grow>Top Topics</text>
        <text size="xsmall" color="neutral-content-weak">7-day  </text>
        <button size="small" appearance={topicsMinimized ? 'primary' : 'secondary'} onPress={onToggleMinimize}>
          {topicsMinimized ? '▼ Show' : '▲ Hide'}
        </button>
      </hstack>

      {/* Topic bars — hidden when minimized */}
      {!topicsMinimized && visible.length === 0 && (
        <vstack
          backgroundColor="neutral-background"
          padding="small"
          cornerRadius="medium"
          alignment="center middle"
        >
          <text size="small" color="neutral-content-weak">No topic data yet — check back after the next aggregate cycle.</text>
        </vstack>
      )}

      {!topicsMinimized && visible.map((t) => {
        const barPx = `${Math.max(8, Math.round((t.count / maxCount) * 140))}px` as `${number}px`;
        return (
          <hstack
            key={t.topic}
            backgroundColor="neutral-background"
            padding="small"
            cornerRadius="medium"
            alignment="start middle"
            gap="small"
          >
            <text grow size="small" weight="bold">{t.topic}</text>
            <hstack
              height="6px"
              width={barPx}
              backgroundColor="#0079d3"
              cornerRadius="full"
            />
            <text size="xsmall" color="neutral-content-weak" minWidth="24px">
              {t.count}
            </text>
            <button size="small" appearance="secondary" onPress={() => onDismiss(t.topic)}>✕</button>
          </hstack>
        );
      })}

      {/* Flair suggestions — always visible */}
      {flairSuggestions.length > 0 && (
        <vstack gap="small">
          <hstack alignment="start middle" padding="small" backgroundColor="neutral-background" cornerRadius="medium">
            <vstack grow gap="small">
              <text size="medium" weight="bold">New Flair Suggestions</text>
              <text size="xsmall" color="neutral-content-weak">Trending topics with no matching flair yet</text>
            </vstack>
          </hstack>

          {flairSuggestions.map((topic) => (
            <hstack
              key={topic}
              backgroundColor="neutral-background"
              padding="small"
              cornerRadius="medium"
              alignment="start middle"
              gap="small"
            >
              <vstack grow gap="small">
                <text size="small" weight="bold">{topic}</text>
                <text size="xsmall" color="neutral-content-weak">Trending this week</text>
              </vstack>
              <button size="small" appearance="secondary" onPress={() => onPutToVote(topic)}>
                Vote
              </button>
              <button size="small" appearance="primary" onPress={() => onAddFlair(topic)}>
                Add
              </button>
            </hstack>
          ))}
        </vstack>
      )}

    </vstack>
  );
}
