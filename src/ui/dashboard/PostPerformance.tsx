import { Devvit } from '@devvit/public-api';

interface TopPost {
  id: string;
  title: string;
  score: number;
  numComments: number;
  flair: string | null;
  url: string;
}

export function PostPerformance(posts: TopPost[]): JSX.Element {
  return (
    <vstack gap="small" padding="medium">
      <text size="xlarge" weight="bold">Top Posts This Week</text>
      <text size="small" color="neutral-content-weak">
        Most upvoted posts in the last 7 days
      </text>
      {posts.length === 0 ? (
        <text color="neutral-content-weak">No posts this week.</text>
      ) : (
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
      )}
    </vstack>
  );
}
