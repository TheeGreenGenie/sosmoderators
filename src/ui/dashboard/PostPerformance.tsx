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

  // Build row pairs for 2-column grid
  const rows: TopPost[][] = [];
  for (let i = 0; i < posts.length; i += 2) {
    rows.push(posts.slice(i, i + 2));
  }

  return (
    <vstack gap="small" padding="small">
      {flaggedPosts.length > 0 ? (
        <vstack gap="small">
          <text size="large" weight="bold">Pending Review</text>
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
                  <text size="small" weight="bold" overflow="ellipsis" grow>{p.title}</text>
                  {p.recovery ? <text size="xsmall" color="#ffaa00" weight="bold">Recovery</text> : null}
                </hstack>
                <text size="xsmall" color="neutral-content-weak">
                  Score {p.spamScore.toFixed(2)} · {p.signals.join(', ') || 'no signals'}
                </text>
              </vstack>
              <button size="small" appearance="primary" onPress={() => setSelectedPostId(p.id)}>Open</button>
            </hstack>
          ))}
        </vstack>
      ) : null}

      {posts.length > 0 ? (
        <vstack gap="small">
          <hstack alignment="start middle">
            <text size="large" weight="bold" grow>Top Posts This Week</text>
            <text size="xsmall" color="neutral-content-weak">top {posts.length}</text>
          </hstack>
          {rows.map((pair, ri) => (
            <hstack key={`row-${ri}`} gap="small">
              {pair.map((p, ci) => {
                const rank = ri * 2 + ci + 1;
                return (
                  <vstack
                    key={p.id}
                    grow
                    backgroundColor="neutral-background"
                    padding="small"
                    cornerRadius="small"
                    gap="small"
                  >
                    <hstack alignment="start middle" gap="small">
                      <text size="xsmall" color="neutral-content-weak" minWidth="16px">#{rank}</text>
                      <text size="xsmall" weight="bold" overflow="ellipsis" grow>{p.title}</text>
                    </hstack>
                    <hstack gap="small">
                      <text size="xsmall" color="#ff4500" weight="bold">▲ {p.score}</text>
                      <text size="xsmall" color="neutral-content-weak">💬 {p.numComments}</text>
                      {p.flair ? <text size="xsmall" color="neutral-content-weak">🏷️ {p.flair}</text> : null}
                    </hstack>
                  </vstack>
                );
              })}
              {pair.length === 1 && <vstack grow />}
            </hstack>
          ))}
        </vstack>
      ) : null}

      {flaggedPosts.length === 0 && posts.length === 0 ? (
        <vstack alignment="center middle" padding="large">
          <text color="neutral-content-weak">No posts to show yet.</text>
        </vstack>
      ) : null}
    </vstack>
  );
}
