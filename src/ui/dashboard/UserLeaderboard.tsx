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

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

function EntryCard(entry: LeaderboardEntry, rank: number): JSX.Element {
  return (
    <hstack
      grow
      backgroundColor="neutral-background"
      padding="small"
      cornerRadius="small"
      alignment="start middle"
      gap="small"
    >
      <text size="xsmall" color="neutral-content-weak" minWidth="20px">
        {MEDAL[rank] ?? `#${rank}`}
      </text>
      <text size="xsmall" grow overflow="ellipsis">u/{entry.username}</text>
      <text size="xsmall">{TIER_BADGE[entry.tier]}</text>
      <text size="xsmall" weight="bold" minWidth="28px" alignment="end middle">{entry.score}</text>
    </hstack>
  );
}

export function UserLeaderboard(entries: LeaderboardEntry[], onRefresh: () => Promise<void>): JSX.Element {
  // Pair entries into 2-column rows: [#1,#2], [#3,#4], …
  const rows: LeaderboardEntry[][] = [];
  for (let i = 0; i < entries.length; i += 2) {
    rows.push(entries.slice(i, i + 2));
  }

  return (
    <vstack gap="small" padding="small">
      <hstack alignment="start middle">
        <text size="medium" weight="bold" grow>Trust Leaderboard</text>
        <button size="small" appearance="secondary" onPress={onRefresh}>Refresh</button>
      </hstack>

      {entries.length === 0 && (
        <text size="small" color="neutral-content-weak">No users tracked yet.</text>
      )}

      {rows.map((pair, ri) => (
        <hstack key={`row-${ri}`} gap="small">
          {pair[0] ? EntryCard(pair[0], ri * 2 + 1) : <vstack grow />}
          {pair[1] ? EntryCard(pair[1], ri * 2 + 2) : <vstack grow />}
        </hstack>
      ))}
    </vstack>
  );
}
