import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import { HealthOverview } from './dashboard/HealthOverview.js';
import { UserLeaderboard } from './dashboard/UserLeaderboard.js';
import { ContentInterests } from './dashboard/ContentInterests.js';
import { PostPerformance } from './dashboard/PostPerformance.js';
import { CoachTab } from './dashboard/Coach.js';
import type { FlaggedPostItem } from './dashboard/CaseFile.js';
import { renderFlairVotePost } from './FlairVotePost.js';
import { renderLeaderboardPost } from './LeaderboardPost.js';
import { Keys, weekKey } from '../redis/schema.js';
import type { FlairProposal } from '../redis/schema.js';
import { getConfig, setConfig, setPreset, type PresetName } from '../redis/config.js';
import type { SubConfig } from '../redis/schema.js';
import { activateKillSwitch, deactivateKillSwitch, isKillSwitchActive } from '../moderation/killSwitch.js';
import { logAction } from '../moderation/auditLog.js';

type AppView = 'dashboard' | 'config' | 'onboarding' | 'vote' | 'leaderboard';
type DashboardTab = 'health' | 'topics' | 'leaderboard' | 'posts' | 'coach';
type ConfigTab = 'presets' | 'features' | 'thresholds' | 'danger';

// ─── Unified Router ──────────────────────────────────────────────────────────

export function renderApp(context: Context): JSX.Element {
  const view = (context.postData?.['view'] as AppView | undefined) ?? 'dashboard';
  if (view === 'config') return renderConfig(context);
  if (view === 'onboarding') return renderOnboarding(context);
  if (view === 'vote') return renderFlairVotePost(context);
  if (view === 'leaderboard') return renderLeaderboardPost(context);
  return renderDashboard(context);
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function renderDashboard(context: Context): JSX.Element {
  const [activeTab, setActiveTab] = context.useState<DashboardTab>('health');

  const [health] = context.useState(async () => {
    const redis = context.redis;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const aggKey = Keys.aggPostsDaily(today);
    const [total, removed, flagged, avgTotal, lastBuilt] = await Promise.all([
      redis.hGet(aggKey, 'total'),
      redis.hGet(aggKey, 'removed'),
      redis.hGet(aggKey, 'flagged'),
      redis.hGet('agg:posts:7d_avg', 'total'),
      redis.get('agg:last_built'),
    ]);
    return {
      todayPosts: parseInt(total ?? '0'),
      todayRemoved: parseInt(removed ?? '0'),
      todayFlagged: parseInt(flagged ?? '0'),
      sevenDayAvgPosts: parseInt(avgTotal ?? '0'),
      redisUsagePct: 0,
      killSwitchActive: false,
      lastBuilt: lastBuilt ? new Date(parseInt(lastBuilt)).toUTCString() : 'Never',
    };
  });

  const [topicsData] = context.useState(async () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const [members, cfg] = await Promise.all([
      context.redis.zRange(Keys.aggTopics(today), 0, 19, { by: 'rank', reverse: true }),
      getConfig(context.redis),
    ]);
    const topics = members.map((m) => ({ topic: m.member, count: Math.round(m.score) }));
    const flairSuggestions = topics
      .map((t) => t.topic)
      .filter((t) => !cfg.flairList.some((f) => f.toLowerCase() === t.toLowerCase()))
      .slice(0, 5);
    return { topics, flairSuggestions };
  });

  const [dismissedTopics, setDismissedTopics] = context.useState<string[]>(() => []);
  const [topicsMinimized, setTopicsMinimized] = context.useState<boolean>(() => false);

  const [topPosts] = context.useState(async () => {
    try {
      const listing = context.reddit.getTopPosts({
        subredditName: context.subredditName ?? '',
        timeframe: 'week',
        limit: 10,
      });
      const posts = await listing.all();
      return posts.map((p) => ({
        id: p.id,
        title: p.title,
        score: p.score,
        numComments: p.numberOfComments,
        flair: p.flair?.text ?? null,
        url: p.url,
      }));
    } catch {
      return [] as Array<{ id: string; title: string; score: number; numComments: number; flair: string | null; url: string }>;
    }
  });

  const [flaggedPostsJson] = context.useState(async () => {
    const raw = await context.redis.get('dashboard:flagged_posts');
    if (!raw) return JSON.stringify([]);
    const posts = JSON.parse(raw) as FlaggedPostItem[];
    const hydrated = await Promise.all(posts.slice(0, 25).map(async (p) => ({
      ...p,
      recovery: !!(await context.redis.get(Keys.postRecovery(p.id))),
    })));
    return JSON.stringify(hydrated);
  });
  const flaggedPosts = JSON.parse(flaggedPostsJson) as FlaggedPostItem[];

  async function fetchLeaderboard() {
    const members = (await context.redis.zRange(Keys.leaderboardTrust, 0, 24, { by: 'rank', reverse: true }))
      .filter((m) => m.member.startsWith('t2_'));
    return Promise.all(members.map(async (m) => {
      const [usernameRaw, trustRaw] = await Promise.all([
        context.redis.get(Keys.userUsername(m.member)),
        context.redis.get(Keys.userTrust(m.member)),
      ]);
      const trust = trustRaw ? JSON.parse(trustRaw) as { tier: import('../redis/schema.js').TrustTier } : null;
      return {
        userId: m.member,
        username: usernameRaw ?? m.member,
        score: Math.round(m.score),
        tier: trust?.tier ?? ('neutral' as const),
      };
    }));
  }

  const [leaderboard, setLeaderboard] = context.useState(fetchLeaderboard);

  const dashTabs: { id: DashboardTab; label: string }[] = [
    { id: 'health', label: 'Health' },
    { id: 'topics', label: 'Topics' },
    { id: 'leaderboard', label: 'Leaderboard' },
    { id: 'posts', label: 'Posts' },
    { id: 'coach', label: 'Coach' },
  ];

  return (
    <vstack height="100%" width="100%">
      <hstack gap="small" padding="small" backgroundColor="neutral-background-selected" alignment="center middle">
        {dashTabs.map((t) => (
          <button
            key={t.id}
            size="small"
            grow
            appearance={activeTab === t.id ? 'primary' : 'secondary'}
            onPress={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </hstack>
      <vstack grow>
        {activeTab === 'health' && HealthOverview(health)}
        {activeTab === 'leaderboard' && UserLeaderboard(leaderboard, async () => { setLeaderboard(await fetchLeaderboard()); })}
        {activeTab === 'topics' && ContentInterests({
          topics: topicsData.topics,
          flairSuggestions: topicsData.flairSuggestions,
          dismissedTopics,
          onDismiss: (topic: string) => setDismissedTopics([...dismissedTopics, topic]),
          topicsMinimized,
          onToggleMinimize: () => setTopicsMinimized(!topicsMinimized),
          onAddFlair: async (topic) => {
            const cfg = await getConfig(context.redis);
            if (!cfg.flairList.includes(topic)) {
              cfg.flairList.push(topic);
              await setConfig(context.redis, cfg);
            }
            context.ui.showToast(`"${topic}" added as a flair.`);
          },
          onPutToVote: async (topic) => {
            const cfg = await getConfig(context.redis);

            // Mark any active proposals as superseded and clear the list
            const existingListRaw = await context.redis.get(Keys.flairProposalList);
            const existingList: string[] = existingListRaw ? (JSON.parse(existingListRaw) as string[]) : [];
            for (const eid of existingList) {
              const eRaw = await context.redis.get(Keys.flairProposal(eid));
              if (!eRaw) continue;
              const ep = JSON.parse(eRaw) as FlairProposal;
              if (ep.status === 'active') {
                ep.status = 'superseded';
                await context.redis.set(Keys.flairProposal(eid), JSON.stringify(ep));
              }
            }
            // Start with a clean list — only the new proposal will be added below
            await context.redis.set(Keys.flairProposalList, JSON.stringify([]));

            const proposalId = `prop_${Date.now()}`;
            const userId = context.userId ?? '';
            const username = userId
              ? ((await context.redis.get(Keys.userUsername(userId))) ?? 'mod')
              : 'mod';
            const proposal: FlairProposal = {
              id: proposalId,
              flair: topic,
              proposedByUserId: userId,
              proposedByUsername: username,
              createdAt: Date.now(),
              endsAt: Date.now() + cfg.flairVoting.votingPeriodHours * 3_600_000,
              status: 'active',
              postId: '',
            };
            // Send modmail first — no posts are created until the mod replies
            const configConv = await context.reddit.modMail.createConversation({
              subredditName: context.subredditName ?? '',
              subject: `SubGuardian: configure vote for "${topic}" flair`,
              body: [
                `A community vote has been staged for the **"${topic}"** flair.`,
                ``,
                `**No posts have been made yet.** Reply to this message to configure and publish.`,
                ``,
                `**Current defaults:**`,
                `- Duration: ${cfg.flairVoting.votingPeriodHours} hours`,
                `- Approval threshold: ${Math.round(cfg.flairVoting.approvalRatio * 100)}%`,
                `- Minimum votes (quorum): ${cfg.flairVoting.minVotes > 0 ? cfg.flairVoting.minVotes : 'none'}`,
                ``,
                `To use the defaults as-is, reply with just:`,
                `\`\`\``,
                `!vote config`,
                `\`\`\``,
                `To override any setting, include the values you want to change:`,
                `\`\`\``,
                `!vote config hours:48 threshold:0.7 minVotes:10`,
                `\`\`\``,
                `*SubGuardian will create the vote post and notify members upon receiving your reply.*`,
              ].join('\n'),
              isAuthorHidden: false,
            });
            proposal.configConversationId = configConv.conversation?.id ?? undefined;

            // Save proposal and list — posts created in handleVoteConfig after mod replies
            await context.redis.set(Keys.flairProposal(proposalId), JSON.stringify(proposal));
            const listRaw = await context.redis.get(Keys.flairProposalList);
            const list: string[] = listRaw ? (JSON.parse(listRaw) as string[]) : [];
            list.push(proposalId);
            await context.redis.set(Keys.flairProposalList, JSON.stringify(list));

            const wk = weekKey();
            if (userId) await context.redis.zIncrBy(Keys.leaderboardContributionsWeekly(wk), userId, 2);
            context.ui.showToast(`Vote staged — reply to the modmail to publish.`);
          },
        })}
        {activeTab === 'posts' && PostPerformance(context, topPosts, [])}
        {activeTab === 'coach' && CoachTab(context)}
      </vstack>
    </vstack>
  );
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function renderConfig(context: Context): JSX.Element {
  const redis = context.redis;
  const [activeTab, setActiveTab] = context.useState<ConfigTab>('presets');

  const [stateJson, setStateJson] = context.useState(async () => {
    const [config, killSwitchOn] = await Promise.all([
      getConfig(redis),
      isKillSwitchActive(redis),
    ]);
    return JSON.stringify({ config, killSwitchOn });
  });

  const parsed = stateJson
    ? JSON.parse(stateJson) as { config: SubConfig; killSwitchOn: boolean }
    : null;

  async function saveConfig(updated: SubConfig) {
    await saveConfig(updated);
    setStateJson(JSON.stringify({ config: updated, killSwitchOn: parsed?.killSwitchOn ?? false }));
  }

  return (
    <vstack height="100%" width="100%">
      {/* Config header */}
      <vstack
        width="100%"
        backgroundColor="#0079d322"
        padding="medium"
        gap="small"
      >
        <text size="xlarge" weight="bold">Config</text>
        <text size="small" color="neutral-content-weak">
          {parsed?.killSwitchOn ? '⛔ Emergency stop active' : '🟢 SubGuardian is running'}
        </text>
      </vstack>

      {/* Tab bar */}
      <hstack gap="small" padding="small" backgroundColor="neutral-background-selected" alignment="center middle">
        <button size="small" grow appearance={activeTab === 'presets' ? 'primary' : 'secondary'} onPress={() => setActiveTab('presets')}>Presets</button>
        <button size="small" grow appearance={activeTab === 'features' ? 'primary' : 'secondary'} onPress={() => setActiveTab('features')}>Features</button>
        <button size="small" grow appearance={activeTab === 'thresholds' ? 'primary' : 'secondary'} onPress={() => setActiveTab('thresholds')}>Thresholds</button>
        <button size="small" grow appearance={activeTab === 'danger' ? 'primary' : 'secondary'} onPress={() => setActiveTab('danger')}>Danger</button>
      </hstack>

      {!parsed && (
        <vstack grow alignment="center middle">
          <text size="small" color="neutral-content-weak">Loading config…</text>
        </vstack>
      )}

      {parsed && activeTab === 'presets' && (
        <vstack gap="medium" padding="medium" grow>
          {([
            { id: 'default', icon: '⚖️', label: 'Default', desc: 'Balanced automation for established subreddits.' },
            { id: 'strict',  icon: '🔒', label: 'Strict',  desc: 'Tighter thresholds. Requires 90+ day account age.' },
            { id: 'raid',    icon: '🛡️', label: 'Raid',    desc: 'Maximum protection. 180+ day accounts, 1000+ karma.' },
          ] as { id: PresetName; icon: string; label: string; desc: string }[]).map((p) => (
            <vstack
              key={p.id}
              backgroundColor="neutral-background"
              padding="medium"
              cornerRadius="medium"
              gap="small"
            >
              <hstack alignment="start middle" gap="small">
                <text size="large">{p.icon}</text>
                <text grow weight="bold" size="large">{p.label}</text>
                <button
                  size="small"
                  appearance="primary"
                  onPress={async () => {
                    await setPreset(redis, p.id);
                    await logAction(redis, {
                      timestamp: Date.now(),
                      action: 'preset_changed',
                      targetId: p.id,
                      targetType: 'config',
                      actor: 'mod',
                      reason: `Switched to ${p.id} preset`,
                    });
                    const newConfig = await getConfig(redis);
                    setStateJson(JSON.stringify({ config: newConfig, killSwitchOn: parsed?.killSwitchOn ?? false }));
                    context.ui.showToast(`Switched to ${p.label} preset`);
                  }}
                >
                  Apply
                </button>
              </hstack>
              <text size="small" color="neutral-content-weak">{p.desc}</text>
            </vstack>
          ))}
        </vstack>
      )}

      {parsed && activeTab === 'features' && (() => {
        const FEATURE_LABELS: Record<string, string> = {
          spamDetection: 'Spam Detection',
          reportHandling: 'Report Handling',
          antiRaid: 'Anti-Raid',
          banEvasion: 'Ban Evasion',
          flairAutoAssign: 'Auto Flair',
          flairTitleTags: 'Flair Title Tags',
          trustScoring: 'Trust Scoring',
          postRateLimit: 'Post Rate Limit',
          modmailRouting: 'Modmail Routing',
        };
        const entries = Object.entries(parsed.config.features) as [string, boolean][];
        return (
          <vstack gap="small" padding="medium" grow>
            {entries.map(([feature, enabled]) => (
              <hstack
                key={feature}
                backgroundColor="neutral-background"
                padding="medium"
                cornerRadius="medium"
                alignment="start middle"
              >
                <vstack grow gap="small">
                  <text weight="bold" size="small">{FEATURE_LABELS[feature] ?? feature}</text>
                </vstack>
                <button
                  size="small"
                  appearance={enabled ? 'primary' : 'secondary'}
                  onPress={async () => {
                    const updated = { ...parsed.config, features: { ...parsed.config.features, [feature]: !enabled } };
                    await saveConfig(updated);
                    context.ui.showToast(`${FEATURE_LABELS[feature] ?? feature} ${!enabled ? 'enabled' : 'disabled'}`);
                  }}
                >
                  {enabled ? 'ON' : 'OFF'}
                </button>
              </hstack>
            ))}
          </vstack>
        );
      })()}

      {parsed && activeTab === 'thresholds' && (
        <vstack gap="medium" padding="medium" grow>
          <text weight="bold">Spam Detection Thresholds</text>
          <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
            <hstack alignment="start middle">
              <text grow size="small">Auto-Flag threshold</text>
              <text size="small" weight="bold">{parsed.config.spamDetection.autoFlagThreshold.toFixed(2)}</text>
            </hstack>
            <hstack gap="small">
              {[0.30, 0.40, 0.50, 0.65, 0.75].map((v) => (
                <button
                  key={String(v)}
                  size="small"
                  appearance={parsed.config.spamDetection.autoFlagThreshold === v ? 'primary' : 'secondary'}
                  onPress={async () => {
                    const updated = { ...parsed.config, spamDetection: { ...parsed.config.spamDetection, autoFlagThreshold: v } };
                    await saveConfig(updated);
                    context.ui.showToast(`Flag threshold set to ${v}`);
                  }}
                >
                  {String(v)}
                </button>
              ))}
            </hstack>
            <hstack alignment="start middle" gap="small">
              <text grow size="small" color="neutral-content-weak">
                Shadow-test candidate threshold: {parsed.config.shadowAudit.thresholdTestValue.toFixed(2)}
              </text>
              <button
                size="small"
                appearance={parsed.config.shadowAudit.thresholdTestActive ? 'primary' : 'secondary'}
                onPress={async () => {
                  const updated = {
                    ...parsed.config,
                    shadowAudit: {
                      ...parsed.config.shadowAudit,
                      thresholdTestActive: !parsed.config.shadowAudit.thresholdTestActive,
                      startedAt: !parsed.config.shadowAudit.thresholdTestActive ? Date.now() : parsed.config.shadowAudit.startedAt,
                    },
                  };
                  await saveConfig(updated);
                  context.ui.showToast(`Shadow threshold test ${updated.shadowAudit.thresholdTestActive ? 'enabled' : 'disabled'}`);
                }}
              >
                {parsed.config.shadowAudit.thresholdTestActive ? 'Testing' : 'Test Mode'}
              </button>
            </hstack>
          </vstack>
          <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
            <hstack alignment="start middle">
              <text grow size="small">Auto-Remove threshold</text>
              <text size="small" weight="bold">{parsed.config.spamDetection.autoRemoveThreshold.toFixed(2)}</text>
            </hstack>
            <hstack gap="small">
              {[0.60, 0.70, 0.75, 0.85, 0.95].map((v) => (
                <button
                  key={String(v)}
                  size="small"
                  appearance={parsed.config.spamDetection.autoRemoveThreshold === v ? 'primary' : 'secondary'}
                  onPress={async () => {
                    const updated = { ...parsed.config, spamDetection: { ...parsed.config.spamDetection, autoRemoveThreshold: v } };
                    await saveConfig(updated);
                    context.ui.showToast(`Remove threshold set to ${v}`);
                  }}
                >
                  {String(v)}
                </button>
              ))}
            </hstack>
          </vstack>
          <text weight="bold">Banned Keywords</text>
          <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
            <hstack gap="small">
              {['crypto', 'OnlyFans', 'free money', 'click here'].map((kw) => (
                <vstack key={kw} gap="small">
                  <button
                    size="small"
                    appearance={parsed.config.spamDetection.bannedKeywords.includes(kw) ? 'primary' : 'secondary'}
                    onPress={async () => {
                      const current = parsed.config.spamDetection.bannedKeywords;
                      const next = current.includes(kw)
                        ? current.filter((k) => k !== kw)
                        : [...current, kw];
                      const updated = { ...parsed.config, spamDetection: { ...parsed.config.spamDetection, bannedKeywords: next } };
                      await saveConfig(updated);
                      context.ui.showToast(`${kw} ${current.includes(kw) ? 'removed' : 'added'}`);
                    }}
                  >
                    {kw}
                  </button>
                  <button
                    size="small"
                    appearance={parsed.config.shadowAudit.keywords.includes(kw) ? 'primary' : 'secondary'}
                    onPress={async () => {
                      const shadow = parsed.config.shadowAudit.keywords;
                      const nextShadow = shadow.includes(kw)
                        ? shadow.filter((k) => k !== kw)
                        : [...shadow, kw];
                      const updated = {
                        ...parsed.config,
                        shadowAudit: {
                          ...parsed.config.shadowAudit,
                          keywords: nextShadow,
                          startedAt: nextShadow.length > 0 ? (parsed.config.shadowAudit.startedAt ?? Date.now()) : null,
                        },
                      };
                      await saveConfig(updated);
                      context.ui.showToast(`${kw} shadow test ${shadow.includes(kw) ? 'stopped' : 'started'}`);
                    }}
                  >
                    Test
                  </button>
                </vstack>
              ))}
            </hstack>
            {parsed.config.shadowAudit.keywords.length > 0 ? (
              <text size="small" color="#ffaa00">
                Active shadow tests: {parsed.config.shadowAudit.keywords.join(', ')} | {Math.max(0, 24 - Math.floor((Date.now() - (parsed.config.shadowAudit.startedAt ?? Date.now())) / 3_600_000))}h left
              </text>
            ) : null}
            {(() => {
              const defaults = ['crypto', 'onfans', 'free money', 'click here'];
              const customCount = parsed.config.spamDetection.bannedKeywords.filter(
                (k) => !defaults.includes(k.toLowerCase())
              ).length;
              return (
                <text size="small" color="neutral-content-weak">
                  {customCount > 0 ? `+${customCount} custom` : 'No custom keywords'} — add via modmail: !keyword add word
                </text>
              );
            })()}
          </vstack>
          <text weight="bold">Flair Voting</text>
          <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
            <hstack alignment="start middle">
              <text grow size="small">Min trust score to vote</text>
              <text size="small" weight="bold">{parsed.config.flairVoting.minTrustToVote}</text>
            </hstack>
            <hstack gap="small">
              {[100, 200, 300, 400, 500].map((v) => (
                <button
                  key={String(v)}
                  size="small"
                  appearance={parsed.config.flairVoting.minTrustToVote === v ? 'primary' : 'secondary'}
                  onPress={async () => {
                    const updated = { ...parsed.config, flairVoting: { ...parsed.config.flairVoting, minTrustToVote: v } };
                    await saveConfig(updated);
                    context.ui.showToast(`Min trust to vote set to ${v}`);
                  }}
                >
                  {String(v)}
                </button>
              ))}
            </hstack>
            <text size="small" color="neutral-content-weak">Users below this score cannot cast flair votes.</text>
          </vstack>
          <text weight="bold">Quiet Hours</text>
          <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
            <hstack alignment="start middle">
              <text grow size="small">Pause non-critical modmail</text>
              <button
                size="small"
                appearance={parsed.config.quietHours.enabled ? 'primary' : 'secondary'}
                onPress={async () => {
                  const updated = {
                    ...parsed.config,
                    quietHours: { ...parsed.config.quietHours, enabled: !parsed.config.quietHours.enabled },
                  };
                  await saveConfig(updated);
                  context.ui.showToast(`Quiet hours ${updated.quietHours.enabled ? 'enabled' : 'disabled'}`);
                }}
              >
                {parsed.config.quietHours.enabled ? 'ON' : 'OFF'}
              </button>
            </hstack>
            <hstack gap="small">
              {[20, 22, 23].map((h) => (
                <button
                  key={`start-${h}`}
                  size="small"
                  appearance={parsed.config.quietHours.startHour === h ? 'primary' : 'secondary'}
                  onPress={async () => {
                    await saveConfig({ ...parsed.config, quietHours: { ...parsed.config.quietHours, startHour: h } });
                    context.ui.showToast(`Quiet hours start at ${h}:00 UTC`);
                  }}
                >
                  {h}:00
                </button>
              ))}
              {[6, 7, 8].map((h) => (
                <button
                  key={`end-${h}`}
                  size="small"
                  appearance={parsed.config.quietHours.endHour === h ? 'primary' : 'secondary'}
                  onPress={async () => {
                    await saveConfig({ ...parsed.config, quietHours: { ...parsed.config.quietHours, endHour: h } });
                    context.ui.showToast(`Quiet hours end at ${h}:00 UTC`);
                  }}
                >
                  {h}:00
                </button>
              ))}
            </hstack>
            <text size="small" color="neutral-content-weak">
              Current: {parsed.config.quietHours.startHour}:00-{parsed.config.quietHours.endHour}:00 UTC. Critical alerts still deliver.
            </text>
          </vstack>
        </vstack>
      )}

      {parsed && activeTab === 'danger' && (
        <vstack gap="medium" padding="medium" grow>
          <vstack
            backgroundColor={parsed.killSwitchOn ? '#ff444422' : 'neutral-background'}
            padding="medium"
            cornerRadius="medium"
            gap="small"
          >
            <text weight="bold" color={parsed.killSwitchOn ? '#ff4444' : undefined}>Emergency Stop</text>
            <text size="small" color="neutral-content-weak">When active, ALL automation is paused immediately.</text>
            <text size="small" color={parsed.killSwitchOn ? '#ff4444' : 'neutral-content-weak'}>
              Status: {parsed.killSwitchOn ? '🔴 ACTIVE' : '🟢 Inactive'}
            </text>
            <button
              appearance={parsed.killSwitchOn ? 'secondary' : 'destructive'}
              onPress={async () => {
                if (parsed.killSwitchOn) {
                  await deactivateKillSwitch(redis);
                  await logAction(redis, { timestamp: Date.now(), action: 'kill_switch_deactivated', targetId: 'system', targetType: 'system', actor: 'mod', reason: 'Deactivated via Config UI' });
                  setStateJson(JSON.stringify({ config: parsed.config, killSwitchOn: false }));
                  context.ui.showToast('Automation resumed.');
                } else {
                  await activateKillSwitch(redis);
                  await logAction(redis, { timestamp: Date.now(), action: 'kill_switch_activated', targetId: 'system', targetType: 'system', actor: 'mod', reason: 'Activated via Config UI' });
                  setStateJson(JSON.stringify({ config: parsed.config, killSwitchOn: true }));
                  context.ui.showToast('Emergency stop activated.');
                }
              }}
            >
              {parsed.killSwitchOn ? '✅ Resume Automation' : '⛔ Pause All Automation'}
            </button>
          </vstack>

          <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
            <text weight="bold">Export Config</text>
            <text size="small" color="neutral-content-weak">Sends current config as JSON to your mod inbox.</text>
            <button
              size="small"
              onPress={async () => {
                await context.reddit.modMail.createConversation({
                  subredditName: context.subredditName ?? '',
                  subject: 'SubGuardian Config Export',
                  body: `\`\`\`json\n${JSON.stringify(parsed.config, null, 2)}\n\`\`\``,
                  isAuthorHidden: false,
                });
                context.ui.showToast('Config exported to mod inbox.');
              }}
            >
              Export to Mod Inbox
            </button>
          </vstack>

          <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
            <text weight="bold" color="#ff4444">Reset to Default</text>
            <text size="small" color="neutral-content-weak">Resets all settings to the Default preset. Cannot be undone.</text>
            <button
              appearance="destructive"
              size="small"
              onPress={async () => {
                await setPreset(redis, 'default');
                await logAction(redis, { timestamp: Date.now(), action: 'config_reset', targetId: 'system', targetType: 'config', actor: 'mod', reason: 'Config reset to default via Danger Zone' });
                const newConfig = await getConfig(redis);
                setStateJson(JSON.stringify({ config: newConfig, killSwitchOn: parsed.killSwitchOn }));
                context.ui.showToast('Config reset to Default preset.');
              }}
            >
              Reset to Default
            </button>
          </vstack>
        </vstack>
      )}
    </vstack>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

type OnboardingStep = 1 | 2 | 3;

export function renderOnboarding(context: Context): JSX.Element {
  const redis = context.redis;
  const [step, setStep] = context.useState<OnboardingStep>(1);
  const [chosenPreset, setChosenPreset] = context.useState<PresetName>('default');

  const PRESETS: { name: PresetName; label: string; description: string }[] = [
    { name: 'default', label: 'Default', description: 'Balanced. Good for established subs.' },
    { name: 'strict', label: 'Strict', description: '90+ day accounts required to post.' },
    { name: 'raid', label: 'Raid Mode', description: '180+ days + 1000 karma. For active raids.' },
  ];

  const GATES: { key: string; label: string; description: string }[] = [
    { key: 'postsPerDay', label: 'Posts per Day Limit', description: 'Limit how many posts a user can make per day.' },
    { key: 'accountAgeDays', label: 'Min Account Age', description: 'Require accounts to be a minimum age.' },
    { key: 'minKarma', label: 'Minimum Karma', description: 'Require a minimum karma score to post.' },
    { key: 'minTrustScore', label: 'Minimum Trust Score', description: 'Require a SubGuardian trust score threshold.' },
  ];

  // Step 1 — Preset selection
  if (step === 1) {
    return (
      <vstack height="100%" width="100%" gap="small" padding="medium">
        <text size="large" weight="bold">Welcome to SubGuardian</text>
        <text size="small" color="neutral-content-weak">Step 1 of 3 — Choose a starting preset:</text>
        {PRESETS.map((preset) => (
          <hstack key={preset.name} backgroundColor="neutral-background" padding="small" cornerRadius="medium" alignment="start middle" gap="small">
            <vstack grow gap="small">
              <text weight="bold" size="small">{preset.label}</text>
              <text size="small" color="neutral-content-weak">{preset.description}</text>
            </vstack>
            <button
              size="small"
              appearance={chosenPreset === preset.name ? 'primary' : 'secondary'}
              onPress={() => setChosenPreset(preset.name)}
            >
              {chosenPreset === preset.name ? '✓ Selected' : 'Select'}
            </button>
          </hstack>
        ))}
        <button appearance="primary" onPress={() => setStep(2)}>Next →</button>
      </vstack>
    );
  }

  // Step 2 — Anti-raid gate selections
  if (step === 2) {
    return (
      <vstack height="100%" width="100%" gap="small" padding="medium">
        <text size="large" weight="bold">Anti-Raid Gates</text>
        <text size="small" color="neutral-content-weak">Step 2 of 3 — These gates are pre-configured by your preset. Enable or disable individually:</text>
        {GATES.map((gate) => (
          <hstack key={gate.key} backgroundColor="neutral-background" padding="small" cornerRadius="small" alignment="start middle" gap="small">
            <vstack grow gap="small">
              <text weight="bold" size="small">{gate.label}</text>
              <text size="small" color="neutral-content-weak">{gate.description}</text>
            </vstack>
            <text size="small" color="neutral-content-weak">
              {chosenPreset === 'default' ? 'Off' : 'On'}
            </text>
          </hstack>
        ))}
        <text size="small" color="neutral-content-weak">Gates can be toggled individually from the Config Editor after setup.</text>
        <hstack gap="small">
          <button appearance="secondary" onPress={() => setStep(1)}>← Back</button>
          <button appearance="primary" grow onPress={() => setStep(3)}>Next →</button>
        </hstack>
      </vstack>
    );
  }

  // Step 3 — Confirm & save
  return (
    <vstack height="100%" width="100%" gap="medium" padding="medium">
      <text size="large" weight="bold">Ready to Go</text>
      <text size="small" color="neutral-content-weak">Step 3 of 3 — Confirm your setup:</text>
      <vstack backgroundColor="neutral-background" padding="medium" cornerRadius="medium" gap="small">
        <hstack alignment="start middle">
          <text grow size="small" color="neutral-content-weak">Preset</text>
          <text weight="bold">{chosenPreset.charAt(0).toUpperCase() + chosenPreset.slice(1)}</text>
        </hstack>
        <hstack alignment="start middle">
          <text grow size="small" color="neutral-content-weak">Anti-raid gates</text>
          <text weight="bold">{chosenPreset === 'default' ? 'All off' : 'All on'}</text>
        </hstack>
        <hstack alignment="start middle">
          <text grow size="small" color="neutral-content-weak">Spam detection</text>
          <text weight="bold">Enabled</text>
        </hstack>
      </vstack>
      <text size="small" color="neutral-content-weak">All settings can be adjusted anytime from the Config Editor.</text>
      <hstack gap="small">
        <button appearance="secondary" onPress={() => setStep(2)}>← Back</button>
        <button
          appearance="primary"
          grow
          onPress={async () => {
            await setPreset(redis, chosenPreset);
            await logAction(redis, {
              timestamp: Date.now(),
              action: 'onboarding_completed',
              targetId: chosenPreset,
              targetType: 'config',
              actor: 'mod',
              reason: `Onboarding completed with preset: ${chosenPreset}`,
            });
            context.ui.showToast('SubGuardian is ready!');
          }}
        >
          ✓ Confirm & Activate
        </button>
      </hstack>
    </vstack>
  );
}

// ─── Loading spinner ──────────────────────────────────────────────────────────

export function renderLoadingSpinner(label: string): JSX.Element {
  return (
    <vstack alignment="center middle" height="100%" width="100%">
      <text size="medium" color="neutral-content-weak">Loading {label}...</text>
    </vstack>
  );
}
