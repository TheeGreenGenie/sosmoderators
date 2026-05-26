import { Devvit } from '@devvit/public-api';

interface HealthData {
  todayPosts: number;
  todayRemoved: number;
  todayFlagged: number;
  sevenDayAvgPosts: number;
  redisUsagePct: number;
  killSwitchActive: boolean;
  lastBuilt: string;
}

function redisColor(pct: number): string {
  if (pct >= 90) return '#ff4444';
  if (pct >= 80) return '#ffaa00';
  return '#00aa44';
}

function removalColor(rate: number): string {
  if (rate >= 30) return '#ff4444';
  if (rate >= 15) return '#ffaa00';
  return '#00aa44';
}

export function HealthOverview(data: HealthData): JSX.Element {
  const removalRate = data.todayPosts > 0
    ? Math.round((data.todayRemoved / data.todayPosts) * 100)
    : 0;
  const redisBarPx = `${Math.round(Math.min(data.redisUsagePct, 100) * 2.8)}px` as `${number}px`;

  return (
    <vstack gap="medium" padding="medium">

      {/* Kill switch banner */}
      {data.killSwitchActive && (
        <hstack
          backgroundColor="#ff4444"
          padding="medium"
          cornerRadius="medium"
          alignment="center middle"
          gap="small"
        >
          <text color="white" weight="bold">⛔ EMERGENCY STOP — All automation paused</text>
        </hstack>
      )}

      {/* Page title + timestamp */}
      <hstack alignment="start middle">
        <vstack grow gap="small">
          <text size="xlarge" weight="bold">Overview</text>
          <text size="small" color="neutral-content-weak">Last updated: {data.lastBuilt}</text>
        </vstack>
        <vstack
          backgroundColor={data.killSwitchActive ? '#ff444422' : '#00aa4422'}
          padding="small"
          cornerRadius="medium"
          alignment="center middle"
        >
          <text size="small" weight="bold" color={data.killSwitchActive ? '#ff4444' : '#00aa44'}>
            {data.killSwitchActive ? '🔴 Paused' : '🟢 Active'}
          </text>
        </vstack>
      </hstack>

      {/* Stat cards */}
      <hstack gap="small">
        <vstack
          backgroundColor="neutral-background"
          padding="medium"
          cornerRadius="medium"
          grow
          gap="small"
          alignment="center middle"
        >
          <text size="small" color="neutral-content-weak">Posts Today</text>
          <text size="xlarge" weight="bold">{data.todayPosts}</text>
          <text size="xsmall" color="neutral-content-weak">7d avg: {data.sevenDayAvgPosts}</text>
        </vstack>

        <vstack
          backgroundColor="neutral-background"
          padding="medium"
          cornerRadius="medium"
          grow
          gap="small"
          alignment="center middle"
        >
          <text size="small" color="neutral-content-weak">Flagged</text>
          <text size="xlarge" weight="bold" color="#ffaa00">{data.todayFlagged}</text>
          <text size="xsmall" color="neutral-content-weak">awaiting review</text>
        </vstack>

        <vstack
          backgroundColor="neutral-background"
          padding="medium"
          cornerRadius="medium"
          grow
          gap="small"
          alignment="center middle"
        >
          <text size="small" color="neutral-content-weak">Removed</text>
          <text size="xlarge" weight="bold" color="#ff6b6b">{data.todayRemoved}</text>
          <text size="xsmall" color={removalColor(removalRate)} weight="bold">
            {removalRate}% rate
          </text>
        </vstack>
      </hstack>

      {/* Redis usage */}
      <vstack
        backgroundColor="neutral-background"
        padding="medium"
        cornerRadius="medium"
        gap="small"
      >
        <hstack alignment="start middle">
          <text size="small" color="neutral-content-weak" grow>Redis Storage</text>
          <text size="small" color={redisColor(data.redisUsagePct)} weight="bold">
            {data.redisUsagePct}% of 500 MB
          </text>
        </hstack>
        <hstack
          width="100%"
          height="8px"
          backgroundColor="neutral-background-selected"
          cornerRadius="full"
        >
          {data.redisUsagePct > 0 && (
            <hstack
              height="8px"
              width={redisBarPx}
              backgroundColor={redisColor(data.redisUsagePct)}
              cornerRadius="full"
            />
          )}
        </hstack>
      </vstack>

    </vstack>
  );
}
