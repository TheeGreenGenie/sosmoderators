import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import { CaseFile, type FlaggedPostItem } from './CaseFile.js';

interface TopPost {
  id: string;
  title: string;
  score: number;
  numComments: number;
  flair: string | null;
  url: string;
}

export function PostPerformance(context: Context, posts: TopPost[], flaggedPosts: FlaggedPostItem[]): JSX.Element {
  const [selectedPostId, setSelectedPostId] = context.useState<string | null>(null);
  const selected = flaggedPosts.find((p) => p.id === selectedPostId) ?? null;
  if (selected) return CaseFile(context, selected, () => setSelectedPostId(null));

  return (
    <vstack gap="small" padding="medium">
      {flaggedPosts.length > 0 ? (
        <vstack gap="small">
          <text size="xlarge" weight="bold">Pending Review</text>
          <text size="small" color="neutral-content-weak">
            Flagged posts with case-file context
          </text>
          <vstack gap="small">
            {flaggedPosts.map((p) => (
              <hstack
                key={p.id}
                backgroundColor="neutral-background"
                padding="small"
                cornerRadius="small"
                gap="small"
                alignment="start middle"
              >
                <vstack grow gap="small">
                  <hstack gap="small" alignment="start middle">
                    <text weight="bold" overflow="ellipsis" grow>{p.title}</text>
                    {p.recovery ? <text size="small" color="#ffaa00" weight="bold">Recovery</text> : null}
                  </hstack>
                  <text size="small" color="neutral-content-weak">
                    Score {p.spamScore.toFixed(2)} | {p.signals.join(', ') || 'no signals'}
                  </text>
                </vstack>
                <button size="small" appearance="primary" onPress={() => setSelectedPostId(p.id)}>Open</button>
              </hstack>
            ))}
          </vstack>
        </vstack>
      ) : null}

      {posts.length > 0 ? (
        <vstack gap="small">
          <text size="large" weight="bold">Top Posts This Week</text>
          <vstack gap="small">
            {posts.map((p, i) => (
              <vstack
                key={p.id}
                backgroundColor="neutral-background"
                padding="small"
                cornerRadius="small"
                gap="small"
              >
                <hstack gap="small" alignment="middle">
                  <text size="small" color="neutral-content-weak" minWidth="20px">#{i + 1}</text>
                  <text weight="bold" overflow="ellipsis" grow>{p.title}</text>
                </hstack>
                <hstack gap="medium">
                  <text size="small" color="#ff4500" weight="bold">▲ {p.score}</text>
                  <text size="small" color="neutral-content-weak">💬 {p.numComments}</text>
                  {p.flair ? (
                    <text size="small" color="neutral-content-weak">🏷️ {p.flair}</text>
                  ) : null}
                </hstack>
              </vstack>
            ))}
          </vstack>
        </vstack>
      ) : null}

      {flaggedPosts.length === 0 && posts.length === 0 ? (
        <text color="neutral-content-weak">Nothing to show.</text>
      ) : null}
    </vstack>
  );
}
