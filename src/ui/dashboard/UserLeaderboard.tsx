import { Devvit } from '@devvit/public-api';
import type { TrustTier } from '../../redis/schema.js';

interface LeaderboardEntry {
  userId: string;
  username: string;
  score: number;
  tier: TrustTier;
}


const TIER_BADGE: Record<TrustTier, string> = {
  grace: '🌱',
  untrusted: '🔴',
  low: '🟠',
  neutral: '⚪',
  trusted: '🟢',
  highly_trusted: '⭐',
};

export function UserLeaderboard(entries: LeaderboardEntry[]): JSX.Element {
  return (
    <vstack gap="small" padding="medium">
      <text size="xlarge" weight="bold">Trust Leaderboard</text>
      {entries.length === 0 && (
        <text color="neutral-content-weak">No users tracked yet.</text>
      )}
      {entries.map((entry, i) => (
        <hstack
          key={entry.userId}
          backgroundColor="neutral-background"
          padding="small"
          cornerRadius="small"
          alignment="start middle"
        >
          <text width="32px" color="neutral-content-weak">#{i + 1}</text>
          <text grow>u/{entry.username}</text>
          <text>{TIER_BADGE[entry.tier]}</text>
          <text weight="bold" width="64px" alignment="end middle">
            {entry.score}
          </text>
        </hstack>
      ))}
    </vstack>
  );
}
