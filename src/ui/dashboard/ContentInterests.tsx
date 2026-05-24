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
  const visible = topics
    .filter((t) => !dismissedTopics.includes(t.topic))
    .slice(0, 10);

  return (
    <vstack gap="small" padding="medium">
      <hstack alignment="start middle">
        <text size="xlarge" weight="bold" grow>Top Topics (7d)</text>
        <button size="small" appearance="secondary" onPress={onToggleMinimize}>
          {topicsMinimized ? '▼ Show' : '▲ Hide'}
        </button>
      </hstack>
      {!topicsMinimized && visible.length === 0 && (
        <text color="neutral-content-weak">No topic data yet.</text>
      )}
      {!topicsMinimized && visible.map((t) => (
        <hstack key={t.topic} alignment="start middle" gap="small">
          <text grow>{t.topic}</text>
          <hstack
            backgroundColor="#0079d3"
            height="12px"
            width={`${Math.min(t.count * 4, 200)}px`}
            cornerRadius="small"
          />
          <text width="40px" alignment="end middle" size="small">
            {t.count}
          </text>
          <button size="small" appearance="secondary" onPress={() => onDismiss(t.topic)}>✕</button>
        </hstack>
      ))}

      {flairSuggestions.length > 0 && (
        <vstack gap="small">
          <text size="large" weight="bold">Suggest New Flair</text>
          <text size="small" color="neutral-content-weak">
            These trending topics have no matching flair yet.
          </text>
          {flairSuggestions.map((topic) => (
            <hstack
              key={topic}
              backgroundColor="neutral-background"
              padding="small"
              cornerRadius="small"
              alignment="start middle"
              gap="small"
            >
              <text grow size="small" weight="bold">{topic}</text>
              <button
                size="small"
                appearance="primary"
                onPress={() => onAddFlair(topic)}
              >
                Add Directly
              </button>
              <button
                size="small"
                appearance="secondary"
                onPress={() => onPutToVote(topic)}
              >
                Put to Vote
              </button>
            </hstack>
          ))}
        </vstack>
      )}
    </vstack>
  );
}
