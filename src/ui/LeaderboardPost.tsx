import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import { Keys, weekKey } from '../redis/schema.js';
import type { TrustTier } from '../redis/schema.js';

type LeaderboardTab = 'weekly' | 'trust';

const TIER_COLOR: Record<TrustTier, string> = {
  grace:        '#888888',
  untrusted:    '#ff4444',
  low:          '#ffaa00',
  neutral:      '#888888',
  trusted:      '#0079d3',
  highly_trusted: '#00aa44',
};

const TIER_LABEL: Record<TrustTier, string> = {
  grace:          'New',
  untrusted:      'Untrusted',
  low:            'Low',
  neutral:        'Neutral',
  trusted:        'Trusted',
  highly_trusted: 'Elite',
};

const RANK_MEDAL = ['🥇', '🥈', '🥉'];

export function renderLeaderboardPost(context: Context): JSX.Element {
  const [activeTab, setActiveTab] = context.useState<LeaderboardTab>('weekly');

  const [weeklyEntries] = context.useState(async () => {
    const wk = weekKey();
    const members = await context.redis.zRange(Keys.leaderboardContributionsWeekly(wk), 0, 24, { by: 'rank', reverse: true });
    return Promise.all(members.map(async (m) => ({
      userId: m.member,
      username: (await context.redis.get(Keys.userUsername(m.member))) ?? m.member,
      score: Math.round(m.score),
    })));
  });

  const [trustEntries] = context.useState(async () => {
    const members = await context.redis.zRange(Keys.leaderboardTrust, 0, 24, { by: 'rank', reverse: true });
    return Promise.all(members.map(async (m) => {
      const [username, trustRaw] = await Promise.all([
        context.redis.get(Keys.userUsername(m.member)),
        context.redis.get(Keys.userTrust(m.member)),
      ]);
      const trust = trustRaw ? (JSON.parse(trustRaw) as { tier: TrustTier }) : null;
      return {
        userId: m.member,
        username: username ?? m.member,
        score: Math.round(m.score),
        tier: trust?.tier ?? ('neutral' as TrustTier),
      };
    }));
  });

  return (
    <vstack height="100%" width="100%" alignment="center top">

      {/* Header */}
      <vstack
        width="100%"
        backgroundColor="#0079d322"
        padding="medium"
        gap="small"
        alignment="center middle"
      >
        <text size="xlarge" weight="bold">🏆 Community Leaderboard</text>
        <text size="small" color="neutral-content-weak" alignment="center middle">
          {activeTab === 'weekly'
            ? 'Top contributors this week by posts, reports & flair votes'
            : 'All-time trust scores across the community'}
        </text>
      </vstack>

      {/* Tab bar */}
      <hstack
        width="100%"
        padding="small"
        gap="small"
        backgroundColor="neutral-background-selected"
      >
        <button
          size="small"
          appearance={activeTab === 'weekly' ? 'primary' : 'secondary'}
          grow
          onPress={() => setActiveTab('weekly')}
        >
          This Week
        </button>
        <button
          size="small"
          appearance={activeTab === 'trust' ? 'primary' : 'secondary'}
          grow
          onPress={() => setActiveTab('trust')}
        >
          All-Time Trust
        </button>
      </hstack>

      {/* Weekly list */}
      {activeTab === 'weekly' && (
        <vstack width="100%" padding="small" gap="small">
          {weeklyEntries.length === 0 ? (
            <vstack width="100%" padding="large" alignment="center middle" gap="small">
              <text size="large">📭</text>
              <text color="neutral-content-weak">No contributions yet this week.</text>
              <text size="small" color="neutral-content-weak">Post, report spam, or vote on flairs to earn points.</text>
            </vstack>
          ) : weeklyEntries.map((entry, i) => (
            <hstack
              key={entry.userId}
              backgroundColor={i === 0 ? '#ffd70022' : 'neutral-background'}
              padding="small"
              cornerRadius="medium"
              alignment="start middle"
              gap="small"
            >
              <text size="medium" width="32px" alignment="center middle">
                {i < 3 ? (RANK_MEDAL[i] ?? String(i + 1)) : String(i + 1)}
              </text>
              <text grow weight={i < 3 ? 'bold' : 'regular'}>
                u/{entry.username}
              </text>
              <vstack
                backgroundColor={i === 0 ? '#ffd700' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : 'neutral-background-selected'}
                padding="small"
                cornerRadius="full"
              >
                <text size="small" weight="bold">
                  {entry.score} pts
                </text>
              </vstack>
            </hstack>
          ))}
        </vstack>
      )}

      {/* Trust list */}
      {activeTab === 'trust' && (
        <vstack width="100%" padding="small" gap="small">
          {trustEntries.length === 0 ? (
            <vstack width="100%" padding="large" alignment="center middle" gap="small">
              <text size="large">📊</text>
              <text color="neutral-content-weak">No trust scores recorded yet.</text>
            </vstack>
          ) : trustEntries.map((entry, i) => (
            <hstack
              key={entry.userId}
              backgroundColor={i === 0 ? '#ffd70022' : 'neutral-background'}
              padding="small"
              cornerRadius="medium"
              alignment="start middle"
              gap="small"
            >
              <text size="medium" width="32px" alignment="center middle">
                {i < 3 ? (RANK_MEDAL[i] ?? String(i + 1)) : String(i + 1)}
              </text>
              <text grow weight={i < 3 ? 'bold' : 'regular'}>
                u/{entry.username}
              </text>
              <vstack
                padding="small"
                cornerRadius="full"
              >
                <text size="small" color={TIER_COLOR[entry.tier]} weight="bold">
                  {TIER_LABEL[entry.tier]}
                </text>
              </vstack>
              <text size="small" weight="bold" color="neutral-content-weak">
                {entry.score}
              </text>
            </hstack>
          ))}
        </vstack>
      )}

      {/* Footer */}
      <vstack width="100%" padding="medium" alignment="center middle">
        <text size="xsmall" color="neutral-content-weak">
          Updated weekly · Powered by SubGuardian
        </text>
      </vstack>

    </vstack>
  );
}
