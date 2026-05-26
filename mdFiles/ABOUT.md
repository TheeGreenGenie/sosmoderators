# About SubGuardian

## Inspiration

The idea for SubGuardian came from a frustration I kept running into as someone who spent a lot of time in niche Reddit communities: moderation was either non-existent or a blunt instrument. Subreddits either had no automation at all — meaning spam and low-effort posts piled up until a mod happened to be online — or they leaned entirely on AutoModerator, Reddit's built-in rule engine, which required mods to write and maintain complex regex rules most people didn't know how to write. The result was one of two failure modes: too permissive (spam everywhere) or too aggressive (legitimate users getting caught in blanket keyword filters with no explanation and no recourse).

What really crystallized the idea was watching a subreddit I liked go through a raid. A coordinated group of accounts started flooding the feed with off-topic posts. The mods had no early warning system, no quick way to raise the gates, and spent the next two hours manually removing posts one by one. By the time they'd caught up, a bunch of legitimate users had their posts buried. That shouldn't happen in 2026. The signals for a coordinated post spike are detectable early — you just need a system watching for them.

I also noticed that most moderation bots focused purely on enforcement: detect bad thing, remove bad thing. There was almost nothing that helped mods *understand* their community — what their members were actually posting about, who the most trustworthy contributors were, whether their thresholds were calibrated correctly. SubGuardian was built to do both: enforce automatically where it can, and surface insight where it can't.

The decision to build on Devvit — Reddit's official developer platform — came naturally. Devvit apps run inside Reddit itself. There's no server to maintain, no OAuth dance, no webhook endpoint to expose. Everything lives inside Reddit's infrastructure, scoped to a single subreddit, and mods interact with it through a custom post that lives in their sub. That constraint turned out to be both the most interesting and the most difficult part of the whole project.

---

## How I Built It

### Starting with the data model

The first thing I did — before writing a single trigger or UI component — was design the Redis schema. Devvit gives each subreddit app a sandboxed Redis instance capped at 500 MB, and every key you write has to be deliberate because you can't just query by pattern at scale. I created `src/redis/schema.ts` as a single source of truth for every key name in the system. No raw string keys exist anywhere else in the codebase. Everything goes through the `Keys` object. That discipline made a huge difference later when I needed to add new keys, change key formats, or reason about what was actually stored.

The schema covers about a dozen distinct namespaces: user trust records, post spam scores, daily and hourly counters, leaderboards (sorted sets), configuration, audit log, flair proposals, shadow audit state, Coach conversation history, and rate limit queues. Each namespace has a corresponding TypeScript interface defined in the same file, so the shape of every object is documented next to the key that stores it.

### The spam detection pipeline

The core feature is spam scoring. Every post that enters the subreddit goes through a pipeline in `src/triggers/postSubmit.ts` that runs nine independent signal checks — duplicate title, duplicate body, banned domain, banned keyword, URL in title, high URL density, excessive caps, excessive punctuation, and very new account. Each check returns a weight between 0 and 1. The weights sum (capped at 1.0), and then a trust discount is applied based on the author's trust tier. The final score is compared against two configurable thresholds: auto-flag (default 0.65) and auto-remove (default 0.85).

What I wanted to avoid was a system that was opaque. When a post gets flagged or removed, the author receives a PM that lists exactly which signals fired, shows the score vs. the threshold, and gives a concrete suggestion for what to fix. It ends with `!recheck` — a command they can reply with after editing their post. SubGuardian re-runs the scoring automatically. If it passes, the post goes live without any mod intervention. This "recovery path" was important to me because the alternative — silently removing posts from legitimate users with no explanation — is one of the things that makes Reddit moderation feel hostile.

### Trust scoring

The trust system was the second major piece. I wanted a score that reflected a user's actual history in the subreddit, not just their global Reddit karma. The score (0–1000) is built from five components: account age, subreddit karma (logarithmic, to prevent gaming), approval rate (posts approved per total posts), positive signals (awards, top posts, helpful reports, adopted flair proposals), and penalties (removed posts, actioned reports against the user, bans). The score updates after every moderation event.

Trust feeds into spam detection as a discount multiplier rather than a gate. A user at 700+ trust gets their spam score multiplied by 0.6 — so a post that would normally score 0.9 (auto-remove) becomes 0.54 (below the flag threshold). This lets established contributors post freely while still catching clear spam from them if it's egregious enough. Trust also affects how their reports are weighted: a Trusted user's report counts 1.5×, an Untrusted user's report counts 0.5×.

The weekly trust decay job applies a 5% monthly decay to inactive users (90+ days without posting). This prevents old accounts from accumulating trust passively and then using it to post spam. There's a floor — trusted users don't decay below 300 — so the system rewards long-term good behavior without punishing occasional absence.

### The AI layer

I built three separate AI-related subsystems, and I learned a lot about the difference between what sounds like AI and what actually works in production.

The flair detection system (`src/ai/heuristic.ts`) classifies posts into 15 content categories using a weighted keyword scoring system. Each category has strong keywords, medium keywords, bigrams, and regex patterns. The scoring weights are: strong term = 20 points, bigram = 16, pattern = 22, negation = −35, density bonus = +18 if 3+ strong terms fire. Confidence is expressed as a probability and compared against two thresholds: auto-apply at 0.8+, suggest at 0.4–0.79. Below 0.4, no flair is assigned. This runs without any external API call — it's fast, free, and works immediately after install.

The LLM path (`src/ai/llm.ts`) is a thin wrapper that calls an external API if configured. It falls back to the heuristic on any error — network failure, auth failure, malformed response, timeout. The key design decision was making the LLM purely additive: the heuristic works fine on its own, and the LLM just makes free-form Coach questions better.

The Coach tab (`src/ui/dashboard/Coach.tsx`, `src/ai/coachHeuristics.ts`, `src/ai/coachContext.ts`) is a mod-facing Q&A system. Six quick-answer chips cover the most common questions (stats today, system status, explain trust, new mod guide, suggest spam keywords, review last flagged post). A free-text form handles anything else. The heuristic mode reads the subreddit's actual Redis data — trust records, audit log, daily stats, config — and formats a specific, grounded answer. The intent scoring system classifies queries into 12 intents and routes them to the appropriate handler.

### The dashboard

Building the dashboard was where I spent the most time fighting the platform. Devvit custom posts are fixed-height blocks — no scroll, no native text input, no free-form layout. Everything is a constrained grid of `vstack`, `hstack`, and `text` components. I had to think carefully about information density: how many posts fit in the Posts tab, how to make the leaderboard show enough entries, how to make the Config UI's threshold section usable without scrolling.

I ended up with six dashboard tabs (Overview, Pending Review, Posts, Leaderboard, Audit Log, Coach) and a separate Config UI with five sections (Presets, Features, Thresholds, Anti-Raid Gates, Danger Zone). Several sections are collapsible to recover vertical space. Features are displayed in a 3-column grid. The Thresholds section has four collapsible sub-sections. Posts and Leaderboard both use 2-column paired layouts so more entries fit on screen simultaneously.

One platform-specific problem that took longer than it should have: Devvit's `useState` hooks are positional. If a component uses `useState` internally, it must be called every render, in the same order. Early in development I had `PostPerformance` and `CoachTab` called conditionally inside the JSX based on which tab was active. Switching tabs would shift the hook positions and cause Coach to break silently. The fix was to always call both components unconditionally before the return, storing their output in a variable, then using the variable inside the JSX.

### Scheduled jobs

Seven background jobs run on timers: `aggregateBuilder` (every 15 minutes), `spikeDetector` (every 15 minutes), `trustDecay` (weekly), `flairVoteTallier` (hourly), `weeklyHighlight` (weekly), `raidModeExpiry` (every 6 hours), and `redisMonitor` (every 6 hours). An eighth job, `coachContextWarmup`, runs once on startup to pre-cache the Coach context so the tab loads instantly.

The aggregate builder does the most work: it computes 7-day rolling averages from daily counters, extracts and stems topic keywords from recent post titles, and selectively prunes any previously stored topic words that no longer pass the filter. The selective pruning was an interesting design challenge — rather than wiping the entire topic sorted set every 15 minutes (adjustable) (which would lose counts), it reads every existing member, applies the stemmer to get the canonical form, checks if it's valid, merges scores for un-stemmed forms into their stem (so "testing" and "tests" both fold into "test"), and only rebuilds the set if at least one invalid entry was found.

### Anti-raid and spike detection

The spike detector compares current-hour post volume against a 4-week rolling baseline. If the ratio exceeds 2.5×, it sends a modmail alert with a `!raid` command option so mods can activate lockdown mode with a single reply. Raid mode uses one of three presets — Default, Strict, or Raid — that progressively tighten account age, karma, and trust requirements for posting. Users above the Highly Trusted threshold (700+) always bypass raid gates.

Raid mode auto-expires after a configured duration. The expiry job checks the activation timestamp every 6 hours and deactivates automatically if the time has passed. This prevents mods from forgetting to turn it off.

### Modmail command parsing

Several features are driven by modmail replies: `!recheck` to re-score an edited post, `!raid` to activate raid mode from a spike alert, `!shadow-activate <keyword>` to promote a shadow-tested keyword to the live filter, and `!keyword add/remove/list` for managing the spam list. The modmail trigger parses the message body for command prefixes and dispatches to the appropriate handler. Commands that require mod authorization check the sender's mod status before executing.

---

## What I learned

**Redis is a database, not just a cache.** I went into this thinking Redis would be a simple key-value store for temporary state. By the end, it was doing sorted set ranking, sliding window aggregation, TTL-based expiry as a first-class feature, JSON serialization of nested objects, and atomic increment operations. Designing the schema carefully upfront saved me from a lot of pain. The 500 MB cap forced discipline — aggressive TTLs, rolling aggregates instead of full history, and a regular monitor job to surface when things were getting close.

**Platform constraints shape architecture.** The no-scroll, no-text-input Devvit blocks environment forced every UI decision. The "Ask a question" Coach interface couldn't be an inline text field — it had to be a form modal. The tab layout couldn't use infinite scroll — it had to use pagination and information density optimizations. These constraints were initially frustrating, but they pushed toward a cleaner design: fewer, more deliberate UI elements rather than everything at once.

**Heuristics beat LLMs for structured tasks.** The flair detector, intent scorer, and Coach heuristic answers all work better than I expected without any LLM. The keyword scoring system with bigrams, negation patterns, and density bonuses handles most cases cleanly. LLM integration became enhancement rather than foundation — which is exactly where it should be. This made the system cheaper to run, easier to reason about, and more reliable (no external API dependency for core features).

**Audit trails matter more than features.** Early builds had more features and less logging. I kept finding situations where I couldn't answer "why did that post get removed?" — and that inability to explain decisions made the whole system feel untrustworthy. The audit log system, the signal-by-signal PM explanations, and the case file UI all came from learning that transparency is not optional in moderation. Mods need to be able to explain and override every automated decision.

**Recovery paths keep users.** The first-time offender recovery window (hold the post, send a PM explaining what triggered it, open a 24-hour edit window, re-score on `!recheck`) was designed as an afterthought and turned out to be one of the most important features. Automated moderation without a recovery path alienates legitimate users. The fact that someone can fix their post and have it go live without mod intervention is better for everyone.

**Trust score design is subtle.** The early version of the trust score had too many edge cases: new users with lots of off-sub karma got too much trust; active users who occasionally posted borderline content got penalized disproportionately; old accounts that went dormant for a year still had high trust. The logarithmic karma cap, the grace period for first 5 posts, the 5% weekly decay with a floor, and the per-subreddit activity counters (rather than global Reddit stats) all came from iterating on these edge cases.

**Stemming is harder than it looks.** The light Porter-style stemmer handles about 80% of cases correctly. The remaining 20% are words where the suffix rules produce wrong results: "sting" → "st", "string" → "str", "goes" → "go" (which then fails the length check and gets dropped). The length floor (≥4 characters after stemming) catches most of the false positives, but some legitimate topic words get incorrectly collapsed. A full language model would do better; the tradeoff was speed and zero dependencies.

---

## Challenges

### The hook ordering bug

The most time I lost to a single bug was the Devvit `useState` hook ordering issue. Devvit's component model is similar to React — hooks are positional and must be called in the same order every render. I had conditionally rendered the `PostPerformance` and `CoachTab` components inside the tab-switching logic, which meant switching to the Posts tab and then to the Coach tab would silently corrupt the hook state. Coach would stop responding entirely, with no error message. The fix — always calling both component functions unconditionally before the JSX return and storing the result in a variable — is counterintuitive and underdocumented. It took a full debugging session to find.

### Devvit text input limitations

There is no inline text input component in Devvit custom posts. This sounds like a minor inconvenience but it affects multiple features: the Coach free-text question, keyword management, threshold tuning. Every input that needs free text requires a form modal — a separate UI surface that the user has to open, fill out, and submit. This adds an extra step to every interaction that would be trivial in a web app. The design workaround was making the chip-based quick answers in Coach cover the most common queries, so the form modal is only needed for genuinely custom questions.

### Redis selective topic pruning

The original topic pruning logic deleted the entire sorted set and rebuilt it from scratch every 15 minutes. This was simple but wrong — it destroyed counts that had been accumulated over days. The problem is that Devvit Redis has no `ZREM` that can remove by member name cheaply, and no server-side scripting. The solution was to read all members into memory, compute the canonical (stemmed) form of each, merge scores for equivalent forms into a map, and re-add only the canonical map entries — but only if at least one invalid entry was found. This avoids the rebuild cost entirely for sets that are already clean.

### Modmail race conditions

The modmail command handler is triggered by Reddit's event system, which can retry events if the handler doesn't respond within a window. This meant that a slow Redis write or Reddit API call could cause the same `!recheck` command to trigger twice — removing a post that was already being re-scored, or sending two identical PMs to the same user. The deduplication guard uses a 60-second Redis TTL key per event ID to catch and drop duplicate invocations. Every trigger checks this key first.

### The Config UI fitting problem

The Config UI started as a single scrollable list of settings. When Devvit's fixed-height constraint made that impossible, I restructured it into tabs. When the tabs still had too much content, I made sections collapsible. The Thresholds tab alone has four collapsible subsections (detection, spam keywords, flair voting, quiet hours) because there was no other way to make it fit. Each collapsibility toggle required a `useState` entry tracking which sections are open, which added state complexity. Getting the layout to feel usable — not just technically correct — took more iteration than any other part of the codebase.

### CIB detection thresholds

Coordinated inauthentic behavior detection (3+ reports on the same post within 5 minutes) has a high false-positive rate on posts that are genuinely controversial. A post about a divisive topic can hit the CIB threshold organically. The mitigation was adding a view count check: if the post has significant views (>100), the report ratio matters more than the raw count. This still isn't perfect — there are legitimate situations where it fires incorrectly — but it's calibrated to err toward notification (modmail alert) rather than automatic action.

### LLM integration without App Review

Reddit's App Review process is required before an app can make outbound HTTP calls from scheduled jobs or triggers. During development and testing, the LLM path exists but can't make real API calls from most contexts. The workaround is a stub that returns a structured failure response, causing the system to fall back to the heuristic automatically. This meant the heuristic layer had to be fully production-quality — not a placeholder — from the start, which was ultimately the right decision.

### Shadow audit mode state management

Shadow audit mode tests a keyword for 24 hours without enforcing it. The state involves: which keywords are in shadow mode, when shadow mode started, which keywords have already had their digest sent, and what posts would have been caught (stored in a sorted set per keyword). Managing this across a 15-minute job that runs repeatedly required careful sentinel checks — don't send a second digest if one was already sent since shadow mode started; don't accumulate posts beyond the 24-hour window; clean up shadow state when keywords are promoted to live. The state machine for this is spread across `src/redis/config.ts`, `src/jobs/aggregateBuilder.ts`, and `src/triggers/postSubmit.ts`, which made debugging it harder than it needed to be.

---

SubGuardian ended up significantly larger than I originally planned. What started as "a spam filter with a dashboard" became a full moderation platform with trust scoring, flair automation, appeal analysis, community leaderboards, shadow testing, raid detection, and an AI co-pilot. Each feature came from a real problem I wanted to solve, and each one surfaced a new constraint or edge case that required rethinking an earlier assumption. That iteration is visible in the codebase if you know where to look — in the audit trail that came after the feature coverage, in the recovery path that came after the enforcement, and in the heuristics that came before the LLM.

---

## Accomplishments that I'm proud of

**A fully working heuristic AI that needs no API key.** The Coach tab and flair detector both run entirely on pattern matching and Redis data — no external model, no latency, no cost. The flair detector classifies posts across 15 content categories using bigrams, negation patterns, and a density bonus system. The Coach answers 12 categories of mod questions with grounded, subreddit-specific data. Building something that felt genuinely intelligent without touching an LLM was the most satisfying technical outcome of the project.

**The trust system's depth.** A lot of moderation systems treat users as either trusted or not. SubGuardian's trust score is a continuous 0–1000 value built from five independent components — account age, subreddit karma (logarithmic), approval rate, positive signals, and penalties — that updates after every moderation event and decays for inactive users on a weekly schedule. The fact that trust feeds into spam scoring as a multiplier rather than a gate means the system gets more precise over time as it learns who the community's reliable contributors are.

**Shipping a complete moderation platform as a solo build.** SubGuardian covers spam detection, first-time offender recovery, trust scoring, ban evasion detection, coordinated behavior detection, anti-raid presets, shadow audit mode, flair automation, community voting, appeal analysis, a contribution leaderboard, a full audit log, an AI co-pilot, and a six-tab dashboard — all wired into Reddit natively through Devvit with no external server. Scoping, prioritizing, and actually shipping all of it alone is what I'm most proud of overall.

**The recovery path design.** Most moderation bots just remove posts. SubGuardian holds borderline posts, sends the author a PM that names exactly which signals fired and how to fix them, and opens a 24-hour edit window with a `!recheck` command. Legitimate users get a path back. That loop — flag, explain, fix, recheck, approve automatically — required coordinating the trigger, PM template, modmail handler, and re-scoring pipeline to all work together, and it does.

**Shadow audit mode.** The ability to test a new keyword for 24 hours without enforcing it, then receive a modmail digest showing exactly what it would have caught, gives mods real data to make decisions with instead of guessing. The digest shows post count, sample titles, and a one-command promotion path. It's a small feature in terms of lines of code but it closes a gap that essentially no other moderation tool addresses.

---

## What's next for SubGuardian

**Reddit App Review submission.** The LLM path for Coach currently stubs out its API call because outbound HTTP requires App Review approval. Once approved, the Coach tab will support fully open-ended questions — not just the 12 supported heuristic intents — by sending the subreddit's context to an LLM endpoint configured by the mod team. The heuristic layer stays as the fallback; the LLM becomes the upgrade path for power users.

**Cross-subreddit trust scores.** Right now each SubGuardian install is scoped entirely to one subreddit — trust earned in one community has no bearing on another. As more subreddits adopt SubGuardian as their all-in-one moderation tool, the natural next step is a shared trust layer: a user's reputation across the SubGuardian network could inform how strictly a new subreddit treats their first posts, making the onboarding experience smoother for genuinely good-faith contributors and tighter for accounts flagged elsewhere.

**Expanded autoflair category library.** The heuristic flair detector currently ships with 15 preconfigured content categories. Many subreddits — hobby communities, regional boards, professional forums — have topic distributions that don't map cleanly onto the current set. The next phase is expanding the category library significantly so that more subreddits can get accurate autoflair assignment out of the box without needing to configure anything at install time.

**Deeper configurability at onboarding.** SubGuardian currently ships with a fixed feature set that mods can toggle on or off individually. The next step is making the system genuinely configurable at a deeper level: during onboarding, admins would be walked through decisions about how trust scoring works in their subreddit (which signals earn or lose trust, what the tier thresholds are), and how spam management is tuned (which of the nine detection signals are active, and what weight each carries). Different communities have very different spam profiles — a link-sharing subreddit shouldn't penalize "URL in title" the same way a text-only community should — and giving admins that control at setup rather than burying it in constants would make SubGuardian meaningfully more adaptable across subreddit types.

**Mod team analytics.** The current dashboard surfaces community data — post volume, topic trends, top contributors. The next version should also surface mod team data: response time on flagged posts, which mods are most active, whether the queue is backing up. This would help mod teams identify coverage gaps and distribute load more evenly.
