# Technologies Used

## Language

**TypeScript 5.4.5** — the entire codebase is written in strict TypeScript with ESLint enforcement. Type safety is applied end-to-end: every Redis value has a corresponding TypeScript interface defined in `src/redis/schema.ts`, every config shape is typed, and every AI response is validated before use. The project compiles to ES modules (`"type": "module"` in package.json) and runs on Node.js.

---

## Platform

**Devvit (Reddit Developer Platform) 0.12.23** — SubGuardian is built as a Devvit app, Reddit's official framework for building native extensions that run inside Reddit itself. Devvit provides:

- **Custom Posts** — interactive UI panels rendered directly inside Reddit using a declarative Blocks component system (similar to React but with a fixed-height, no-scroll constraint)
- **Event Triggers** — server-side hooks that fire on Reddit events: `PostSubmit`, `PostReport`, `CommentSubmit`, `ModMail`, `AppInstall`, `AppUpgrade`
- **Scheduled Jobs** — cron-style background jobs that run on a timer inside Reddit's infrastructure
- **Subreddit Menu Items** — native menu entries that appear in the subreddit sidebar for moderators
- **Form API** — modal overlay forms for collecting free-text input from users
- **Reddit API access** — built-in `context.reddit` client for reading posts, users, moderator lists, sending modmail, and managing flairs

No external server, no OAuth setup, no webhook endpoint. The app runs entirely inside Reddit's infrastructure, sandboxed to the subreddit it is installed in.

---

## Database

**Redis (Devvit-managed)** — each Devvit app installation gets a sandboxed Redis instance scoped to that subreddit, capped at 500 MB. SubGuardian uses Redis as its primary and only datastore, covering:

- **Strings** — configuration, kill switch state, scalar counters, last-built timestamps, cached averages
- **Hashes** — daily post/report counters (`HSET`/`HGET`/`HINCRBY`), spam score breakdowns
- **Sorted Sets** — leaderboards (trust score ranking, weekly contributions), audit log (scored by timestamp), topic frequency, shadow audit post lists, rate limit queues
- **TTL expiry** — used as a first-class feature throughout: audit log entries expire after 30 days, title/body hash caches after 30 days, deduplication guards after 60 seconds, rate limit windows after their configured interval

All Redis key names are centralized in `src/redis/schema.ts` — no raw string keys exist anywhere else in the codebase.

---

## Frameworks & Libraries

**Devvit Public API (`@devvit/public-api`)** — the sole npm dependency. Provides the full Devvit runtime: Blocks UI primitives (`vstack`, `hstack`, `text`, `button`, `image`), `useState` / `useAsync` hooks, the `context` object (Redis client, Reddit client, user/subreddit info), form registration, trigger registration, and job scheduling.

**No UI framework** — the dashboard and config UI are built directly with Devvit Blocks. There is no React, Vue, or any other frontend framework. Devvit's component model is similar to React (declarative, component functions, hooks) but is a separate system rendered server-side and serialized to Reddit's UI layer.

---

## AI & Machine Learning

**Heuristic keyword scoring system (custom-built)** — the primary AI layer for flair detection and Coach answers. No external model or API. Implemented in `src/ai/heuristic.ts` and `src/ai/coachHeuristics.ts`:

- 15 content category classifiers, each with strong/medium/weak keyword tiers, bigrams, regex patterns, and negation rules
- Weighted scoring: strong term = 20pts, bigram = 16pts, pattern match = 22pts, negation = −35pts, density bonus = +18pts
- Porter-style suffix stemmer (custom, zero-dependency) for normalizing topic keywords before scoring

**LLM API (optional, configurable)** — `src/ai/llm.ts` wraps an external LLM endpoint (endpoint URL and API key configured by the mod team in the Config UI). Used only for the Coach tab's free-text question path. Falls back to the heuristic automatically on any error. Currently stubbed pending Reddit App Review approval for outbound HTTP calls.

---

## APIs

**Reddit API (via Devvit context)** — accessed through `context.reddit`, the Devvit-provided Reddit client. SubGuardian uses:

- `getPostById`, `getTopPosts`, `getCommentById` — post and comment retrieval
- `getUserByUsername`, `getModerators` — user and moderator lookups
- `removePost`, `approvePost` — moderation actions
- `sendPrivateMessage` — user-facing removal PMs
- `modMail.createConversation`, `modMail.reply` — mod team alerts and digest reports
- `setPostFlair` — automatic flair assignment
- `submitPost` — creating dashboard, config, leaderboard, and vote posts
- `banUser`, `muteUser` — enforcement actions

**No third-party APIs** are used for core functionality. The LLM integration is an optional external HTTP call that the app will make once App Review whitelists it.

---

## Build & Tooling

| Tool | Purpose |
|------|---------|
| **TypeScript compiler (`tsc`)** | Type checking and compilation to ES modules |
| **ESLint** | Linting with `eslint-plugin-redos` to prevent regex denial-of-service patterns |
| **Devvit CLI (`devvit`)** | Local playtesting (`devvit playtest`), uploading to Reddit (`devvit upload`), app management |
| **Jest + ts-jest** | Unit testing for pure utility functions (scoring, stemming, entity extraction) |
| **Node.js** | Runtime environment for the compiled app |

---

## Infrastructure

SubGuardian has **no infrastructure to manage**. There is no:

- Cloud provider account (AWS, GCP, Azure)
- Server, container, or serverless function
- Database to provision or back up
- Domain or SSL certificate
- CI/CD pipeline (Devvit handles deployment via `devvit upload`)

All compute, storage, scheduling, and Reddit API access run inside Reddit's Devvit infrastructure. The 500 MB Redis cap and Reddit API rate limits are the only resource constraints.
