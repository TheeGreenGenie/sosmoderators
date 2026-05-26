# SubGuardian

SubGuardian is an automated moderation assistant for Reddit subreddits. It handles spam filtering, trust scoring, flair management, and community tools — all from a dashboard inside your subreddit. New mods get an AI co-pilot that answers questions about their own sub's data. Veteran mods get precise controls without having to write AutoMod rules from scratch.

> **Access control:** Only subreddit moderators can open the Dashboard or Config UI. Non-mods see an access-denied screen.

---

## What SubGuardian Does

### Spam Filtering

Every post is scored the moment it's submitted. SubGuardian looks for duplicate titles, duplicate body text, banned keywords, banned domains, links in titles, all-caps words, excessive punctuation, and very new accounts. Each signal adds to a spam score. If the score crosses your flag threshold, the post is kept on the feed and held for mod review. If it crosses your auto-remove threshold, it's removed outright.

Users with a high trust score get a discount on their spam score — an established contributor won't be flagged for a borderline keyword.

### First-Time Offender Recovery

When a user with no prior violations hits the flag threshold for the first time, SubGuardian doesn't hard-remove the post. Instead it holds it, sends the author a PM explaining exactly which signals fired and how to fix them, and opens a 24-hour edit window. The author edits their post and replies `!recheck` to the PM. SubGuardian re-scores the post automatically — if it passes, the post goes live without any mod action needed.

Posts in the recovery window appear with a **Recovery** badge in the Pending Review queue so mods know not to hard-remove them prematurely.

### Trust Score System

Every user in your subreddit gets a trust score from 0–1000. The score updates after every moderation event and determines how strictly the system treats future posts.

| Tier | Score Range | What it means |
|------|------------|---------------|
| Grace | New account | Lighter scrutiny for the first 5 approved posts |
| Untrusted | 0–149 | Full spam checks, strictest gates |
| Low | 150–299 | Reports carry half weight |
| Neutral | 300–499 | Standard treatment |
| Trusted | 500–699 | Reports carry 1.5× weight |
| Highly Trusted | 700–1000 | Bypasses all raid/strict mode gates |

Trust goes up through approved posts, account age, subreddit karma, helpful reports, awards, and top posts. It goes down through removed posts, actioned reports against the user, and bans.

The **Trust Leaderboard** in the dashboard shows the top contributors in a compact 2-column layout with tier badges and medals for the top 3 positions.

### Contextual Why-Removed PMs

When a post is flagged or removed, the author receives a PM that names the exact signals that triggered it, shows the spam score vs. your threshold, and gives a concrete suggestion for how to fix the post. It ends with `!recheck` instructions. No generic "your post was removed" messages.

### SubGuardian Coach (AI Co-Pilot)

The Coach tab inside the dashboard lets any mod ask plain-English questions about their own subreddit's data. It answers using your actual config, trust records, recent audit log, and spam stats — not generic Reddit advice.

**Example questions it can answer:**
- "Why was the last post flagged?"
- "Is u/username a problem?"
- "What should I set up first as a new mod?"
- "Suggest some keywords to block based on recent removals"
- "What's the system status?"
- "Explain how our trust scores work"

Six quick-answer chips cover the most common questions so mods don't need to type anything. The "Ask a question..." button opens a free-text form for anything else.

Coach works without any LLM configuration — the heuristic mode reads your Redis data and gives grounded, specific answers. If you configure an LLM API key and endpoint in the Config UI, Coach switches to LLM mode for free-form questions.

### Topic Intelligence

The Posts tab surfaces the topics your community actually posts about, derived from post titles. SubGuardian strips stop words, Reddit meta-words (post, thread, comment, flair, etc.), and generic filler words, then applies suffix stemming so "testing" and "test" are counted as the same word. Topics are displayed as a ranked frequency bar chart. The section is collapsible so you can always see flair suggestions below it.

The aggregate builder job runs every 15 minutes and selectively prunes any previously stored words that no longer pass the filter — without wiping valid topic counts.

### Shadow-Audit Mode

Before adding a new spam keyword to your live filter, you can test it for 24 hours in shadow mode. Shadow mode logs every post the keyword *would have* caught without actually removing anything. After 24 hours, SubGuardian sends your mod team a modmail digest showing how many posts matched and 5 sample titles.

To promote a keyword from shadow mode to live, reply `!shadow-activate <keyword>` to the digest modmail. To add a keyword to shadow mode, go to Config UI → Thresholds and tap the **Test Mode** button next to any keyword.

A countdown timer in the Config UI shows how much time is left on each shadow test.

### Modqueue Case File

Opening a post from the Pending Review queue shows a full case brief instead of just a score:

- Which signals fired and why
- The author's full history in your subreddit (approved posts, violations, reports)
- Similar past cases with the same signal mix and what the mod decided
- A suggested verdict (Approve or Remove) with reasoning

Mods can add a note and take action directly from the case file. Every decision is recorded as precedent for future similar posts.

### Anti-Raid Mode

Three built-in presets — Default, Strict, and Raid — progressively tighten posting requirements. In Raid mode, gates can require minimum account age, minimum karma, minimum trust score, and a per-day post cap. Users with trust ≥ 700 always bypass raid gates.

When the spike detector sees post volume hit 2.5× the 4-week baseline, it sends your mod team a modmail alert ending with: "Reply `!raid` to activate Raid preset immediately." One reply activates Raid mode without opening the dashboard.

Raid mode auto-expires after your configured duration.

### Flair System

SubGuardian runs a three-stage flair pipeline on every approved post:

1. If the title starts with `[Tag]` and that tag matches a flair, it's applied immediately.
2. If the AI is confident enough (≥ 80%), it applies the flair silently.
3. At medium confidence (40–79%), it posts a bot comment asking the author to reply "yes" to confirm, and sends them a PM.

Mods can propose new flairs from the dashboard. SubGuardian opens a modmail thread to confirm voting settings, then creates a community vote post. Members with trust ≥ your minimum vote threshold can vote. Approved flairs are added to your subreddit's flair templates automatically.

### Enhanced Appeal Handling

When a user sends modmail containing appeal language ("appeal", "unfair", "ban", etc.), SubGuardian automatically replies in-thread with a structured analysis:

- A 2–3 bullet summary of what the user said
- A recommendation (Approve / Deny / Review Manually) with a confidence percentage
- The user's prior appeal history
- The full original appeal text below the fold

Mods still make the final call — SubGuardian just front-loads the context so they don't have to look it up.

### Contribution Leaderboard

Members earn points for approved posts, helpful reports, and voting in flair elections. Top posts earn bonus points proportional to their upvote score. The weekly top contributor gets a stickied highlight post every Sunday. An all-time leaderboard is also maintained.

### Quiet Hours

If your mod team doesn't want non-critical notifications in the middle of the night, enable quiet hours in the Config UI and set a UTC start and end time. Spike alerts, stats digests, and routine notifications are silently dropped during quiet hours. Critical alerts — CIB confirmed, raid mode activated, Redis memory critical — always deliver regardless of the hour.

---

## Dashboard

Open the dashboard from the subreddit menu: **SubGuardian: Open Dashboard**

| Tab | What you'll find |
|-----|-----------------|
| Overview | Today's post/removal/flag counts, 7-day averages, system status |
| Pending Review | Flagged posts — click any to open the full Case File |
| Posts | Top 10 posts this week in a 2-column grid; collapsible topic chart; flair suggestions |
| Leaderboard | All-time and weekly contribution rankings in a compact 2-column layout |
| Audit Log | Recent moderation actions taken by SubGuardian |
| Coach | AI co-pilot — ask anything about your sub's data |

The Dashboard post recreates itself automatically if it is ever deleted or removed from the subreddit.

---

## Config UI

Open from the subreddit menu: **SubGuardian: Open Config**

| Section | What you can configure |
|---------|----------------------|
| Presets | Apply a Default, Strict, or Raid configuration bundle in one click |
| Features | Toggle spam detection, report handling, anti-raid, ban evasion, flair pipeline, and post rate limiting — displayed in a 3-column grid |
| Thresholds | Collapsible sections for detection thresholds, spam keywords, flair voting, and quiet hours |
| Anti-Raid Gates | Enable/disable and tune each gate (account age, karma, trust score, posts per day) |
| Danger Zone | Kill switch (pauses all automated actions), config reset |

The Config post recreates itself automatically if it is ever deleted or removed from the subreddit.

---

## Modmail Commands

Reply these commands to SubGuardian modmails to trigger actions:

| Command | Who can use | What it does |
|---------|------------|--------------|
| `!recheck` | Any user | Re-scores a held post after the author edits it |
| `!raid` | Moderators | Activates Raid preset immediately from a spike alert |
| `!shadow-activate <keyword>` | Moderators | Promotes a shadow-audit keyword to your live spam filter |
| `!keyword add <word>` | Moderators | Adds a keyword to the spam list |
| `!keyword remove <word>` | Moderators | Removes a keyword from the spam list |
| `!keyword list` | Moderators | Lists all current banned keywords |
| `!vote config` | Moderators | Confirms a pending flair vote with optional custom settings |

---

## How Spam Scoring Works

| Signal | What it catches |
|--------|----------------|
| Duplicate title | Same or very similar title posted in the last 30 days |
| Duplicate body | Near-identical selftext posted recently |
| Banned domain | Link to a domain on your blocked list |
| Banned keyword | A word or phrase from your spam keyword list |
| URL in title | Link placed directly in the post title |
| High URL density | Body text is mostly links with little original content |
| ALL CAPS | Three or more all-caps words in the title |
| Excessive punctuation | Three or more consecutive `!` or `?` marks |
| Very new account | Account created less than 7 days ago |

Each signal adds to a score between 0 and 1. Your auto-flag and auto-remove thresholds control what happens at each level. Users with higher trust scores get a discount applied to their final score.

---

## Automated Alerts SubGuardian Sends

- **Post volume spike** — current hour is 2.5× the 4-week baseline
- **Toxicity surge** — comment toxicity is significantly above normal
- **Possible ban evasion** — new account with a username similar to a banned account
- **Coordinated reporting (CIB)** — 3+ reports on the same post within 5 minutes
- **Redis memory warning** — storage approaching the 500 MB limit
- **Shadow-audit digest** — 24-hour report on what a test keyword would have caught
- **Weekly top contributor** — stickied highlight post every Sunday

---

## Getting SubGuardian for Your Subreddit

SubGuardian is installed through the [Reddit Developer Platform](https://developers.reddit.com/). Once installed, open the subreddit menu to access the dashboard and config UI. No command-line setup is required for mods — SubGuardian runs entirely within Reddit.

The default configuration works out of the box with sensible thresholds. Most subreddits should review the **Thresholds** and **Spam Keywords** sections in the Config UI within the first week to tune it for their community.
