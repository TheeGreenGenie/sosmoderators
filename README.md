# SubGuardian

A Devvit app for Reddit that provides automated moderation, trust scoring, flair management, and community engagement tools for subreddit moderators.

---

## Features

### Automated Post Moderation
- **Spam scoring** — heuristic signals: duplicate titles/selftext, banned keywords, banned domains, URL-in-title, high URL density, ALL CAPS, excessive punctuation, new account age. Each signal has an additive weight; the total drives the action.
- **Auto-remove** — posts exceeding the configured threshold are removed immediately.
- **Auto-flag** — borderline posts are held for review and the author is notified by PM.
- **Kill switch** — one toggle in the Config UI pauses all automated actions without touching settings.
- **Per-user rate limit** — max 2 posts per 5 minutes, configurable.

### Trust Score System
Scores run 0–1000 and update after every moderation event.

| Tier | Range | Effect |
|------|-------|--------|
| Grace | first 5 approved posts | lighter scrutiny, temporary |
| Untrusted | 0–149 | full spam checks, strictest gates |
| Low | 150–299 | reduced report weight (0.5×) |
| Neutral | 300–499 | normal (1.0× report weight) |
| Trusted | 500–699 | elevated (1.5× report weight) |
| Highly Trusted | 700–1000 | bypasses all raid/strict mode gates |

**Score components:**
- Account age (max +150)
- Subreddit karma (log-scaled, max +120)
- Approved post history (+15 each, max +150)
- Positive signals: awards, top posts, adopted flair proposals (+10/+5/+15)
- Penalties: removed posts (−15), actioned reports against (−20), temp bans (−75), perm bans (−300)

**Trust decay** — runs weekly; users inactive for 90+ days decay at 5% per cycle, floored at 300 for previously trusted users.

### Anti-Raid Mode
Configurable gates that activate during raids:
- Minimum account age
- Minimum karma
- Minimum trust score
- Posts per day cap

Users with trust ≥ 700 always bypass all gates regardless of mode. Three presets — **Default**, **Strict**, **Raid** — each tighten thresholds progressively. Raid mode auto-expires via a scheduled job.

### Coordinated Inauthentic Behaviour (CIB) Detection
Detects burst-pattern reporting: 3+ reports on the same post within a 5-minute window triggers a modmail alert. If view count is available, a report/view ratio ≥ 10% is treated as organic community response and suppresses the alert (the community genuinely disliked the post rather than coordinating against it).

### Spike Detector
Runs every 15 minutes. Compares the current hour's post volume against the same hour-slot for the previous 4 weeks. If current ≥ 2.5× the baseline average (and at least 10 posts this hour), sends a modmail spike alert. A separate toxicity spike check runs the same logic against average comment toxicity scores.

### Flair Pipeline
Three-stage pipeline runs on every approved post:

1. **Title tag** (opt-in) — `[TagName]` prefix matched against the flair list; applied immediately if found.
2. **AI auto-apply** — confidence ≥ 0.8 applies the flair silently.
3. **AI suggestion** — confidence 0.4–0.79 posts a bot comment asking the author to reply "yes" to confirm. A PM is also sent (with 30-minute cooldown). Confirmed flairs are applied and the bot comment is deleted.

The AI layer uses the configured external LLM API as primary, with the built-in keyword/pattern heuristic as automatic fallback (used when the API endpoint or key is not configured, or if the API call fails).

### Community Flair Voting
Mods propose new flairs via the dashboard. The flow:
1. Mod clicks "Put to Vote" — a modmail thread is opened asking the mod to confirm defaults or customise.
2. Mod replies `!vote config` to the modmail — the vote post and subreddit announcement are created.
3. Community members vote (trust ≥ `minTrustToVote`, default 300). One vote per user enforced by Redis NX lock.
4. Voters earn +1 contribution point on both weekly and all-time leaderboards.
5. Tally fires when quorum is reached or the voting period expires. Approved flairs are added to both the internal flair list and Reddit's flair template system via `createPostFlairTemplate`.
6. Only one active vote at a time — staging a new proposal supersedes any existing active one.

### Contribution Leaderboard
Two sorted sets track contribution points — all-time and current week:
- Approved post submitted: +1
- Adopted flair proposal: +15 (trust score component)
- Voted in a community flair vote: +1

Weekly top contributor is highlighted every Sunday at 20:00 UTC with a stickied post. The old highlight post is unpinned and removed when a new one is created.

### Reporting Flow
- Reports are weighted by reporter trust tier (untrusted: 0.25×, low: 0.5×, neutral/grace: 1.0×, trusted: 1.5×).
- Weighted report count reaching `autoActionThreshold` triggers automatic removal.
- View/report ratio check: if enough views exist and the report rate is high, the threshold is lowered.
- CIB check runs on every report event.

### Ban Evasion Detection
New accounts with usernames similar (Levenshtein distance ≤ 2) to previously banned accounts trigger a modmail alert.

### Modmail Routing
- `!appeal` — routes to appeal handler, runs AI analysis on the appeal text.
- `!vote config` — confirms a pending flair vote proposal and creates the vote + announcement posts.

### Stats Report
Triggered on demand via subreddit menu. Sends a modmail with:
- 7-day post/removal/flag/approval counts
- Report handling stats (total, actioned, false positive)
- System status (Redis usage, kill switch state, raid mode state)
- Feature toggle states
- Last 10 audit log entries

### Audit Log
Every moderation action is written to a bounded log (max 1000 entries) readable from the dashboard Audit Log tab.

### Redis Memory Monitor
Runs hourly. Warns at 80% of 500 MB, critical at 90%. Sends a modmail alert on first breach per day.

---

## Dashboard (Custom Post UI)

Opened via subreddit menu → "SubGuardian: Open Dashboard". Six tabs:

| Tab | Contents |
|-----|----------|
| Overview | Today's stats, 7-day averages, system status indicators |
| Pending Review | Flagged posts with spam scores, trust badges, approve/remove actions |
| Posts | Top upvoted posts from the last 7 days ranked by score |
| Content Interests | Topic frequency from recent post titles; "Put to Vote" button per topic |
| Reports | Report/actioned counts |
| Audit Log | Last 10 audit entries |

### Config UI
Opened via subreddit menu → "SubGuardian: Open Config". Controls:

- **Presets** — Default / Strict / Raid (one click applies a full config bundle)
- **Feature toggles** — spam detection, report handling, anti-raid, ban evasion, flair auto-assign, flair title tags, post rate limit
- **Thresholds tab** — auto-remove threshold, auto-flag threshold, `minTrustToVote` (buttons: 100/200/300/400/500)
- **Spam keywords** — add/remove banned keywords
- **Anti-raid gates** — enable/configure each gate individually

---

## Scheduled Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `aggregate_builder` | Every 15 min | Computes 7-day rolling averages for posts, reports, users |
| `spike_detector` | Every 15 min | Compares current hour to 4-week baseline; alerts on 2.5× spike |
| `redis_monitor` | Hourly | Checks Redis memory usage against 500 MB cap |
| `trust_decay` | Weekly | Decays scores for users inactive 90+ days |
| `raid_mode_expiry` | Hourly | Auto-expires raid mode after configured duration |
| `flair_vote_tallier` | Hourly + on quorum | Tallies votes; applies approved flairs to Reddit |
| `weekly_highlight` | Sunday 20:00 UTC | Posts top contributor highlight, pins it at position 2 |
| `retry_queue_drain` | Every 5 min | Retries rate-limited moderation actions |

---

## Trust Score Formula

```
score = accountAge + subKarma + approvalRate + positiveSignals − penalties
      = min(ageDays / 7.5, 150)
      + min(log10(max(karma, 1)) × 40, 120)
      + min(approvedPosts × 15, 150)
      + min(awards×10 + topPosts×5 + helpfulReports×3 + adoptedFlairs×15, 100)
      − min(removedPosts×15 + actionedReports×20 + tempBans×75 + permBans×300, 400)
```

Clamped to [0, 1000].

---

## AI / Flair Intelligence

The AI layer is a two-tier system:

1. **Primary — External LLM API** (`LLMProvider`): calls the configured endpoint with a Bearer token. Used for flair suggestion, content analysis, and appeal analysis.
2. **Fallback — Built-in heuristic** (`HeuristicProvider`): keyword matching and pattern scoring. Activates automatically when the API endpoint/key is not set or when the API call fails.

To activate the LLM: set `LLM_API_KEY` via `devvit settings set` and configure the endpoint in the Config UI. No code change needed — the provider selection is automatic.

---

## Redis Key Structure

All keys are defined in `src/redis/schema.ts`. Major namespaces:

| Namespace | Contents |
|-----------|----------|
| `user:{id}:trust` | Trust score record (JSON) |
| `user:{id}:activity` | Activity counters |
| `user:{id}:grace` | Grace period flag |
| `post:{id}:reports` | Report record with weighted count and CIB flag |
| `post:{id}:score` | Spam score breakdown |
| `agg:posts:daily:{YYYYMMDD}` | Daily post aggregate |
| `agg:reports:daily:{YYYYMMDD}` | Daily report aggregate |
| `spike:posts:{YYYYMMDDHH}` | Hourly post count for spike detection |
| `leaderboard:contributions` | All-time contribution sorted set |
| `leaderboard:contributions:weekly:{YYYYMMDD}` | Weekly contribution sorted set |
| `leaderboard:trust` | Trust score sorted set |
| `flair:proposal:{id}` | Vote proposal state |
| `flair:vote:lock:{proposalId}:{userId}` | NX lock preventing double-votes |
| `sub:config` | Full subreddit config (JSON) |
| `audit:log` | Bounded audit log (max 1000 entries) |

---

## Permissions Required

Declared in `devvit.yaml`:
- `posts` — submit and manage posts
- `privatemessages` — send PMs and modmail
- `flair` — apply and create flair templates
- `modposts` — approve/remove posts

---

## Setup

### Prerequisites
- [Devvit CLI](https://developers.reddit.com/docs/devvit_cli) installed and authenticated
- Node.js 18+

### Install and deploy
```bash
npm install
devvit upload
```

### Configure LLM (optional)
```bash
devvit settings set LLM_API_KEY <your-key>
```
Then set the API endpoint in the Config UI. Without this the heuristic provider handles all AI tasks.

### Development testing
```bash
cd botTesting
npm install
# Terminal 1 — coordination server
npx ts-node coordination/server.ts
# Terminal 2 — run a scenario
npx ts-node scenarios/12_cib_local.ts
npx ts-node scenarios/17_spikeDetector_local.ts
```

Selenium-based scenarios (02–11, 13–16) require Chrome + ChromeDriver and credentials in `botTesting/.env` (see `.env.example`).

---

## CIB Detection Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `MIN_BURST_COUNT` | 3 | Minimum reports within window to check |
| `BURST_WINDOW_MS` | 5 minutes | Reports must arrive within this window |
| `ORGANIC_REPORT_RATIO` | 10% | If reports/views ≥ 10%, treat as organic — no CIB alert |

---

## Spam Score Signals

| Signal | Weight | Trigger |
|--------|--------|---------|
| `title_duplicate` | 0.45 | Same title seen in last 30 days |
| `selftext_duplicate` | 0.40 | Near-identical body seen in last 30 days |
| `domain_banned` | 0.55 | URL domain on banned list |
| `banned_keyword` | 0.50 | Configured keyword in title or body |
| `url_in_title` | 0.30 | URL detected in post title |
| `high_url_density` | 0.25 | Links > 15% of body words |
| `excessive_caps` | 0.25 | 3+ ALL-CAPS words in title |
| `excessive_punctuation` | 0.25 | 3+ consecutive `!` or `?` |
| `very_new_account` | 0.25 | Account age < 7 days |

Trust offset: `−(trustScore / 1000) × 0.3` applied after summing signals.

---

## Cleanup Before App Review

1. Remove or disable the dev-only menu items in `src/main.ts`:
   - "SubGuardian: [DEV] Clear Test Caches"
   - "SubGuardian: [DEV] Set User Trust Score"
   - "SubGuardian: [DEV] Trigger Job Now"
2. Run `devvit upload` with a clean build.
3. Delete or archive `botTesting/results.md` and `botTesting/testing.md` logs.
