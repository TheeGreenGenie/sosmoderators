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

export function HealthOverview(data: HealthData): JSX.Element {
  return (
    <vstack gap="medium" padding="medium">
      {data.killSwitchActive && (
        <hstack backgroundColor="#ff4444" padding="small" cornerRadius="medium">
          <text color="white" weight="bold">
            ⛔ EMERGENCY STOP ACTIVE — All automation paused
          </text>
        </hstack>
      )}

      <text size="xlarge" weight="bold">
        Subreddit Health Overview
      </text>
      <text size="small" color="neutral-content-weak">
        Data as of: {data.lastBuilt}
      </text>

      <hstack gap="medium">
        <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" grow>
          <text size="small" color="neutral-content-weak">Posts Today</text>
          <text size="large" weight="bold">{data.todayPosts}</text>
          <text size="small">7d avg: {data.sevenDayAvgPosts}</text>
        </vstack>
        <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" grow>
          <text size="small" color="neutral-content-weak">Removed Today</text>
          <text size="large" weight="bold" color="#ff6b6b">{data.todayRemoved}</text>
          <text size="small">
            {data.todayPosts > 0
              ? `${Math.round((data.todayRemoved / data.todayPosts) * 100)}%`
              : '0%'}{' '}
            removal rate
          </text>
        </vstack>
        <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" grow>
          <text size="small" color="neutral-content-weak">Flagged Today</text>
          <text size="large" weight="bold" color="#ffaa00">{data.todayFlagged}</text>
        </vstack>
      </hstack>

      <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium">
        <hstack alignment="start middle">
          <text size="small" color="neutral-content-weak" grow>Redis Usage</text>
          <text size="small" color={redisColor(data.redisUsagePct)} weight="bold">
            {data.redisUsagePct}% of 500 MB
          </text>
        </hstack>
        <hstack
          backgroundColor={redisColor(data.redisUsagePct)}
          height="8px"
          width={`${data.redisUsagePct}%`}
          cornerRadius="small"
        />
      </vstack>
    </vstack>
  );
}
