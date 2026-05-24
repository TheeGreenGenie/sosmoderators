import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import { Keys, weekKey } from '../redis/schema.js';
import type { TrustTier } from '../redis/schema.js';

type LeaderboardTab = 'weekly' | 'trust';

const TIER_COLORS: Record<TrustTier, string> = {
  grace: '#888888',
  untrusted: '#ff4444',
  low: '#ffaa00',
  neutral: '#888888',
  trusted: '#0079d3',
  highly_trusted: '#00aa44',
};

const TIER_LABELS: Record<TrustTier, string> = {
  grace: 'New',
  untrusted: 'Untrusted',
  low: 'Low',
  neutral: 'Neutral',
  trusted: 'Trusted',
  highly_trusted: 'Top',
};

export function renderLeaderboardPost(context: Context): JSX.Element {
  const [activeTab, setActiveTab] = context.useState<LeaderboardTab>('weekly');

  const [weeklyEntries] = context.useState(async () => {
    const wk = weekKey();
    const members = await context.redis.zRange(
      Keys.leaderboardContributionsWeekly(wk),
      0, 24,
      { by: 'rank', reverse: true }
    );
    return Promise.all(
      members.map(async (m) => {
        const username = await context.redis.get(Keys.userUsername(m.member));
        return {
          userId: m.member,
          username: username ?? m.member,
          score: Math.round(m.score),
        };
      })
    );
  });

  const [trustEntries] = context.useState(async () => {
    const members = await context.redis.zRange(
      Keys.leaderboardTrust,
      0, 24,
      { by: 'rank', reverse: true }
    );
    return Promise.all(
      members.map(async (m) => {
        const [username, trustRaw] = await Promise.all([
          context.redis.get(Keys.userUsername(m.member)),
          context.redis.get(Keys.userTrust(m.member)),
        ]);
        const trust = trustRaw
          ? (JSON.parse(trustRaw) as { tier: TrustTier })
          : null;
        return {
          userId: m.member,
          username: username ?? m.member,
          score: Math.round(m.score),
          tier: trust?.tier ?? ('neutral' as TrustTier),
        };
      })
    );
  });

  return (
    <vstack height="100%" width="100%" gap="small" padding="small">
      <text size="xlarge" weight="bold">SubGuardian Leaderboard</text>

      <hstack gap="small">
        <button
          size="small"
          appearance={activeTab === 'weekly' ? 'primary' : 'secondary'}
          onPress={() => setActiveTab('weekly')}
        >
          This Week
        </button>
        <button
          size="small"
          appearance={activeTab === 'trust' ? 'primary' : 'secondary'}
          onPress={() => setActiveTab('trust')}
        >
          All-Time Trust
        </button>
      </hstack>

      {activeTab === 'weekly' && (
        <vstack gap="small" grow>
          <text size="small" color="neutral-content-weak">
            Top contributors this week by approved posts, reports, and adopted flairs.
          </text>
          {weeklyEntries.length === 0 && (
            <text color="neutral-content-weak">No contributions recorded yet this week.</text>
          )}
          {weeklyEntries.map((entry, i) => (
            <hstack
              key={entry.userId}
              backgroundColor="neutral-background"
              padding="small"
              cornerRadius="small"
              alignment="start middle"
              gap="small"
            >
              <text size="small" color="neutral-content-weak" width="24px">
                {i + 1}.
              </text>
              <text grow size="small" weight="bold">u/{entry.username}</text>
              <text size="small" color="#0079d3" weight="bold">{entry.score} pts</text>
            </hstack>
          ))}
        </vstack>
      )}

      {activeTab === 'trust' && (
        <vstack gap="small" grow>
          <text size="small" color="neutral-content-weak">
            All-time community trust scores.
          </text>
          {trustEntries.length === 0 && (
            <text color="neutral-content-weak">No trust scores recorded yet.</text>
          )}
          {trustEntries.map((entry, i) => (
            <hstack
              key={entry.userId}
              backgroundColor="neutral-background"
              padding="small"
              cornerRadius="small"
              alignment="start middle"
              gap="small"
            >
              <text size="small" color="neutral-content-weak" width="24px">
                {i + 1}.
              </text>
              <text grow size="small" weight="bold">u/{entry.username}</text>
              <text size="small" color={TIER_COLORS[entry.tier]} weight="bold">
                {TIER_LABELS[entry.tier]}
              </text>
              <text size="small">{entry.score}</text>
            </hstack>
          ))}
        </vstack>
      )}
    </vstack>
  );
}
