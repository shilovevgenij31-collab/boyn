# Trend Radar — Technical Implementation Plan

Status: **Phase 0 in progress**. Plan approved 2026-09-12; amended 2026-09-12 (see §29 ADR-019–023).
Confirmed constraints from the owner:

| Decision | Answer |
|---|---|
| Provider scraping budget | **~$0–10 / month** (free tiers first) |
| Scheduling | **Vercel Hobby + external cron** (cron-job.org) |
| Region | **Global / English-first now, `market` column reserved from day one** |

**Market vs. language.** `market` is a geographic/audience scope (`global`, `US`, `ES`, `RU`, …),
not a language. `language` is a separate, optional dimension (`en`, `es`, `ru`, …) that may be
`null`/unknown for the MVP. `"global"` is a real market value — undifferentiated worldwide
discovery — not a placeholder meaning "no market configured." See ADR-020.

---

## 1. Executive architecture recommendation

A **modular monolith**: one Next.js (App Router) project on **Vercel Hobby**. It contains
thin HTTP adapters (Telegram webhook, cron tick, provider webhooks) over a
**framework-free TypeScript core**. Persistence is **Neon Postgres** via **Drizzle ORM**.
Social data comes from **commercial scraper APIs behind a job-shaped
`SocialDataProvider` interface**. **Bright Data** is the primary provider and **Apify** is both the
fallback and a stackable free tier.

Main points:

1. **Everything is asynchronous and tick-driven.** Both vendors' hashtag discovery runs as an
   async job, taking minutes. Vercel Hobby functions die at 300 s. So the system never waits
   on a scraper inside a request. An external cron hits `/api/cron/tick` every 30 min. Each
   tick is an idempotent state-machine step: plan → submit → poll → ingest → analyse →
   report. Provider completion webhooks speed this up, but polling is the source of
   truth. **No Redis, no queue:** Postgres rows with unique slot keys and lease columns act as
   the job queue.
2. **Postgres does the analytics.** Deterministic TypeScript scoring runs over data loaded
   from Postgres. Snapshots, hashtag co-occurrence and daily rollups are plain tables. No
   graph DB, no vector DB, no embeddings.
3. **No LLM on the critical path.** OpenRouter is an optional `TrendInsightProvider`. It
   only runs on `/ideas`, over at most 40 pre-ranked posts, and it degrades to a deterministic
   cluster summary.
4. **Budget-aware crawler.** A hard daily/monthly record ledger, tiered hashtag lifecycle,
   priority-based slot allocation, and free "piggy-back" snapshots whenever a known post is
   re-sighted. The default `LEAN` profile uses ~330 records/day, about $3–6/month.
5. **De-risk data access first.** Phase 1 is a paid-for-pennies **provider spike** that
   measures what the vendors return: post age distribution, fields and cost. It runs
   *before* the schema is frozen. Whether hashtag discovery returns *fresh* posts is the
   biggest unknown in the whole project, and no documentation answers it.

---

## 2. Architecture diagram

```
                     ┌──────────────────────────── EXTERNAL ─────────────────────────────┐
                     │  TikTok (public web)             Instagram (public web)          │
                     └───────────────┬───────────────────────────┬───────────────────────┘
                                     │ scraped by vendor         │
                     ┌───────────────▼───────────┐   ┌───────────▼───────────────┐
                     │ Bright Data Scraper API   │   │ Apify Actors              │
                     │ /datasets/v3/trigger      │   │ POST /acts/{id}/runs      │
                     │ snapshot_id → progress →  │   │ run → dataset items       │
                     │ snapshot  (+notify hook)  │   │ (+run webhooks)           │
                     └───────────────┬───────────┘   └───────────┬───────────────┘
            webhook (optional) ──────┼───────────────────────────┤ ◄── polled by tick
                                     │                           │
┌──────────────────────── VERCEL (Hobby) — Next.js modular monolith ──────────────────────────┐
│                                                                                              │
│  cron-job.org ──every 30m──► /api/cron/tick ─┐     Vercel native cron (1×/day) ──►          │
│                                              │     /api/cron/daily (report backup,           │
│  /api/webhooks/[provider] ───────────────────┤      dead-man check, retention)               │
│                                              ▼                                               │
│                         ┌──────────── jobs/ (orchestration) ─────────────┐                  │
│                         │ plan-discovery · plan-refresh · submit · poll  │                  │
│                         │ ingest · run-analytics · daily-report · retain │                  │
│                         └───┬───────────────┬───────────────┬────────────┘                  │
│                             │               │               │                                │
│         ┌───────────────────▼──┐   ┌────────▼─────────┐  ┌──▼───────────────────────────┐   │
│         │ providers/           │   │ core/normalize   │  │ core/analytics (pure)        │   │
│         │ SocialDataProvider   │──►│ canonical URL,   │  │ velocity · tiers · scores    │   │
│         │ registry: primary/   │   │ hashtags, Zod,   │  │ hashtag stats/states         │   │
│         │ fallback per platform│   │ quarantine       │  │ co-occurrence · clusters     │   │
│         │ budget ledger        │   └────────┬─────────┘  │ categories · lifecycle       │   │
│         └──────────────────────┘            │            └──┬───────────────────────────┘   │
│                                             ▼               ▼                                │
│                                   ┌──────────────────────────────────┐                      │
│                                   │ Neon Postgres (Drizzle)           │                      │
│                                   │ posts · post_snapshots · hashtags │                      │
│                                   │ tracked_hashtags · daily stats    │                      │
│                                   │ runs · provider_jobs · reports    │                      │
│                                   └───────┬──────────────────┬────────┘                      │
│                                           │                  │                               │
│          ┌────────────────────────────────▼───┐   ┌──────────▼───────────────────┐          │
│          │ core/report  → daily report JSON   │   │ insights/ (OPTIONAL)         │          │
│          │ exports: .md / .csv / .json        │   │ TrendInsightProvider         │          │
│          └────────────────┬───────────────────┘   │ → OpenRouter free models     │          │
│                           │                        │ skipped/failed ⇒ deterministic│          │
│                           ▼                        │ cluster summary               │          │
│   Telegram ◄──── /api/telegram/webhook ◄───────────┴──────────────────────────────┘          │
│   Bot API        commands · pagination · URL buttons → ORIGINAL tiktok.com / instagram.com    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. External API / provider findings (researched 2026-09-12)

### 3.1 Verified from current documentation / vendor pages

| Source | Finding | Consequence |
|---|---|---|
| **TikTok Research API** ([developers.tiktok.com](https://developers.tiktok.com/products/research-api)) | Eligibility limited to academic / not-for-profit public-interest researchers in eligible regions; commercial users explicitly ineligible. Reported lag: new videos up to **48 h** to be indexed, stats (views) up to **10 days** to update. | **Rejected** as primary source: ineligible, and far too stale for early detection. |
| **Instagram Graph API** hashtag search | Requires an IG professional account + app review; **30 unique hashtags per 7 days** per account; `top_media` / `recent_media` only; no view counts on other people's media. | **Rejected**: the tag quota alone kills a self-expanding tag system, and there are no views. |
| **Vercel functions** ([limits](https://vercel.com/docs/functions/limitations), updated 2026-08-24) | Fluid compute max duration: **Hobby 300 s**; Pro 800 s (1800 s beta). Payload 4.5 MB. Hobby 2 GB memory. | Every route must finish < 300 s → work is sliced into ticks with an internal 240 s deadline. |
| **Vercel cron** ([usage & pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), 2026-07-15) | 100 crons/project on all plans. **Hobby: minimum interval once per day, ±59 min precision**; more-frequent expressions fail deployment. Pro: per-minute. | Multi-daily collection on Hobby **must** use an external trigger. Native cron is used only for a daily backup/dead-man job. |
| **Apify platform** ([pricing](https://apify.com/pricing)) | Free: **$5 usage/month**, 5 concurrent runs, credits don't roll over, access **blocked** until next cycle once exhausted. Starter $19/mo. | The Apify free tier is a hard cap and has to be metered by our ledger. |
| **Apify API** | `run-sync-get-dataset-items` holds the connection ≤ 300 s (408 otherwise). Async runs + run webhooks supported. | Use async runs only. |
| **Apify `clockworks/tiktok-hashtag-scraper`** | **$5 / 1,000 results**; fields `playCount, diggCount, shareCount, commentCount, createTime, webVideoUrl, hashtags, music*, author*`; TikTok caps a hashtag at ~400–800 results. | Rich fields but ~3× Bright Data's price. |
| **Apify `clockworks/tiktok-scraper`** (input schema) | Supports hashtags, search queries, profiles, post URLs; **sorting "Latest"**, `oldestPostDateUniform` / `newestPostDate`, `videoSearchDateFilter`. | Only documented way to *force recency* on TikTok → key fallback if Bright Data discovery returns stale posts. |
| **Apify `apify/instagram-hashtag-scraper`** | ~$1.90–2.30 / 1,000 results; fields `url, shortCode, type, timestamp, likesCount, commentsCount, videoPlayCount, reshareCount, hashtags, musicInfo, ownerUsername`; posts **or** reels per run; `likesCount = -1` when hidden; **free plan fetches only the first results page**. | Fine for "newest ~15 per tag". Must map `-1` → `null`. |
| **Bright Data Scraper API** (docs + product pages) | TikTok Posts: collect by URL, **discover by keyword/hashtag**, discover by profile. Instagram hashtag scraper returns `url, user_posted, description, hashtags, num_comments, date_posted, likes, views`. Discovery is **async only**: `POST /datasets/v3/trigger` → `snapshot_id` → `/progress/{id}` → `/snapshot/{id}`; `notify` webhook; snapshots kept **30 days**. **$1.50 / 1K records PAYG, 5K records/month free**, "pay only for successful deliveries". `dataset_id`s come from the control panel. | Cheapest per record, first-party maintained, one mechanism for both platforms → **primary**. |
| **Instagram "views"** (vendor issue trackers, measurement write-ups) | Instagram exposes two different numbers: `playCount`/`videoPlayCount` (what the app shows) and `videoViewCount` (often null now). | Store `views_metric` provenance per post. **Never rank TikTok and Instagram views on one raw scale.** |
| **Neon free** | 100 CU-hours/month, **0.5 GB storage**, scale-to-zero after 5 min idle, wakes in ~hundreds of ms. | Fits if the tick cadence is ≥ 30 min and retention is enforced (see §13, §24). |
| **Supabase free** | 500 MB DB; whole project **pauses after 7 days of inactivity**; bundles Auth/Storage/PostgREST we don't need. | Viable but worse fit (§6). |
| **Telegram Bot API** ([setWebhook](https://core.telegram.org/bots/api#setwebhook)) | `secret_token` → sent as `X-Telegram-Bot-Api-Secret-Token` on every update. Message text ≤ 4096 chars. Practical limits ≈ 1 msg/s per chat, 20 msg/min per group, 30 msg/s global; 429 includes `retry_after`. | Paginate by *editing one message*; never burst 30 cards. |

### 3.2 Assumptions — to be verified in Phase 1 (provider spike)

| # | Assumption | Why it matters | Fallback if false |
|---|---|---|---|
| A1 | Bright Data TikTok hashtag/keyword discovery returns a meaningful share of posts **< 24 h old** | Early detection depends on it | Route TikTok discovery to Apify `tiktok-scraper` with `sorting=latest` + date filter |
| A2 | Instagram hashtag discovery (either vendor) returns recent reels with a play count | IG velocity | Accept a lower IG share; IG reels-specific actor |
| A3 | Bright Data's 5K free records are **account-wide** (conservative) | Budget math | If per-scraper, budget doubles for free |
| A4 | Results of a multi-hashtag job can be attributed back to the input tag | Enables 1 job per run instead of 1 per tag | 1 job per (platform, tag); only ~18 jobs/day, fine |
| A5 | Apify pay-per-result actors bill ≈ list price with no significant extra platform usage | Budget math | Spike reads actual cost from Apify usage API |
| A6 | Bright Data PAYG beyond the free 5K needs only a card on file | Budget | Stay on `FREE` profile |
| A7 | Collect-by-URL refresh works for both platforms at 1 record/post | Snapshot strategy | Refresh via re-discovery piggy-back only |
| A8 | OpenRouter free models are usable at ≤ a few calls/day | `/ideas` | Feature shows deterministic clusters only |

**Phase 1 decision gate:** if every provider's hashtag discovery has median post age > 72 h,
stop and re-plan discovery (keyword search with date filters / creator watchlist) before
building the rest.

---

## 4. Bright Data vs Apify — decision

| Criterion | Bright Data | Apify |
|---|---|---|
| TikTok hashtag discovery | Yes (keyword/hashtag discovery, async) | Yes (dedicated actor; **Latest sort + date filters** in `tiktok-scraper`) |
| Instagram hashtag discovery | Yes (hashtag scraper) | Yes (`instagram-hashtag-scraper`, posts *or* reels) |
| Freshness control | Unknown (A1) | **Documented** recency sort for TikTok |
| View counts | Yes (`views`, play counts for reels) | Yes (`playCount`, `videoPlayCount`) |
| Original post URLs | `url` | `webVideoUrl` / `url` + `shortCode` |
| Re-fetch known posts | Collect by URL | Actor with `postURLs` / `directUrls` |
| Execution model | trigger → snapshot, notify webhook | run → dataset, run webhooks |
| Price | **$1.50 / 1K**, pay only for delivered | $1.90–5.00 / 1K depending on actor |
| Free allowance | **5K records / month** | $5 / month credit (≈1–2.6K results) |
| Maintenance | First-party scrapers | Mixed; official + community actors |
| TS ergonomics | Plain REST (fetch) | REST or `apify-client` |
| Lock-in risk | Low behind our interface | Low behind our interface |

**Decision:**
- **Primary for both platforms: Bright Data.** Cheapest per record, largest free tier, one
  async mechanism, and it only bills delivered records.
- **Fallback + stacked free tier: Apify.** It takes over on errors, on circuit-open, or when
  a Bright Data cap is reached. It is also the designated fix if A1 fails for TikTok
  (`tiktok-scraper` with `sorting=latest`).
- Routing is **configuration** (`PROVIDER_<PLATFORM>_PRIMARY/FALLBACK`), finalised by the Phase 1
  spike numbers. It is not hard-coded.
- **Implementation depth is a post-spike decision (approved amendment, ADR-023).** The
  `SocialDataProvider` interface itself is mandatory for both vendors from Phase 4 onward. Whether
  *both* vendors get a full production adapter, or one gets a full adapter and the other a minimal
  one (just enough to serve as a real fallback), is decided from the Phase 1 spike's actual
  freshness/field/cost numbers — not assumed here. Phase 1's own scope stays a thin standalone
  script; it does not build adapters.

---

## 5. Vercel suitability

**Verdict: option B-lite.** Vercel hosts everything, but **scheduling comes from outside**
and **no request ever waits on a scraper**.

- ✅ Telegram webhook, route handlers, short analytics passes (ms–s), report generation, exports
  (built in memory — no `/tmp` persistence on serverless).
- ✅ Async provider jobs fit well: submit (≈1 s), poll (≈1 s), ingest one job's 15–60 items
  (≈1–3 s).
- ❌ Hobby cron can't run more than once/day → **cron-job.org** (free, 1-min granularity, custom
  `Authorization` header, failure e-mails) calls `/api/cron/tick` **every 30 min**.
- ✅ The Hobby native cron is still used **once per day** for `/api/cron/daily`: a backup trigger
  for the daily report, a dead-man's-switch that alerts the admin if the external tick hasn't
  fired in > 90 min, and a retention sweep.
- Every route: `export const dynamic = 'force-dynamic'`, `export const maxDuration = 300`, an
  internal `Deadline(240 s)` that stops loops cleanly and leaves the rest for the next tick, and a
  top-level try/catch that always returns **JSON** errors.
- Telegram handler: ack 200 fast, run the command body in `after()` (Next.js/Fluid) within the
  300 s budget.
- **Why not a queue / Redis:** the load is ~20 provider jobs/day. Postgres rows with a
  `UNIQUE(slot_key)` and `lease_until` columns give idempotency and mutual exclusion with no
  new infrastructure.
- **Why not a container host:** it would simplify long polling, but every piece of work is
  already short and async. Vercel gives zero-ops deploys and an easy path to a future web
  dashboard.
- ⚠️ **ToS flag (decided, noted once):** Vercel Hobby is intended for personal, non-commercial
  use. If a business team relies on the bot, moving to Pro ($20/mo) is a **zero-code change**:
  move the tick into `vercel.json` crons and optionally raise `maxDuration`.

**Neon compute check:** 48 ticks/day × ~5 min awake × 0.25 CU ≈ **1 CU-h/day ≈ 30 CU-h/month**,
well inside 100. A 10-min tick would approach the cap, which is why the tick stays at 30 min and
provider webhooks handle the fast path.

---

## 6. Database: Neon (chosen) vs Supabase

**Neon.** We need plain Postgres and nothing else.
- Scale-to-zero *compute* (wakes in ms) instead of a whole-project pause after 7 idle days.
- A pooled connection endpoint that works well with serverless functions. No PostgREST, so
  none of its schema-cache drift problems. Drizzle migrations are the single schema source of truth.
- Branching: a `dev` branch for local work and a throwaway branch for migration rehearsal.
- Supabase's Auth/Storage/Realtime would be unused surface.
- Watch-item: **0.5 GB free storage** → enforced retention (§24) keeps steady state ≈ 100–150 MB.

Driver: Drizzle over `pg` (node-postgres) pointed at Neon's **pooled** URL. Tests use
**PGlite** (in-process Postgres, no Docker on Windows) through Drizzle's PGlite driver, so the
query API is identical.

---

## 7. Project structure

```
/
├─ CLAUDE.md                      # conventions for AI-assisted development (rules below)
├─ docs/  IMPLEMENTATION_PLAN.md · ADR.md · RUNBOOK.md · PROVIDER_SPIKE.md
├─ src/
│  ├─ app/                        # Next.js — THIN adapters only (parse, auth, call jobs/*)
│  │  ├─ api/telegram/webhook/route.ts
│  │  ├─ api/cron/tick/route.ts
│  │  ├─ api/cron/daily/route.ts
│  │  ├─ api/webhooks/[provider]/route.ts
│  │  ├─ api/health/route.ts
│  │  └─ page.tsx                 # static "bot is running" page; no dashboard yet
│  ├─ config/                     # ALL tunables live here, typed, versioned in git
│  │  ├─ env.ts                   # Zod-parsed env, fail fast on boot
│  │  ├─ taxonomy.ts              # seed tags, categories, keyword rules, generic stoplist
│  │  ├─ thresholds.ts            # viral tiers, velocity guards
│  │  ├─ scoring.ts               # weights, half-life, clip bounds, SCORING_VERSION
│  │  ├─ lifecycle.ts             # promotion/demotion rules, pool caps
│  │  ├─ budget.ts                # FREE / LEAN / STANDARD profiles
│  │  └─ schedule.ts              # slot times (UTC), tier intervals, report time/TZ
│  ├─ core/                       # framework-free; imports nothing from app/db/providers/telegram
│  │  ├─ domain/                  # Platform, NormalizedPost, PostTier, TrendState, TrackingTier…
│  │  ├─ normalize/               # canonical-url.ts · hashtags.ts · numbers.ts
│  │  ├─ analytics/               # velocity · engagement · robust-stats · post-tier ·
│  │  │                           # trend-score · rising-score · hashtag-stats · hashtag-state ·
│  │  │                           # cooccurrence · clusters
│  │  ├─ categories/classify.ts
│  │  ├─ lifecycle/tag-lifecycle.ts
│  │  ├─ scheduling/              # tag-selector · refresh-planner · budget
│  │  └─ report/                  # build-daily-report · export-md · export-csv · export-json
│  ├─ providers/
│  │  ├─ types.ts                 # SocialDataProvider + capability + job types
│  │  ├─ registry.ts              # per-platform primary/fallback, circuit breaker, caps
│  │  ├─ http.ts                  # the ONE fetch wrapper: timeout, retry, backoff, typed errors
│  │  ├─ brightdata/  client · provider · schemas · normalize-tiktok · normalize-instagram
│  │  ├─ apify/       client · provider · schemas · normalize-tiktok · normalize-instagram
│  │  └─ fixture/provider.ts      # deterministic fake for tests & local simulation
│  ├─ insights/  types · openrouter · prompt · schema
│  ├─ jobs/      tick · plan-discovery · plan-refresh · submit-jobs · poll-jobs · ingest-job ·
│  │             run-analytics · generate-daily-report · retention · deadline
│  ├─ db/        client · schema.ts (Drizzle) · repositories/* · seed.ts
│  ├─ telegram/  client · update-schema · router · callbacks ·
│  │             commands/{today,rising,filter,tags,status,ideas,export,refresh,track,help}
│  │             render/{card,page,escape,format}
│  └─ lib/       logger · clock · errors · deadline · result
├─ drizzle/                       # generated SQL migrations (committed)
├─ scripts/     provider-spike.ts · set-webhook.ts · set-commands.ts · dev-poll.ts · simulate.ts
├─ test/        fixtures/{brightdata,apify}/{tiktok,instagram}/*.json · unit/ · integration/
├─ vercel.json · drizzle.config.ts · vitest.config.ts · .env.example · .gitignore
```

**CLAUDE.md rules:**
- `core/` is pure and takes a `Clock`; no I/O.
- No `.catch(() => [])` around aggregators. Catch at the smallest unit and record the failure.
- Exhaustive `switch` with a `never` check on every enum (tiers, states, job status).
- All thresholds come from `config/*`.
- Every route returns JSON on error.
- Use Node scripts, not PowerShell `curl`, for any HTTP call carrying non-ASCII text.

---

## 8. Data model

Conventions: `bigint` identity PKs, `timestamptz` everywhere (UTC), Postgres enums through Drizzle,
`market text NOT NULL DEFAULT 'global'` wherever rankings/tags are market-specific.

### 8.1 Content

**`posts`** — one row per platform post, ever.

| column | type | notes |
|---|---|---|
| id | bigint PK | |
| platform | enum(`tiktok`,`instagram`) | |
| external_id | text | TikTok numeric video id; IG **shortcode** |
| market | text | default `global` — geographic/audience scope, not language |
| language | text null | optional; unknown/null in MVP |
| canonical_url | text | always `https://www.tiktok.com/@u/video/{id}` or `https://www.instagram.com/reel/{code}/` |
| content_type | enum(`video`,`reel`,`carousel`,`image`,`slideshow`) | ranking = video/reel only |
| creator_username, creator_external_id, creator_followers, creator_verified | | public metadata only |
| caption | text | |
| music_title, music_author, music_id | text null | |
| duration_s | int null | |
| published_at | timestamptz null | null ⇒ excluded from ranking |
| views, likes, comments, shares, saves | bigint null | **latest** observed (denormalised) |
| views_metric | enum(`tt_play_count`,`ig_play_count`,`ig_video_view_count`) | provenance |
| first_seen_at, last_seen_at, last_refreshed_at | timestamptz | |
| tier | enum(`VIRAL_QUALIFIED`,`EARLY_BREAKOUT`,`WATCH`,`NOISE`) | current |
| availability | enum(`ACTIVE`,`DELETED`,`PRIVATE`,`UNKNOWN`) | |
| vph, vph_kind (`OBSERVED`/`ESTIMATED`), velocity_confidence (`HIGH`/`MEDIUM`/`LOW`) | | latest velocity |
| trend_score, rising_score (smallint), score_components jsonb, scored_at, scoring_version | | latest score + breakdown (debuggable) |
| next_refresh_at | timestamptz null | paid refresh schedule |
| paid_refresh_count | smallint | cap 3 |
| discovered_via_hashtag_id | FK hashtags null | first discovery path |

Constraints and indexes:
- `UNIQUE(platform, external_id)` ← **the** dedup key
- `(platform, market, published_at DESC)`
- `(tier, published_at DESC) WHERE availability='ACTIVE'`
- `(next_refresh_at) WHERE next_refresh_at IS NOT NULL`

**`post_snapshots`** — the time series.
`id, post_id FK→posts ON DELETE CASCADE, observed_at, views, likes, comments, shares, source enum(DISCOVERY,REFRESH), provider_job_id FK null`.
- `UNIQUE(post_id, provider_job_id)`: re-ingesting the same job can't duplicate.
- Index `(post_id, observed_at DESC)`.
- Insert is skipped if the previous snapshot is < 15 min old with identical views.

**`post_hashtags`** — `post_id, hashtag_id, position smallint`; PK `(post_id, hashtag_id)`; index `(hashtag_id, post_id)`.

**`post_discoveries`** — provenance "found via which query". Needed for probe-yield rules and debugging.
`post_id, hashtag_id, provider_job_id, rank_in_results smallint, observed_at`; PK `(post_id, provider_job_id)`.

**`post_categories`** — `post_id, category enum, confidence real, source enum(TAG,KEYWORD,QUERY)`; PK `(post_id, category)`.

### 8.2 Hashtags

**`hashtags`** — global dictionary. `id, name text UNIQUE` (normalised: NFKC, lowercase, no `#`, ≤ 100 chars), `is_generic bool` (stoplist: fyp, foryou, viral, reels, explore, trending…), `is_blocked bool`, `first_seen_at, last_seen_at`.

**`tracked_hashtags`** — the crawl-budget entity. It is per platform and per market, because #ps5 behaves differently on TikTok and IG.

| column | notes |
|---|---|
| id, hashtag_id FK, platform, market | `UNIQUE(hashtag_id, platform, market)` |
| tier enum(`CORE`,`ACTIVE`,`EXPLORATION`,`DORMANT`) | **tracking tier** = how much budget it gets |
| source enum(`SEED`,`DISCOVERED`,`MANUAL`) | |
| priority real | selector ordering |
| trend_state enum(`BREAKOUT`,`RISING`,`ACTIVE`,`STABLE`,`FALLING`,`DEAD`,`NEW`) + trend_state_since | **display state** = what's happening (separate concept) |
| momentum real 0..1 | feeds TrendScore H-component |
| next_due_at, last_scanned_at, scans_total, probes_in_tier, consecutive_empty_scans | |
| tier_changed_at | hysteresis (≥ 24 h between tier changes) |

Index `(platform, market, tier, next_due_at)`.

**`hashtag_categories`** — `hashtag_id, category, source enum(SEED,KEYWORD,COOCCURRENCE,MANUAL,AI), confidence`; PK `(hashtag_id, category)`.

**`hashtag_daily_stats`** — history for day-over-day comparisons.
`date, platform, market, hashtag_id, posts_seen, watch_posts, viral_posts, breakout_posts, distinct_creators, viral_views_sum, median_vph, scans, trend_state, momentum`.
PK `(date, platform, market, hashtag_id)`; index `(hashtag_id, date)`. Today's row is upserted on every analytics pass.

**`hashtag_cooccurrence_daily`** — `date, platform, market, tag_a, tag_b, posts, viral_posts, views_sum`.
PK `(date, platform, market, tag_a, tag_b)`, `CHECK (tag_a < tag_b)`. Only posts with tier ≥ WATCH, generic tags excluded, ≤ 15 tags per post (≤ 105 pairs).

**`hashtag_tier_events`** — audit: `tracked_hashtag_id, from_tier, to_tier, reason, at`.

### 8.3 Scoring, jobs, reports, ops

**`scoring_baselines`** — `platform, market, metric, computed_at, n, median, mad, p10, p90`; PK `(platform, market, metric)`. Recomputed nightly.

**`collection_runs`**

| column | notes |
|---|---|
| id, kind enum(`DISCOVERY`,`REFRESH`,`MANUAL`) | |
| slot_key text **UNIQUE** | e.g. `discovery:2026-09-12T13:00Z` → idempotent planning |
| status enum(`PLANNED`,`RUNNING`,`COMPLETED`,`PARTIAL`,`FAILED`,`SKIPPED`) | |
| planned_at, started_at, finished_at | |
| budget_records, records_used | |
| stats jsonb | returned / new / deduped / viral / failed tags … |
| error_summary, triggered_by | |

**`provider_jobs`**

| column | notes |
|---|---|
| id, collection_run_id FK, provider, platform, job_type enum(`HASHTAG_DISCOVERY`,`POST_REFRESH`) | |
| external_job_id | `UNIQUE(provider, external_job_id)` |
| webhook_token | random; one per job |
| input jsonb | |
| status enum(`PENDING`,`SUBMITTED`,`RUNNING`,`READY`,`INGESTED`,`FAILED`,`TIMED_OUT`) | |
| attempts, next_poll_at, lease_until | lease = single ingester |
| submitted_at, completed_at, ingested_at | |
| records_returned, records_quarantined, cost_est_usd, http_ms, error | |

Index `(status, next_poll_at)`. The daily/monthly **budget ledger is a SQL view over this table**; there is no separate counter to drift.

**`daily_reports`** — `id, report_date, market, window_start, window_end, status(COMPLETE/PARTIAL), partial_reasons text[], payload jsonb, scoring_version, generated_at, delivered_at, telegram_message_ids`. `UNIQUE(report_date, market)`.

**`result_views`** — frozen ranked lists for stable pagination (`/rising`, `/tiktok`, `/cosplay`, …).
`id (short random text), kind, params jsonb, items jsonb, created_at, expires_at` (TTL 14 d).

**`ai_insights`** — `id, report_id null, input_hash, prompt_version, provider, model, status, raw_output text, parsed jsonb, error, latency_ms, created_at`. `UNIQUE(input_hash, prompt_version)`. The raw output is saved **before** parsing.

**`quarantined_items`** — raw provider items that failed Zod: `provider, platform, provider_job_id, payload jsonb, error, created_at` (TTL 14 d).

**`telegram_updates`** — `update_id PK, received_at` (webhook redelivery idempotency, TTL 7 d).

**`error_events`** — `at, scope, severity, message, context jsonb` (TTL 30 d; feeds `/status`).

**`app_settings`** — key/jsonb: `collection_paused`, budget override, provider circuit-breaker state, command cooldowns.

Deliberately **not** in the MVP:
- `creators` table: derivable from `posts` later.
- `users` table: env allowlist now.
- Per-score history table: the latest score is on `posts`, and daily values are frozen in `daily_reports`.

### 8.4 Deduplication and canonicalisation

- Dedup key is `(platform, external_id)`. URLs are **never** keys.
- **TikTok id:** provider `id`/`aweme_id`, else parsed from `/video/(\d+)`. Canonical = `https://www.tiktok.com/@{username}/video/{id}`.
- **Instagram id:** `shortCode`, else parsed from `/(reel|reels|p|tv)/([A-Za-z0-9_-]+)`. Canonical = `https://www.instagram.com/reel/{code}/` for video/reel, `/p/{code}/` otherwise.
- **Guards:** force https, strip query/fragment (`igsh`, `is_from_webapp`, …), host allowlist (`tiktok.com`, `instagram.com`). A provider/CDN URL can never become `canonical_url`; the item is quarantined instead.
- **Within a batch:** dedupe in memory first. Across runs: `INSERT … ON CONFLICT (platform, external_id) DO UPDATE` refreshes latest metrics and `last_seen_at`, and keeps `first_seen_at`.
- **Hashtags:** union of the provider `hashtags` array and caption regex `#[\p{L}\p{N}_]+` (unicode flag). Normalise, then dedupe.

---

## 9. Provider abstraction

One interface for both platforms, **job-shaped** because both vendors are asynchronous. A
synchronous `searchByHashtag()` would hide multi-minute waits inside a 300 s function. Platform
differences live in **per-(provider, platform) normalizers**, not in separate interfaces.

```ts
type Platform = 'tiktok' | 'instagram';
type ProviderId = 'brightdata' | 'apify' | 'fixture';

interface ProviderCapabilities {
  discovery: Record<Platform, { supported: boolean; recencySort: boolean; maxPerQuery: number;
                                multiQueryAttribution: boolean }>;
  refreshByUrl: Record<Platform, boolean>;
  billing: { usdPer1kRecords: Record<Platform, number>; freeRecordsPerMonth: number };
  webhooks: boolean;
}

interface DiscoveryJobInput {
  platform: Platform; market: string; country?: string;
  queries: { hashtag: string; hashtagId: number }[];
  limitPerQuery: number; recency: 'latest' | 'top';
}
interface RefreshJobInput { platform: Platform; posts: { postId: number; canonicalUrl: string }[] }

interface SubmittedJob { externalJobId: string; submittedAt: Date; estRecords: number }
type JobStatus =
  | { state: 'RUNNING' }
  | { state: 'READY'; itemCount?: number }
  | { state: 'FAILED'; retryable: boolean; message: string };

interface SocialDataProvider {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  submitDiscovery(input: DiscoveryJobInput, webhookUrl?: string): Promise<SubmittedJob>;
  submitRefresh(input: RefreshJobInput, webhookUrl?: string): Promise<SubmittedJob>;
  getStatus(externalJobId: string): Promise<JobStatus>;
  fetchResults(externalJobId: string, cursor?: string):
    Promise<{ items: unknown[]; nextCursor?: string }>;
  normalize(raw: unknown, ctx: { platform: Platform; observedAt: Date }):
    { ok: true; post: NormalizedPost } | { ok: false; reason: string; kind: 'DELETED'|'PRIVATE'|'INVALID' };
  cancel?(externalJobId: string): Promise<void>;
}
```

```ts
interface NormalizedPost {
  platform: Platform; externalId: string; canonicalUrl: string; contentType: ContentType;
  creator: { username: string; externalId?: string; followers?: number; verified?: boolean };
  caption: string; hashtags: string[];
  music?: { title?: string; author?: string; id?: string };
  publishedAt: Date | null; durationSec?: number;
  metrics: { views: number | null; viewsMetric: ViewsMetric; likes: number | null;
             comments: number | null; shares: number | null; saves: number | null };
  observedAt: Date;
}
```

Responsibilities:
- **`providers/http.ts`:** the single HTTP client. Timeouts (20 s), retries for network/5xx/429
  (3 attempts, 1 s → 4 s → 16 s + jitter, honours `Retry-After`), and typed `ProviderError`
  codes (`AUTH`, `RATE_LIMIT`, `QUOTA`, `BAD_INPUT`, `UPSTREAM`, `TIMEOUT`).
- **`providers/registry.ts`:** `resolve(platform, jobType)` returns primary, else fallback. The
  fallback is used when:
  1. the circuit is open (3 consecutive failed jobs for provider+platform → open 6 h),
  2. the provider's monthly cap from `budget.ts` is reached, or
  3. submit failed after retries.
- **Normalizers:** Zod-validate each item → `NormalizedPost`.
  - Missing counts → `null`, never `0`. IG `-1` → `null`.
  - Missing canonical id → quarantine.
  - A job with > 50 % quarantined items is flagged `DEGRADED` and alerts the admin. This is the
    schema-drift detector.

---

## 10. Collection pipeline (one scheduled discovery run)

Everything below runs inside short ticks. Each step is idempotent and resumable.

1. **Tick auth + heartbeat.**
   - `Authorization: Bearer CRON_SECRET` (timing-safe compare).
   - Write `app_settings.last_tick_at`.
   - Abort cleanly if `collection_paused`.
2. **Plan (if a slot is due).** `INSERT collection_runs(slot_key) ON CONFLICT DO NOTHING` → only one planner wins.
3. **Budget.** `remaining = min(profile.perRun, dailyCap − usedToday, monthlyCap − usedMonth)`. If ≤ 0, the run is `SKIPPED(budget)` and shows up in `/status`.
4. **Select tags.** `core/scheduling/tag-selector`:
   - Due `tracked_hashtags` per platform, split into reservation classes (§12).
   - Ordered by `priority × overdue_ratio`.
   - Cut to the slot count.
   - Set `last_scanned_at`/`next_due_at` **now**, so a crash can't cause a double-billed rescan.
5. **Submit.** One provider job per (platform, tag), or per platform if A4 holds, via the
   registry. The webhook URL carries the job's `webhook_token`. Rows → `SUBMITTED`.
6. **Completion.**
   - Webhook path: `/api/webhooks/{provider}` validates the token. It **does not trust the
     payload**: it re-checks status via the provider API, then ingests in `after()`.
   - Polling path: each tick polls `SUBMITTED/RUNNING` jobs whose `next_poll_at ≤ now`, with
     backoff 2 → 5 → 10 → 20 min.
   - Timeout: `SUBMITTED` > 90 min → `TIMED_OUT`, call `cancel()`, and the run is `PARTIAL`.
7. **Ingest** (lease: `UPDATE … SET lease_until = now()+4min WHERE id=$1 AND (lease_until IS NULL OR lease_until < now()) RETURNING`).
   1. Fetch results page by page.
   2. Zod + normalise each item; failures go to `quarantined_items`.
   3. In-batch dedupe.
   4. **One transaction:** upsert posts → insert snapshots (`source=DISCOVERY`) → upsert
      hashtags + `post_hashtags` → `post_discoveries` → compute provisional post tier.
   5. Job → `INGESTED` with `records_returned`, `cost_est_usd`.
   6. Deleted/private markers → `availability` updated.
8. **Close the run.** When all jobs are terminal: status `COMPLETED`, or `PARTIAL` (some
   platform/tag failed; reasons recorded), or `FAILED` (nothing ingested).
9. **Analytics pass** (`jobs/run-analytics`, pure core + bulk SQL):
   1. Recompute velocity/tier/scores for posts seen in the last 72 h.
   2. Upsert today's `hashtag_daily_stats` and `hashtag_cooccurrence_daily`.
   3. Hashtag trend states + momentum.
   4. Categories for new tags/posts.
   5. **Lifecycle evaluation** (promote/demote, new EXPLORATION candidates).
   6. **Refresh planning** (set `next_refresh_at`).
10. **Observability.** Run stats are written. A `FAILED` run or a `DEGRADED` job → admin
    Telegram alert (rate-limited to 1/hour).

**Refresh runs** use the same machinery. Posts with `next_refresh_at ≤ now` are ordered by
refresh priority, cut to budget, batched into **one collect-by-URL job per platform**, and
ingested with `source=REFRESH`.
- A post whose URL errors 2× in a row → `DELETED/PRIVATE`.
- It is excluded from new rankings. It stays in frozen reports with a ⚠️ marker.

---

## 11. Dynamic hashtag discovery lifecycle

Two independent concepts:
- **Tracking tier** (`CORE/ACTIVE/EXPLORATION/DORMANT`) decides how much crawl budget a tag gets.
- **Trend state** (`BREAKOUT … DEAD`, §17) is what users see.

A CORE tag can be FALLING; a DORMANT tag can be seen RISING through co-occurrence.

```
   config seeds ──► CORE (never auto-demoted; interval tightens when its state is BREAKOUT/RISING)
                     
   candidate  ──► EXPLORATION ──(probes yield ≥2 viral/breakout posts from ≥2 creators,
   generation         │           OR trend_state ∈ {BREAKOUT,RISING})──► ACTIVE
                      │                                                  │
                      └──(2 probes / 4 days, criteria not met)──► DORMANT ◄──(state FALLING/DEAD ×2 evals,
                                                                   ▲  │        or 3 scans with 0 viral,
                         passive revival: ≥3 viral posts seen ────┘  │        or evicted by a stronger tag)
                         via other tags in 48h → EXPLORATION          └── weekly/biweekly probe if budget remains
```

- **Candidate generation** runs after each analytics pass. An untracked tag qualifies when it
  is not generic or blocked, has length ≥ 3, and appears in **≥ 2 VIRAL_QUALIFIED/EARLY_BREAKOUT
  posts by ≥ 2 distinct creators in the last 48 h**. Candidate priority = sum of those posts'
  TrendScores.
- **Anti-explosion caps (LEAN, per platform):**
  - EXPLORATION pool ≤ 8, ACTIVE pool ≤ 6.
  - ≤ 3 new EXPLORATION tags/day.
  - When a pool is full, a newcomer replaces the lowest-priority member only if it is stronger.
  - ≥ 24 h hysteresis between tier changes.
  - Every transition is logged to `hashtag_tier_events`.
- **Seeds.** `config/taxonomy.ts` lists each seed tag with its platforms and categories.
  - LEAN CORE (8 tags × 2 platforms): `cosplay, cosplayer, streamer, twitchstreamer, gaming, pcgaming, ps5, playstation`.
  - The remaining user seeds (`cosplaygirl, cosplayvideo, animecosplay, gamingcosplay, streaming, twitch, gamer, videogames, gameplay, gamingcommunity, pcgamer, gamingpc, pcbuild, steam, playstation5, ps5games, psgaming`) start as **DORMANT(source=SEED)** with weekly probes.
  - They are promoted like any discovered tag, so the budget flows to whichever seeds actually produce viral posts.
  - Admins can override with `/track #tag core|active` and `/untrack #tag`.

---

## 12. Collection schedule (exact, LEAN default)

All times UTC; stored in `config/schedule.ts`. The tick runs every 30 min and fires whatever is due.

| Job | When | Content |
|---|---|---|
| **Discovery run** | 05:00 · 13:00 · 21:00 | 6 tag-queries × 15 newest posts, both platforms mixed by priority |
| **Refresh run** | 01:00 · 09:00 · 17:00 | ≤ 20 posts per run (collect by URL) |
| **Daily report** | 06:00 (09:00 in `REPORT_TZ`, default `Europe/Moscow`) | after the 05:00 run is ingested |
| **Baselines + retention** | 06:30 via Vercel native daily cron (also backup report trigger + dead-man check) | |

Slots are 8 h apart so every region's peak passes through at least once: 21:00 covers the EU
evening and US afternoon, 05:00 catches overnight US growth, 13:00 covers EU daytime and the US
morning. Refresh runs land midway, which gives each fresh candidate a ~4 h observation interval.

**Slot allocation per discovery run (6 slots), with rollover:**
- 3 for CORE (the target interval of 48 h per pair tightens to 24 h if the tag is BREAKOUT/RISING),
- 2 for ACTIVE (target interval 24 h),
- 1 for EXPLORATION/DORMANT probes (EXPLORATION 24 h; DORMANT seed probe 7 d; discovered DORMANT 14 d).

Unused reservations roll over to the next class. The selector stretches intervals automatically
when budget is short, and `/status` shows actual coverage ("CORE pairs scanned in last 48 h: 14/16").

`STANDARD` for later: 4 discovery runs × 10 × 20, hourly-ish refresh of breakout candidates.
Switched with `BUDGET_PROFILE=STANDARD` and no code changes.

---

## 13. Request / cost budget

| Profile | Discovery | Paid refresh | Manual reserve | **Records/day** | Records/month | Est. cost/month* |
|---|---|---|---|---|---|---|
| `FREE` | 2 runs × 6 × 15 = 180 | 30 | 10 | **220** | ~6,600 | **$0** |
| **`LEAN` (default)** | 3 × 6 × 15 = 270 | 60 | 30 (unused → 0) | **≤ 360** (typ. 330) | ~10,000 | **≈ $3–6** |
| `STANDARD` | 4 × 10 × 20 = 800 | 200 | 50 | **1,050** | ~31,500 | ≈ $40 |

\*LEAN math: 10,000 records = Bright Data 5,000 free + Apify ≈ 2,200 free (≈$5 at ~$2.3/1K) +
≈ 2,800 Bright Data PAYG × $1.50 ≈ **$4.20**. That assumes A3 (account-wide free tier); if the
free tier is per-scraper, LEAN is ≈ $0. Hard stop: `BUDGET_MONTHLY_USD_MAX=10`.

Per-provider monthly caps are enforced by the ledger view. Apify is capped at its free credit so
the account is never blocked. When Apify's cap is hit, the registry routes to Bright Data PAYG,
using the same fallback code path as for errors.

Other resources at LEAN:
- ~20 provider jobs/day
- ~48 tick invocations/day
- Neon ≈ 30 CU-h/month
- DB growth ≈ 1 MB/day before retention
- Vercel invocations ≪ Hobby limits

**Honest trade-off:** at ≤ $10 each CORE pair is scanned about every 48 h, and `/rising` data is
up to ~8 h old (shown in the header). Early detection comes mostly from ACTIVE tags, free re-sight
snapshots and refreshes. For hour-level freshness, `STANDARD` is the lever.

---

## 14. Post snapshot strategy

1. **Free piggy-back snapshots:** every time a known post re-appears in discovery (any tag), a
   snapshot row is written at no extra cost.
2. **Paid refreshes** (collect by URL), only for posts that can still change a decision.

| Condition at analytics time | Next paid refresh |
|---|---|
| `EARLY_BREAKOUT`, age < 8 h | next refresh slot ≥ +3 h |
| `VIRAL_QUALIFIED`, age < 24 h | next slot ≥ +6 h |
| after 1st refresh, still qualifying, age < 48 h | +8 h, then +16 h |
| **stop** | age > 48 h · `paid_refresh_count = 3` · latest interval vph < 25 % of peak (decayed) · unavailable |
| `WATCH` | LEAN: piggy-back only. STANDARD: one refresh at +3 h for the top 20 by estimated vph (confirms sub-threshold breakouts) |

When candidates exceed the refresh budget, **RisingScore** decides priority: young, fast posts have
the highest information value.

---

## 15. Viral candidate logic

`config/thresholds.ts` (all configurable, evaluated in this order):

| Tier | Rule |
|---|---|
| **Data-quality exclusion** | `views` null · `published_at` null · non-video content · availability ≠ ACTIVE → stored, never ranked |
| **EARLY_BREAKOUT** | age 0.5–8 h **and** views ≥ 20,000 **and** vph ≥ 10,000 **and** (confidence ≥ MEDIUM **or** views ≥ 50,000) **and** engagement floor *if available* |
| **VIRAL_QUALIFIED** | views ≥ **100,000** and age ≤ 72 h |
| **WATCH** | age ≤ 24 h, views ≥ 5,000, vph ≥ 1,500 → piggy-back snapshots, may feed hashtag stats |
| **NOISE** | everything else — kept briefly (dedup + hashtag denominators), no refresh |

A post can be both EARLY_BREAKOUT and ≥ 100K. Then it is labelled `VIRAL_QUALIFIED` with a 🚀
breakout flag.

**Availability-aware engagement floor.** `comments ≥ 5 OR shares ≥ 10` applies only to whichever
of the two metrics the provider actually returned for that platform/item. A missing metric is
`null`, not `0`, and a `null` metric is dropped from the floor check rather than failing it:
- both available → floor applies to whichever is higher, as before.
- one available → floor applies to that one only.
- neither available → the floor is skipped and confidence is capped at **MEDIUM** (views/vph
  alone can't reach HIGH), not auto-rejected.
The same "missing ≠ zero, missing shrinks confidence or drops the component" rule governs every
tier and score decision in §15–16, not only this floor (approved amendment, see ADR-021).

Noise guards:
- The estimated-velocity age denominator is clamped to ≥ 1 h (50K views at 10 min must not read as 300K/h).
- Observed intervals must be ≥ 45 min; shorter ones are merged.
- Negative deltas → 0 plus a data-quality flag.
- The engagement floor, where available, rejects glitchy or botted spikes.
- Small creators are **not** penalised: a small account breaking out *is* the signal.

---

## 16. Trend Score (exact initial algorithm, `SCORING_VERSION = 1`)

### 16.1 Velocity

Treat publication as a virtual snapshot `(published_at, 0 views)`. Intervals come from
consecutive snapshots with Δt ≥ 0.75 h.
- `vph_current` = last interval's Δviews/Δh; `vph_prev` = the one before.
- If the only interval is the birth interval, velocity is **ESTIMATED** = `views / max(age_h, 1)`, confidence **LOW**.
- One real interval → **OBSERVED**, **MEDIUM**. Two or more → **HIGH**.
- Observed velocity is always preferred. The UI prints `+138K/h` (observed) vs `~92K/h est.`

### 16.2 Normalisation — robust z on log scale, per platform

Reference cohort per `(platform, market)`: posts first seen in the trailing 7 days with views ≥ 10K.
`median` and `MAD` are recomputed nightly into `scoring_baselines`. If n < 50, the config defaults
seeded from the Phase 1 spike are used.

```
z(x)  = clip( (x − median) / (1.4826 · MAD), −3, +5 )      # asymmetric: we care about upside outliers
σ(z)  = 1 / (1 + e^(−z))                                     # 0..1, median ⇒ 0.5
```

Why this approach:
- The logs tame the 100K–20M range.
- Median/MAD are robust to the heavy tails of viral data.
- σ keeps outlier magnitude until saturation, where percentile ranks would flatten it.
- Per-platform cohorts make TikTok and Instagram comparable without mixing their different
  `views` definitions.
- Scores are stable within a day and comparable across days, unlike normalising within the
  daily candidate set (where the best post of a bad day would be 100).

### 16.3 Components (each 0..1)

| Key | Formula | Weight (TrendScore) |
|---|---|---|
| **V** velocity | `σ(z(ln(1+vph_current)))`; if ESTIMATED, shrink toward 0.5: `0.5 + (s−0.5)·k`, `k = clamp(1 − age_h/48, 0.3, 1)` (a lifetime average overstates the *current* speed of older posts) | **0.35** |
| **R** reach | `σ(z(ln(1+views)))` | **0.20** |
| **E** engagement | `σ(0.20·z_like + 0.35·z_comment + 0.45·z_share)` where `z_x = z(ln((x+1)/(views+1)))` per platform (§16.4) | **0.15** |
| **F** freshness | `0.5^(age_h / 18)` (half-life 18 h: 2 h → 0.93, 12 h → 0.63, 24 h → 0.40, 48 h → 0.16) | **0.15** |
| **H** hashtag momentum | max `momentum` over the post's non-generic tags (§17), else 0 | **0.10** |
| **A** acceleration | only if confidence HIGH: `σ(log2(vph_current / vph_prev))` (2× ⇒ 0.73, flat ⇒ 0.5, halving ⇒ 0.27) | **0.05** |

```
TrendScore  = round(100 · Σ wᵢ·sᵢ / Σ wᵢ over AVAILABLE components)
RisingScore = same machinery, weights V .50 · A .20 · F .20 · E .10
```

A missing component (e.g. A without HIGH confidence, E without shares) drops out and the weights
renormalise, so missing data never counts as zero.

`score_components` jsonb stores raw x, z and s for each component. An admin-only `/why <rank>`
prints the breakdown.

Sanity checks from the brief:
- 220K @ 2 h beats 400K @ 22 h: higher V and F outweigh the lower R.
- 120K in 70 min → EARLY_BREAKOUT.
- 900K @ 23 h does not lead `/rising`.

### 16.4 Engagement rationale

Each ratio is z-scored against **its own platform distribution**. That removes scale differences
(shares are an order of magnitude rarer than likes) with no arbitrary multipliers such as "a share
is worth 5 likes". The 0.45 / 0.35 / 0.20 weights express signal strength instead:
- A **share** is a redistribution act, the strongest algorithmic signal.
- A **comment** takes effort and drives conversation.
- A **like** is low-effort and correlates with views.

IG's hidden likes (-1) and frequently-null reshare counts drop out and the weights renormalise.
Saves aren't reliably public and are excluded.

---

## 17. Hashtag trend algorithm

**Wording note (approved amendment, ADR-022).** The crawler observes a *sample* of TikTok/Instagram
via a bounded set of tracked tags and a limited daily record budget — never the full platform.
Every growth number below is computed from that sample. User-facing copy must say so explicitly
("Radar growth", "growth in monitored sample") and must never be phrased as a platform-wide claim
("#tag grew 214% on TikTok"). This applies to `/tags`, the daily report's hashtag sections, and
`hashtag_daily_stats`-derived comparisons in §19 and §22; the underlying field names
(`growthPct`, etc.) are unchanged — only the label shown to the user changes.

Rolling metrics per `(platform, market, tag)`, counting each post once regardless of which query
found it:
- `v24` = VIRAL_QUALIFIED + EARLY_BREAKOUT posts seen in the last 24 h
- `c24` = distinct creators among them
- `w24` = WATCH posts
- `b7` = mean daily `viral_posts` over the previous 7 days (only days since the tag's first sighting; < 2 days of history ⇒ `NEW`)
- smoothed growth `g = log2((v24 + 2) / (b7 + 2))`. The +2 prior stops 0 → 1 from reading as ∞ %.

Evaluated in order:

| State | Rule |
|---|---|
| 🚀 **BREAKOUT** | v24 ≥ 3 **and** c24 ≥ 3 **and** g ≥ 1.3 (≈ 2.5× smoothed) |
| 🔥 **RISING** | v24 ≥ 2 **and** c24 ≥ 2 **and** g ≥ 0.5 (≈ 1.4×) |
| 🔻 **FALLING** | b7 ≥ 1.5 **and** g ≤ −0.6 |
| 🟢 **ACTIVE** | v24 ≥ 2 |
| 🟡 **STABLE** | v24 ≥ 1 **or** w24 ≥ 3 |
| 💀 **DEAD** | no viral/watch posts in 72 h |
| ⚪ **NEW** | < 2 days of history (a NEW tag can still be reported as "🆕 breakout" when v24 ≥ 3 and c24 ≥ 3) |

- `momentum = σ(g) · (1 − e^(−v24/2))` ∈ 0..1. It feeds TrendScore H and lifecycle priority.
- Day-over-day display uses `hashtag_daily_stats`, e.g. "#jinxcosplay — Radar growth: 3 → 7 → 22
  viral posts in our monitored sample, +214 %, 🚀" (never "grew 214% on TikTok").
- **Effort bias** (ACTIVE tags are scanned more often) is reduced by counting posts from *any*
  scan path and requiring distinct creators. It is documented as a known limitation.

**Co-occurrence and clusters** (no LLM):
- For each pair over the last 3 days of posts ≥ WATCH: `jaccard = n_ab / (n_a + n_b − n_ab)` and `lift = P(ab) / (P(a)P(b))`.
- Edges with `viral_posts ≥ 2` and `jaccard ≥ 0.15` → connected components (in-memory union-find over a few hundred tags).
- The cluster label is its top tag by viral views. Output is shown as "Cosplay · Arcane: #arcane #jinx #jinxcosplay #vi — 9 viral posts".
- The same edges drive "related tags" and EXPLORATION candidates.

---

## 18. Category classification

Deterministic, multi-label:
1. **Seed mapping** from `taxonomy.ts` (confidence 1.0).
2. **Keyword rules** on tag names:
   - `cosplay` → cosplay
   - `stream|twitch|kick|live` → streaming
   - `ps5|playstation|psn|dualsense` → playstation
   - `pc(gaming|gamer|build|setup|master)|steam|rtx|nvidia|gamingpc` → pc
   - `gam(e|er|ing)|gameplay|videogame` → gaming
   - Confidence 0.9.
3. **Co-occurrence inference** for unknown tags: for each category, the share of the tag's posts
   (≥ 5 posts) that also carry a category tag. Assigned if ≥ 0.4 (confidence = share).
4. **Post categories** = categories of its tags with confidence ≥ 0.5, plus caption keyword rules,
   plus the query tag's category.

The taxonomy has parents: `pc → gaming`, `playstation → gaming`, so `/gaming` includes pc and
PlayStation posts. The optional AI may suggest categories for unknown tags, stored with
`source=AI`, but nothing depends on it.

---

## 19. Daily report

`core/report/build-daily-report.ts` produces the JSON below. It is frozen in
`daily_reports.payload` and rendered to Telegram and exports.

**Today vs. Still Hot (approved amendment, ADR-019).** These are two report-time *windows* over
the same ranked pool, not a new persisted `PostTier`. `window.start`/`window.end` bound the
current 24 h report cycle:

- **TODAY** — `publishedAt` falls inside `[window.start, window.end)`. This is the primary daily
  Top 30 and is what fulfils the original "recent viral/breakout content" requirement. 24–72 h
  content is never silently folded into this list.
- **STILL HOT** — `publishedAt` is 24–72 h before `window.end` **and** the post still clears
  VIRAL_QUALIFIED or EARLY_BREAKOUT(confidence ≥ MEDIUM) as of *this* run (i.e. it hasn't died
  down). Reported separately, always visibly labelled with its true age.

`/rising` is unaffected by this split — it already ranks by current velocity regardless of
publish window — but every rendering of it must keep showing explicit age (already true via
`ageHours` / "3h 18m old" in the card), so a viewer never mistakes a Still-Hot-eligible post for
a same-day one.

```ts
DailyReport {
  schemaVersion: 1; scoringVersion: 1; reportDate; timezone; market;
  window: { start; end };                                       // the 24h TODAY window
  status: 'COMPLETE' | 'PARTIAL'; partialReasons: string[];      // e.g. "instagram: 2/3 runs failed"
  collection: { runs; runsFailed; postsScanned: { total; tiktok; instagram };
                uniquePosts; newPosts; snapshots; recordsUsed; estCostUsd;
                tagsScanned; tagsFailed: string[] };
  counts: { viralQualified; earlyBreakout; watch };
  distribution: { platform: Record<Platform, number>; category: Record<Category, number> };
  today: { top: ReportItem[] };   // Top 30, publishedAt within `window` — the primary daily list
  stillHot: ReportItem[];         // published 24-72h ago, still qualifying now; always age-labelled
  risingNow: ReportItem[];        // 10, velocity-ranked regardless of publish window
  hashtags: { breakout: TagItem[]; rising: TagItem[]; topByViralPosts: TagItem[];
              newlyTracked: string[]; demoted: string[] };
  clusters: { label; tags: string[]; viralPosts; viewsSum; sampleRanks: number[] }[];
  comparisons: { vsYesterday: { viralQualified: Delta; earlyBreakout: Delta; postsScanned: Delta } };
}
ReportItem { rank; postId; platform; url; creator; captionPreview; hashtags; categories;
             publishedAt; ageHours; window: 'TODAY' | 'STILL_HOT'; views; likes; comments; shares;
             engagementRate; vph; vphKind; confidence; trendScore; risingScore; tier;
             inYesterdayReport: boolean; components }
TagItem { tag; platform; state; v24; b7; growthPct; distinctCreators; medianVph; related: string[] }
```

**Today Top-30 selection:**
- Pool: VIRAL_QUALIFIED ∪ EARLY_BREAKOUT(confidence ≥ MEDIUM), `publishedAt` inside `window`, ACTIVE, video/reel only.
- Sort by TrendScore.
- Max 2 per creator.
- **Platform floor:** each platform gets min(available, 8) slots.
- Posts still hot from yesterday's TODAY list are **kept in Still Hot** (not dropped, not re-added
  to today's list) and flagged 🔁.

**Still Hot selection:** same pool rules, `publishedAt` 24–72 h before `window.end`, sorted by
TrendScore, capped at 15. It exists so a trend that hasn't died doesn't vanish from view the day
after it publishes, without diluting what "today" means.

If a platform failed entirely, the report is `PARTIAL` and says so at the top. It never pads with stale data.

---

## 20. Telegram UX

Access: `TELEGRAM_ALLOWED_USER_IDS` (team) + `ADMIN_TELEGRAM_ID`. Everyone else gets a polite
"private bot" reply. Report delivery goes to `TELEGRAM_REPORT_CHAT_ID` (a group or a DM).

| Command | Behaviour |
|---|---|
| `/start`, `/help` | what the bot does, command list, data-freshness note |
| `/today` | Message 1: header (date, window, COMPLETE/PARTIAL, scanned per platform, viral/breakout counts, Δ vs yesterday) + 🚀/🔥 hashtags + top 3 clusters. Message 2: **Today** Top 30 (published in the last 24h), paginated. Message 3, only if non-empty: **🕒 Still Hot** — 24-72h old posts still qualifying, clearly separated and age-labelled, never merged into Today |
| `/rising` | live RisingScore list: age ≤ 12 h, views ≥ 20K, vph ≥ 5K; confidence badge; header "data as of HH:MM"; every card shows exact age so it's never confused with a same-day Top-30 entry |
| `/tiktok`, `/instagram` | ranked pool of last 72 h filtered by platform, sectioned into Today / Still Hot the same way as `/today` |
| `/cosplay`, `/streamers`, `/gaming`, `/pc`, `/playstation` | category filters (gaming includes pc + playstation) |
| `/tags` | tracked + breakout hashtags with state, v24, growth, related tags |
| `/status` | health (§24) |
| `/ideas` | optional AI (§21); deterministic clusters if AI is off or failing |
| `/export` | .md + .csv + .json of the latest report (§22) |
| `/refresh [tiktok\|instagram]` *(admin)* | out-of-schedule discovery run within remaining budget; replies with budget left; 30-min cooldown |
| `/track #tag [core\|active]`, `/untrack #tag` *(admin)* | manual lifecycle override |
| `/why <rank>` *(admin)* | score component breakdown |

**Pagination:**
- 5 posts per page. One message, **edited in place** on navigation, so there is no spam.
- Keyboard: row 1 has five **URL buttons** `▶ 1`…`▶ 5` (open the original post directly; no
  callback round-trip). Row 2: `◀ Prev · 2/6 · Next ▶`.
- `callback_data` (≤ 64 bytes) = `pg:{viewId}:{page}`. It points at a frozen `result_views` row
  or daily report, so pages stay consistent and survive redeploys.

**Card** (HTML parse mode; every caption, username and tag **HTML-escaped**; link previews disabled):

```
🔥 <b>#1 · TikTok</b> · 🚀 BREAKOUT
<b>2.4M</b> views · <b>+138K/h</b> ✅ · 3h 18m old
Score <b>94</b> · ER 7.1% · 💬 4.2K · 🔁 18K
@username · cosplay, gaming
#cosplay #arcane #jinxcosplay
<i>Caption preview trimmed to 120 chars…</i>
<a href="https://www.tiktok.com/@username/video/7xxxxxxxxxxxxxxxxxx">Open original</a>
```

Confidence badges: ✅ HIGH · ◐ MEDIUM · ◌ LOW (estimated). Five cards ≈ 2.5K chars, safely under 4096.

**Sending:**
- `telegram/client.ts` is a thin typed fetch wrapper. Types come from `@grammyjs/types` (types only, no framework).
- 429 → wait `retry_after` if ≤ 10 s, else defer. 5xx → 3 retries.
- `update_id` dedupe on inbound. Ack 200 immediately, work in `after()`.
- **Local dev** uses `scripts/dev-poll.ts` (long polling through the same router), so no tunnel
  is needed. Production uses the webhook.

---

## 21. Optional OpenRouter flow

- **When it runs:** on `/ideas` only. Optionally, if `AI_AUTO_DAILY=true`, as a follow-up message
  after the daily report. Results are cached in `ai_insights` by `(input_hash, prompt_version)`,
  so repeated `/ideas` calls cost nothing.
- **When it's skipped:**
  - no `OPENROUTER_API_KEY`
  - the report has < 10 ranked posts
  - cooldown (1 call per report per 10 min)
  - circuit open after 3 failures
- **Input** (built by `insights/prompt.ts`, ~6–10K tokens): top 40 posts as compact JSON
  (`ref` = rank number, platform, caption ≤ 300 chars, non-generic hashtags, views, vph, ER, age,
  music title, categories, tier) + top 15 hashtags with states + deterministic clusters. No URLs;
  refs map back to posts on our side.
- **Output contract** (Zod):
  `{ ideas: [{ title, trend, observedPattern, hashtags[], references: number[], adaptation, confidence: 'low'|'medium' }] }`.
  - The raw text is saved first. Then fences are stripped, then it is parsed and validated.
  - Ideas citing refs that aren't in the input are dropped (anti-hallucination).
  - The prompt forbids claims about visuals, audio or transitions unless the caption states them.
  - Every message is prefixed with *"Metadata-based inference — the model saw captions, hashtags and metrics, not the videos."*
- **Models:** `OPENROUTER_MODELS` is an ordered list of free models, tried in order. Timeout 45 s.
- **Failure:** the user gets "AI insights unavailable — here are today's deterministic clusters and
  top references" from the same data. Nothing else is affected.

---

## 22. Export workflow (manual ChatGPT Pro analysis)

`/export` sends three documents via `sendDocument`, built in memory:

1. **`trends-YYYY-MM-DD.md`** (primary for ChatGPT upload).
   - A header block with a ready-to-paste analysis prompt, plus the metric definitions (so the
     external model interprets vph/score correctly).
   - Then the sections: overview · breakout/rising hashtags with day-over-day · clusters · Top 30
     table (rank, platform, creator, views, vph, age, score, tags, caption, URL) · rising list.
2. **`trends-YYYY-MM-DD.csv`**: the top 100 candidates, one row per post, flat columns, UTF-8 with
   BOM so Excel shows Cyrillic/emoji correctly.
3. **`trends-YYYY-MM-DD.json`**: the full `DailyReport` (schemaVersion'd) for programmatic re-analysis.

`/export 7d` (optional flag) → a 7-day hashtag history CSV from `hashtag_daily_stats`.

---

## 23. Reliability strategy

| Failure | Handling |
|---|---|
| TikTok fails, Instagram succeeds | Run `PARTIAL`; report status PARTIAL with reason; IG results still ranked |
| Bright Data / Apify outage | Retries (3, exp backoff) → registry fallback to the other vendor → circuit opens 6 h after 3 failed jobs |
| Rate limit / quota | `RATE_LIMIT` → back off and requeue for the next tick; `QUOTA` → cap reached, route to fallback |
| Very slow job | Polling backoff; `TIMED_OUT` at 90 min, `cancel()`, run `PARTIAL` |
| Malformed responses | Per-item Zod → quarantine; job `DEGRADED` if > 50 % bad → admin alert |
| Missing views / shares / date | `null`, never `0`; excluded or weight-renormalised (§15–16) |
| Deleted / private posts | 2 consecutive refresh errors → availability flag; hidden from new lists, ⚠️ in frozen ones |
| Duplicates | `(platform, external_id)` upsert; `UNIQUE(post_id, provider_job_id)` on snapshots |
| Cron misses | Next tick catches up (planner fires any past-due slot not older than 4 h); Vercel daily cron = backup report trigger + dead-man alert if last tick > 90 min |
| Overlapping ticks / webhook + tick | `slot_key` unique + row leases (`UPDATE … RETURNING`), no advisory locks (safe with pooled connections) |
| DB outage | Route returns JSON 503; cron-job.org logs failure; Telegram retries delivery itself; bot replies "⚠️ database unavailable" when possible |
| Telegram failure | 429 `retry_after`, 5xx retry; report `delivered_at` set only on success; the next tick re-attempts undelivered reports |
| OpenRouter outage | Deterministic fallback text; no other effect |
| Function timeout | `Deadline(240 s)` checks in every loop; unfinished work stays in DB state for the next tick |

Principles:
- **Idempotency everywhere:** re-running any tick, webhook or ingest yields the same DB state.
- **Never fake success:** `COMPLETE` only if every planned job ingested.
- **Catch small, record failures:** no swallowing at the aggregator level.

---

## 24. Security, logging, `/status`, retention

**Security**
- Secrets only in env (Vercel project env + local `.env.local`, git-ignored). `.env.example` is committed. `config/env.ts` validates on boot.
- **Telegram webhook:** `X-Telegram-Bot-Api-Secret-Token` timing-safe check → 401. `allowed_updates=[message, callback_query]`. User allowlist. Admin commands check `from.id === ADMIN_TELEGRAM_ID`.
- **Cron routes:** `Authorization: Bearer CRON_SECRET`. Vercel native cron sends it automatically when `CRON_SECRET` is set; cron-job.org sends it as a custom header.
- **Provider webhooks:** per-job random `webhook_token` + shared `PROVIDER_WEBHOOK_SECRET`. The payload is never trusted; the handler only triggers a status re-check through the provider API.
- **Output escaping:** all third-party text (captions, usernames) is HTML-escaped before Telegram. That text is attacker-controlled.
- **Rate limits:** cooldowns on `/refresh`, `/ideas`, `/export`.
- **Data minimisation:** public metadata only. No media downloads, no rehosted thumbnails, no personal data beyond public handles/follower counts, with bounded retention.
- **Supply chain:** `npm audit` in CI; lockfile committed.

**Logging:**
- `lib/logger.ts` writes one-line JSON: `level, msg, runId, jobId, provider, platform, ms, count`.
- Vercel Hobby runtime-log retention is short, so **durable observability lives in the DB**
  (`collection_runs`, `provider_jobs`, `error_events`).

**`/status`:**

```
🟢 Trend Radar — status (13:47 UTC)
Scheduler: last tick 12 min ago ✅
Last TikTok discovery: 13:00 ✅ 90 posts · Instagram: 13:00 ⚠️ PARTIAL (1/3 tags failed)
Last refresh: 09:00 ✅ 18 posts · Last report: 2026-09-12 06:02 ✅ delivered
Today: 412 posts scanned (TT 268 / IG 144) · 37 viral · 6 breakout
Budget: 214/360 records today · 6,120/10,000 month · ≈ $2.10
Providers: brightdata ✅ · apify ✅ (fallback) · circuit: closed
Tracked tags: CORE 16 · ACTIVE 5 · EXPLORATION 7 · DORMANT 34
Coverage: CORE pairs scanned in 48h 14/16
Errors 24h: 2 (see /status errors)
AI: configured · last OK 2026-09-11
```

**Retention** (daily sweep; keeps Neon < 0.5 GB):

| Data | Kept |
|---|---|
| posts — NOISE | 14 d |
| posts — WATCH | 30 d |
| posts — VIRAL / BREAKOUT | 180 d (cascades snapshots/hashtags) |
| post_snapshots | 90 d |
| post_discoveries | 30 d |
| co-occurrence daily | 60 d |
| hashtag_daily_stats | 365 d |
| daily_reports | 365 d |
| provider_jobs / runs | 90 d |
| result_views, quarantine | 14 d |
| telegram_updates | 7 d |
| error_events | 30 d |

Estimated steady state ≈ 100–150 MB.

---

## 25. Testing strategy

Vitest throughout. `Clock` is injected everywhere, so time is deterministic.

- **Unit (pure core):**
  - canonical URL (tricky inputs: query strings, `/reels/`, `/p/`, missing username, CDN URLs → rejected)
  - hashtag extraction (unicode, emoji, trailing punctuation, generic stoplist)
  - number parsing ("1.2M", "-1", null)
  - velocity intervals (merging < 45 min, negative deltas, birth interval)
  - tier rules, robust stats (MAD = 0 fallback), each score component, weight renormalisation
  - hashtag states for every branch, lifecycle transitions + caps + hysteresis
  - tag selector and budget allocator
  - Telegram escaping, card length ≤ 4096, callback codec ≤ 64 bytes, pagination math
  - CSV/MD/JSON export shape
- **Golden scoring scenarios:** the brief's examples as named tests:
  - `220K@2h > 400K@22h`
  - `120K@70min ⇒ EARLY_BREAKOUT`
  - `900K@23h ∉ top of /rising`
  - `jinxcosplay 3→7→22 ⇒ BREAKOUT`
  - single-creator spam ⇏ BREAKOUT
- **Provider contract tests:** real sanitised responses captured in Phase 1 →
  `test/fixtures/{provider}/{platform}/*.json`. Normalizer(fixture) is snapshot-tested, and
  mutated fixtures (missing fields, `-1`, CDN URL, new field) prove quarantine/null handling.
- **Integration (PGlite via Drizzle, no Docker):**
  - migrations apply cleanly
  - **ingesting the same job twice ⇒ identical DB**
  - upsert keeps `first_seen_at`
  - snapshot dedupe
  - run state machine incl. PARTIAL/TIMED_OUT
  - lease contention (two concurrent ingests → one wins)
  - fallback routing on cap/circuit
  - retention cascade
- **End-to-end simulation:** `FixtureProvider` + `scripts/simulate.ts` replays 3 synthetic days of
  ticks (async jobs, a failed provider, a slow job), then asserts the report and hashtag states.
- **Telegram:** router tests feed `Update` JSON to a recording fake client and assert the outgoing
  API calls. Also covered: webhook rejects a bad secret, non-allowlisted user, admin gating,
  duplicate `update_id`.
- **CI** (GitHub Actions): typecheck · lint · unit · integration on every push.

---

## 26. Deployment plan

1. **Local:** Node 24 LTS (22 also fine), npm, `git init`. Copy `.env.example` → `.env.local`. Neon
   project with `main` + `dev` branches; the local env points at `dev`.
2. `npm run db:migrate && npm run db:seed` (taxonomy → `hashtags` + `tracked_hashtags`).
3. **Telegram:** create the bot via @BotFather. `scripts/set-commands.ts` registers the command
   list. Local run: `npm run dev:poll`.
4. **Providers:**
   - Bright Data account → API token → copy the TikTok-posts and Instagram-hashtag `dataset_id`s from the Scraper Library.
   - Apify account → API token.
   - Run `npm run spike` (Phase 1).
5. **Vercel (Hobby):** import the repo, set env vars (production + preview), deploy. `vercel.json`
   has **one daily cron**: `/api/cron/daily` at `30 6 * * *`.
6. **Webhook:** `scripts/set-webhook.ts` → `setWebhook(url, secret_token, allowed_updates, drop_pending_updates)`.
7. **cron-job.org:** one job every 30 min → `GET https://<app>/api/cron/tick` with the
   `Authorization: Bearer <CRON_SECRET>` header, failure e-mail on. Optionally a GitHub Actions
   hourly schedule as a second pinger; it's harmless because ticks are idempotent.
8. **Smoke test:** `/status` → admin `/refresh tiktok` → watch the run go `RUNNING → COMPLETED` in
   `/status` → `/rising` → force a report → `/today` → `/export`.
9. **Burn-in:** 3–7 days on `LEAN`. Review quarantine, cost per useful post and baseline
   distributions. Tune thresholds in `config/` (bump `SCORING_VERSION`).

---

## 27. Environment variables

| Variable | Req. | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon **pooled** connection string |
| `DATABASE_URL_UNPOOLED` | ✅ (migrations) | direct connection for drizzle-kit |
| `APP_BASE_URL` | ✅ | public URL for webhook callbacks |
| `TELEGRAM_BOT_TOKEN` | ✅ | |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | `secret_token` for setWebhook (A-Z a-z 0-9 _ -) |
| `ADMIN_TELEGRAM_ID` | ✅ | admin user id |
| `TELEGRAM_ALLOWED_USER_IDS` | ◻️ | comma list; admin always allowed |
| `TELEGRAM_REPORT_CHAT_ID` | ◻️ | default = admin DM |
| `CRON_SECRET` | ✅ | bearer for `/api/cron/*` |
| `PROVIDER_WEBHOOK_SECRET` | ✅ | shared secret for provider webhooks |
| `BRIGHTDATA_API_TOKEN` | ✅* | *at least one provider required |
| `BRIGHTDATA_DATASET_TIKTOK_POSTS` | ✅* | dataset id |
| `BRIGHTDATA_DATASET_INSTAGRAM_POSTS` | ✅* | dataset id (hashtag discovery + collect by URL) |
| `APIFY_API_TOKEN` | ◻️ | fallback provider |
| `APIFY_ACTOR_TIKTOK` | ◻️ | default `clockworks/tiktok-scraper` |
| `APIFY_ACTOR_INSTAGRAM` | ◻️ | default `apify/instagram-hashtag-scraper` |
| `PROVIDER_TIKTOK_PRIMARY` / `_FALLBACK` | ◻️ | default `brightdata` / `apify` |
| `PROVIDER_INSTAGRAM_PRIMARY` / `_FALLBACK` | ◻️ | default `brightdata` / `apify` |
| `PROVIDER_COUNTRY` | ◻️ | default `US` |
| `DEFAULT_MARKET` | ◻️ | default `global` |
| `BUDGET_PROFILE` | ◻️ | `FREE` \| `LEAN` (default) \| `STANDARD` |
| `BUDGET_MONTHLY_USD_MAX` | ◻️ | default `10` — hard stop |
| `BUDGET_APIFY_MONTHLY_USD_MAX` | ◻️ | default `4.5` (keeps the free account from being blocked) |
| `REPORT_TZ` | ◻️ | default `Europe/Moscow` |
| `REPORT_LOCAL_TIME` | ◻️ | default `09:00` |
| `OPENROUTER_API_KEY` | ◻️ | enables `/ideas` |
| `OPENROUTER_MODELS` | ◻️ | ordered comma list of free model ids |
| `AI_AUTO_DAILY` | ◻️ | default `false` |
| `AI_TIMEOUT_MS` | ◻️ | default `45000` |
| `LOG_LEVEL` | ◻️ | default `info` |

Thresholds, weights, seeds and schedules are **not** env vars. They live in typed `config/*.ts`,
reviewed in git.

---

## 28. Implementation phases

Each phase ends green (`typecheck + lint + test`) and is independently reviewable.

### Phase 0 — Bootstrap
- **Goal:** empty but production-shaped repo.
- **Files:** `package.json`, `tsconfig` (strict), ESLint/Prettier, `vitest.config.ts`,
  `src/config/env.ts`, `src/lib/{logger,clock,errors,deadline}.ts`, `src/app/api/health/route.ts`,
  `CLAUDE.md`, `.env.example`, `.gitignore`, CI workflow.
- **Depends on:** nothing.
- **Done when:** `npm run check` passes; `/api/health` returns JSON locally; git initialised.
- **Tests:** env schema rejects missing secrets; deadline behaviour.
- **Risks:** none significant.

### Phase 1 — Provider spike (decision gate) ⚠️ most important
- **Goal:** replace assumptions A1–A7 with measurements.
- **Files:** `scripts/provider-spike.ts` (standalone: minimal fetch calls, no DB),
  `docs/PROVIDER_SPIKE.md`, `test/fixtures/**`.
- **Work:** for each of Bright Data TikTok (hashtag + keyword discovery), Bright Data IG
  hashtag, Apify TikTok (`sorting=latest`), Apify IG hashtag (reels) → 3 tags × 20 results.
  - Record: **post age distribution (median / % < 24 h)**, field coverage (views, shares,
    createTime, URL form, id), latency to READY, billed cost, input attribution.
  - Also: one collect-by-URL refresh per platform.
  - Also: IG `views_metric` behaviour.
- **Depends on:** Phase 0, provider accounts.
- **Done when:** a routing decision is written; ≥ 5 sanitised fixtures per provider/platform
  committed; baseline defaults (median/MAD) estimated. Cost ≲ 400 records (inside free tiers).
- **Risks:** the gate fails (stale discovery) → re-plan discovery before Phase 2.

### Phase 2 — Domain core & normalisation
- **Goal:** turn any provider item into a correct `NormalizedPost`.
- **Files:** `core/domain/*`, `core/normalize/*`, `providers/types.ts`, `providers/*/schemas.ts`,
  `providers/*/normalize-*.ts`.
- **Depends on:** Phase 1 fixtures.
- **Done when:** all fixtures normalise; canonical URLs pass the host allowlist; nulls are preserved.
- **Tests:** unit + snapshot contract tests + mutated-fixture tests.
- **Risks:** vendor field drift → Zod + quarantine absorbs it.

### Phase 3 — Database
- **Goal:** schema, migrations, repositories, seed.
- **Files:** `db/schema.ts`, `drizzle/*`, `db/client.ts`, `db/repositories/*`, `db/seed.ts`,
  `config/taxonomy.ts`, `drizzle.config.ts`.
- **Depends on:** Phase 2 types.
- **Done when:** migrations apply to PGlite and the Neon `dev` branch; seed is idempotent;
  repository upserts are idempotent.
- **Tests:** integration (PGlite): uniqueness, upsert semantics, cascade, snapshot dedupe.
- **Risks:** pooled-connection behaviour on Vercel → verify the `pg` Pool + pooled URL pattern
  (and Vercel's pool-attach helper if available) with a deployed smoke route.

### Phase 4 — Provider adapters & registry
- **Goal:** submit/poll/fetch/cancel behind `SocialDataProvider` for both vendors; routing; budget ledger.
- **Files:** `providers/http.ts`, `providers/{brightdata,apify}/{client,provider}.ts`,
  `providers/registry.ts`, `providers/fixture/provider.ts`, `core/scheduling/budget.ts`,
  `config/budget.ts`.
- **Depends on:** Phases 2–3, and the **Phase 1 spike's routing/depth decision** (ADR-023):
  build a full adapter for whichever vendor(s) the spike selected as real production paths, and
  at minimum a working (not fake) minimal adapter for the other, sufficient to actually serve as
  fallback.
- **Done when:** a real discovery job for 1 tag per provider completes via a script and ingests
  into `dev`. Fallback works on a simulated cap/error; the circuit breaker opens and closes.
- **Tests:** http retry/backoff with a fake fetch; registry routing matrix; ledger math.
- **Risks:** provider async edge cases (partial snapshots, empty results) → fixture them.

### Phase 5 — Collection orchestration
- **Goal:** tick-driven pipeline end to end.
- **Files:** `jobs/{tick,plan-discovery,plan-refresh,submit-jobs,poll-jobs,ingest-job}.ts`,
  `core/scheduling/{tag-selector,refresh-planner}.ts`, `config/schedule.ts`,
  `app/api/cron/tick/route.ts`, `app/api/webhooks/[provider]/route.ts`.
- **Depends on:** Phase 4.
- **Done when:** `scripts/simulate.ts` (FixtureProvider) runs 3 days of ticks. Correct
  runs/jobs/posts/snapshots, PARTIAL on an injected failure, and no duplicates on replay.
- **Tests:** integration for the state machine, leases, idempotent planning, deadline cut-off.
- **Risks:** tick overlap → covered by leases; clock/slot edge cases → unit tests at slot boundaries.

### Phase 6 — Analytics & lifecycle
- **Goal:** velocity, tiers, baselines, TrendScore/RisingScore, hashtag stats/states,
  co-occurrence, clusters, categories, lifecycle, refresh planning.
- **Files:** `core/analytics/*`, `core/categories/*`, `core/lifecycle/*`,
  `config/{thresholds,scoring,lifecycle}.ts`, `jobs/run-analytics.ts`.
- **Depends on:** Phase 5 data.
- **Done when:** golden scenarios pass; a simulated 3-day run yields a plausible ranked list and at
  least one EXPLORATION → ACTIVE promotion and one demotion.
- **Tests:** exhaustive unit tests + golden tests; performance check (5K posts < 2 s).
- **Risks:** thresholds mis-calibrated for real data → tuned in Phase 11 (config only).

### Phase 7 — Reports, exports, retention
- **Goal:** `DailyReport`, MD/CSV/JSON exports, retention sweep, daily cron route.
- **Files:** `core/report/*`, `jobs/{generate-daily-report,retention}.ts`,
  `app/api/cron/daily/route.ts`, `vercel.json`.
- **Depends on:** Phase 6.
- **Done when:** report builds from simulated data; PARTIAL is propagated; exports open correctly
  (CSV in Excel with emoji/Cyrillic); retention deletes only what it should.
- **Tests:** report shape, top-30 rules (creator cap, platform floor), export snapshots, retention integration.
- **Risks:** report size → capped lists.

### Phase 8 — Telegram bot
- **Goal:** every command, pagination, auth, delivery.
- **Files:** `telegram/*`, `app/api/telegram/webhook/route.ts`,
  `scripts/{dev-poll,set-webhook,set-commands}.ts`.
- **Depends on:** Phase 7.
- **Done when:** in local long-poll mode against `dev`, all commands work. Pagination edits in
  place, URL buttons open the original posts, and non-allowlisted users are rejected.
- **Tests:** router/recording-client tests, escaping, 4096/64-byte limits, duplicate `update_id`.
- **Risks:** HTML escaping bugs with exotic captions → fuzz the escape function with fixture captions.

### Phase 9 — Production deployment & scheduling
- **Goal:** live bot on Vercel Hobby with external ticks.
- **Work:** Neon `main` migration, Vercel env, webhook set, cron-job.org job, provider webhooks, first live day.
- **Depends on:** Phase 8.
- **Done when:** 48 h unattended. Reports delivered both days, `/status` green, spend matches the ledger (±10 %).
- **Tests:** `RUNBOOK.md` smoke checklist; dead-man alert tested by pausing cron-job.org.
- **Risks:** Hobby ToS for commercial use (→ Pro switch), cold-start latency on the first command after idle (acceptable).

### Phase 10 — Optional AI (`/ideas`)
- **Goal:** OpenRouter insights with a deterministic fallback.
- **Files:** `insights/*`, `telegram/commands/ideas.ts`.
- **Depends on:** Phase 9 (real data).
- **Done when:**
  - with the key: ideas cite only valid refs and carry the metadata disclaimer;
  - without the key or with the provider down: the fallback message appears and nothing else changes.
- **Tests:** schema validation, unknown-ref dropping, fence stripping, timeout/fallback path, cache hit.
- **Risks:** free-model availability/limits change → ordered model list + cache.

### Phase 11 — Calibration & hardening (after ≥ 7 days of data)
- **Goal:** tune for real distributions.
- **Work:** compare baselines vs defaults; check the tier counts per day (target: 30–80 qualified,
  5–15 breakout); review quarantine; check cost per ranked post and CORE-pair yield (demote dead
  seeds); review the scoring components of the top 30 by eye.
- **Done when:** a `SCORING_VERSION = 2` config commit with a written rationale, and a budget
  profile decision.

---

## 29. Decision log (ADRs)

| ID | Decision | Why |
|---|---|---|
| ADR-001 | **PostgreSQL (Neon)**, not a document/graph DB | Relational joins (posts × tags × snapshots), unique constraints for dedup, window functions for stats; co-occurrence fits a pair table |
| ADR-002 | **No LLM on the critical path**; OpenRouter optional behind `TrendInsightProvider` | Cost ≈ 0, determinism, testability; the product must work when AI is down |
| ADR-003 | **Scraper vendors behind a job-shaped `SocialDataProvider`** with per-platform config routing | Vendors' access can break overnight (ToS pressure); both are async; swap without touching the core |
| ADR-004 | **Bright Data primary, Apify fallback + stacked free tier** | Lowest $/record, biggest free tier, pay-only-for-delivered; Apify offers documented recency sorting as the freshness escape hatch |
| ADR-005 | **Official TikTok Research API and Instagram Graph API rejected** | Commercial ineligibility + 48 h/10 d lag; 30 tags/week and no views |
| ADR-006 | **Vercel Hobby + cron-job.org tick every 30 min**; native cron only for daily backup/dead-man | Owner's cost choice; Hobby cron is ≤ 1/day; Pro is a zero-code upgrade |
| ADR-007 | **Tick-based state machine over Postgres rows; no Redis/queue** | ~20 jobs/day; unique slot keys + row leases give idempotency and exclusion |
| ADR-008 | **Next.js App Router, thin adapters over a framework-free core** | Vercel-native, future dashboard in the same app; the core stays portable to a worker later |
| ADR-009 | **Drizzle + node-postgres (Neon pooled); PGlite for tests** | Light serverless bundle, SQL-first, identical API in tests without Docker |
| ADR-010 | **Dedup on `(platform, external_id)`; canonical URLs built by us with a host allowlist** | URLs vary; provider/CDN links must never reach users |
| ADR-011 | **Snapshots on every sighting + budgeted paid refreshes; observed velocity preferred** | Real growth at minimal cost; estimated velocity is labelled and shrunk with age |
| ADR-012 | **Robust z-score on log metrics per platform (7-day reference), logistic squash, renormalised weights** | Scale-free, outlier-preserving, comparable across platforms and days, debuggable |
| ADR-013 | **Tracking tier ≠ trend state** | Budget allocation and user-visible momentum are different questions |
| ADR-014 | **Budget profiles + ledger view over `provider_jobs` with hard monthly caps** | One source of truth for spend; the Apify free account never gets blocked |
| ADR-015 | **Telegram: thin typed client, HTML mode, edit-in-place pagination, frozen `result_views`** | Minimal dependencies, stable pages, no spam, safe escaping |
| ADR-016 | **`market` column from day one (`global`)** | Adding markets later = config, not migration |
| ADR-017 | **No media downloads, public metadata only, bounded retention, private allowlisted bot** | Lower platform/ToS and privacy exposure; fits the 0.5 GB DB |
| ADR-018 | **Tunables in typed `config/*.ts`, secrets in env** | Thresholds are reviewed in git and versioned with `SCORING_VERSION` |
| ADR-019 | **Daily report splits into TODAY (published in the 24h window) and STILL HOT (24–72h, still qualifying)**, not one merged 72h Top 30 | The product requirement is *today's* best content; 24–72h posts are real signal but must never be silently mixed into "today" |
| ADR-020 | **`market` replaces the overloaded `locale` naming; `global` is a real market, not a null placeholder; `language` is a separate, optional, unused-in-MVP field** | Geography and language are different axes; conflating them would need a breaking rename once a second market or language is added |
| ADR-021 | **Missing engagement metrics are excluded from tier/score decisions, never coerced to 0**, applied explicitly to the EARLY_BREAKOUT engagement floor | A provider not exposing comments/shares for a platform must not disqualify an otherwise-strong post; it should lower confidence instead |
| ADR-022 | **All hashtag-growth copy is framed as "Radar growth" / observed within our monitored sample**, never as a platform-wide claim | The crawler samples a bounded set of tags at a bounded budget; it never sees the whole platform, so platform-wide phrasing would misrepresent the data |
| ADR-023 | **Per-vendor implementation depth (full vs. minimal adapter) is decided from Phase 1 spike results, not committed to upfront**; the `SocialDataProvider` interface itself remains mandatory for both | Building two full production adapters before knowing which vendor's discovery is actually fresh risks wasted work; the interface guarantees swappability either way |

---

## 30. Legal / platform risk (practical)

- TikTok and Instagram terms prohibit unauthorised automated collection. The **vendors** carry
  that operational risk. Bright Data has previously prevailed in litigation over scraping of
  *public, logged-out* data. That lowers our exposure but gives no guarantee of continued access.
  → ADR-003 (swappable vendors), ADR-004 (two vendors live).
- We never use our own accounts, cookies or logins, and never touch private content.
- Storing links and metrics, not media, keeps us out of copyright redistribution. Users open the
  post on the platform itself.
- Creator handles and follower counts are personal data under GDPR-style regimes. We keep the
  minimum, delete on schedule, and keep the bot private (allowlist), not a public data product.
- Prefer vendor-maintained scrapers. Community Apify actors are pinned to a build/version to
  avoid silent behaviour changes.

---

## 31. Scaling path

| Stage | Envelope | Architecture |
|---|---|---|
| **MVP (this plan)** | ≤ ~1K records/day, ≤ ~40 tracked tag-pairs, 1 market, ≤ 10 users | Vercel Hobby + cron-job.org, Neon free, LEAN |
| **Next threshold** | 5–30K records/day, 100–300 tags, several markets | Vercel Pro (native cron, 800 s), Neon Launch, `STANDARD`/custom profile, weekly co-occurrence rollups, monthly partitioning of `post_snapshots`; *no architectural change* |
| **Later** | 100K+/day, dashboard, many users, alerts | Move `jobs/` into a small always-on worker (same `core/`), pg-boss or Vercel Queues, materialised views, `users`/`watchlists` tables, dashboard pages in the same Next.js app, optional creator-watchlist discovery source |

Cheap choices made now so these steps don't require rework:
- `market` column
- platform-agnostic post model
- the job-shaped provider interface
- frozen `result_views`
- config-driven taxonomy
- the core has no framework imports

**Future features** (alerts, creator tracking, audio trends, transcripts/frames, weekly reports,
Slack/Discord/email) plug in as new `jobs/` + new renderers over the same tables. None is in MVP
scope. Proactive breakout alerts are the natural first follow-up, reusing the tier data that
already exists.

---

## 32. Open questions

**None block implementation.** The owner must provide these prerequisites before the phases that
need them:
- **By Phase 1:** Bright Data account (API token + two `dataset_id`s) and Apify account (token).
- **By Phase 3:** Neon project.
- **By Phase 8:** Telegram bot token and the admin's numeric Telegram id.
- **By Phase 9:** Vercel project and cron-job.org account.

Two items are **decided with stated defaults, confirm or override any time**:
1. `REPORT_TZ=Europe/Moscow`, report at 09:00 local.
2. Report destination = the admin DM, until `TELEGRAM_REPORT_CHAT_ID` points at a team group.

One item is **resolved by data, not by opinion**: the Phase 1 gate on discovery freshness (A1/A2).

---

## 33. Verification (how we'll know it works end to end)

1. `npm run check` — typecheck, lint, unit, integration all green.
2. `npm run simulate`: a FixtureProvider 3-day replay produces a COMPLETE report, one PARTIAL
   day on an injected failure, correct lifecycle transitions and zero duplicates on replay.
3. Phase 1 spike report committed with real numbers and a routing decision.
4. Staging (Neon `dev` + local long-poll bot): `/refresh`, `/rising`, `/today`, `/export`,
   `/status` all behave; every button opens a `tiktok.com`/`instagram.com` URL.
5. Production 48 h unattended: two reports delivered, ledger spend ≤ LEAN envelope, dead-man
   alert fires when cron-job.org is paused, `/ideas` falls back cleanly with the AI key removed.
