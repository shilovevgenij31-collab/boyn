# Trend Radar — Production Runbook

Practical operational reference for the deployed system. See
[docs/IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for architecture/design rationale — this
file is "how do I operate it," not "why is it built this way."

**No real secret values appear anywhere in this file.** Every example uses a placeholder.

## Production topology

```
cron-job.org ──every 30m──► POST /api/cron/tick   (external, high-frequency collection)
Vercel native cron ──1x/day──► GET /api/cron/daily (backup report + retention + dead-man check)
Telegram ──webhook──► POST /api/telegram/webhook   (bot commands, admin actions)
Next.js (Vercel) ──pg──► Neon Postgres              (all durable state)
```

- **Production origin:** `https://<project>.vercel.app` (not secret — filled in once deployed).
- **Database:** Neon Postgres (pooled `DATABASE_URL` for runtime, unpooled `DATABASE_URL_UNPOOLED`
  for migrations).
- **Hosting:** Vercel Hobby. Native Vercel cron is used ONLY for the once-daily
  `/api/cron/daily` — the 30-minute collection tick is external (cron-job.org), because Hobby's
  native cron cannot run more than once a day.

## Deployment

```bash
# From a machine with Vercel CLI logged in and the repo connected:
vercel --prod
```

Deployment is git-driven in the normal case: pushing to the connected repo's production branch
(or `vercel --prod` from a checkout) triggers a build. There is no custom build step — `next build`
is Vercel's default for this project.

**Rollback:** use the Vercel dashboard's Deployments list — every previous deployment is a
one-click "Promote to Production." There is no destructive migration rollback story; migrations
are additive/forward-only (see below), so rolling back the app code while the newer schema is
still in place is safe as long as no migration in between dropped a column the older code reads.

## Database migrations

```bash
npm run db:generate   # after changing src/db/schema.ts — regenerates drizzle/*.sql
npm run db:migrate    # applies committed migrations to DATABASE_URL_UNPOOLED
```

Migrations are committed SQL under `drizzle/` — `db push`/schema-diffing is never used against a
real database. Before applying to production, the full chain is rehearsed against a throwaway
PGlite instance (`test/integration/migrations.test.ts`, run automatically by `npm test`).

## Seed

```bash
npm run db:seed
```

Idempotently seeds the hashtag taxonomy (`src/config/taxonomy.ts`) into `market = global`.
Running it twice never duplicates rows or resets a tag's tier if lifecycle logic has already
moved it (`test/integration/seed.test.ts` covers both).

## Pausing / resuming collection

```bash
npm run collection:pause -- status
npm run collection:pause -- pause
npm run collection:pause -- resume
```

A paused tick still polls/ingests already-running provider jobs (no work is abandoned
mid-flight) but plans no new discovery/refresh work — no new paid provider calls. Use this before
any maintenance that touches provider credentials or budget config.

## Inspecting status

Fastest path: send `/status` to the bot from an authorized chat. It reads:
scheduler/last-tick timestamp, last TikTok/Instagram discovery, last refresh, latest DailyReport,
today's budget usage, provider circuit state, tracked-hashtag tier counts, and (admin only) recent
`error_events` — all from persisted state, with **no live provider API call**.

## Manually calling the tick (safely)

```bash
curl -X POST https://<production-origin>/api/cron/tick \
  -H "Authorization: Bearer <CRON_SECRET>"
```

Safe to call more or less often than the external 30-minute schedule, and safe to call
concurrently — durable per-job leases prevent overlapping invocations from doing duplicate work,
and a slot already planned this period is a no-op. It only submits NEW paid provider work when a
tracked hashtag/post is actually due; calling it again immediately after a successful run should
not create new provider jobs.

## Manually calling the daily job (safely)

```bash
curl -X POST https://<production-origin>/api/cron/daily \
  -H "Authorization: Bearer <CRON_SECRET>"
```

Runs analytics → generates/freezes today's DailyReport → runs retention → checks for a stale
scheduler. Each stage is isolated (a failure in one never corrupts collection state or blocks the
others). Safe to call more than once a day — report generation is idempotent per
`(report_date, market)`, and retention deleting nothing extra on a second run the same day is
expected, not a bug.

## Telegram webhook setup

```bash
npm run telegram:set-webhook -- --base-url=https://<production-origin>
npm run telegram:set-commands
```

`set-webhook` registers `https://<production-origin>/api/telegram/webhook` with
`secret_token = TELEGRAM_WEBHOOK_SECRET` and `allowed_updates: [message, callback_query]`. Never
put the secret in the URL — it travels only in the `X-Telegram-Bot-Api-Secret-Token` header, which
the route verifies with a timing-safe comparison.

### Returning to local long-polling (dev only)

Telegram refuses `getUpdates` while a webhook is registered.

```bash
npm run telegram:poll -- --delete-webhook
```

This explicitly clears the production webhook first — never done silently. To go back to
production webhook delivery afterward, rerun `telegram:set-webhook`.

## cron-job.org configuration

One job:

- **URL:** `https://<production-origin>/api/cron/tick`
- **Schedule:** every 30 minutes
- **Method:** `POST` (or `GET` — the route accepts both)
- **Headers:** `Authorization: Bearer <CRON_SECRET>` — never as a `?secret=` query parameter
- **Timeout:** generous enough for a Vercel Hobby function (the route itself enforces its own
  internal `Deadline` well under Vercel's hard limit, so it always returns before being killed)
- Enable failure email notifications if the cron-job.org plan supports them

## Vercel daily cron

Defined in the committed `vercel.json` — the only native Vercel cron in this project:

```json
{
  "crons": [{ "path": "/api/cron/daily", "schedule": "30 6 * * *" }]
}
```

Do not add a second, more-frequent native cron — Vercel Hobby cron is capped at once/day per job
and this project intentionally keeps the 30-minute tick external.

## Budget hard stop

`BUDGET_PROFILE` (default `LEAN`) sets a hard monthly USD ceiling — **$10/month** for LEAN unless
`BUDGET_MONTHLY_USD_MAX` overrides it lower. Once the ceiling (or the daily record limit) is hit,
`canSubmit`/`canSubmitToProvider` (`src/providers/budget.ts`) block further automatic submission
— computed fresh from persisted `provider_jobs` rows every time, never a separate in-memory
counter that could drift. This hard stop is never disabled for convenience, including during
testing.

## If Apify fails

- **TikTok discovery:** falls back to Bright Data automatically (primary=Apify, fallback=Bright
  Data) once Apify's circuit breaker opens (3 consecutive eligible failures → 6h open).
- **Instagram discovery:** has **no fallback provider** — if Apify is down, Instagram discovery is
  simply skipped for that tick (`PROVIDER_UNAVAILABLE`) until Apify recovers or the circuit
  half-opens. This is a deliberate architecture choice (Bright Data's Instagram support was never
  qualified), not a bug.
- **TikTok refresh (paid per-post refresh):** Apify only — Instagram has no refresh-by-URL
  capability in this system at all (`/refresh instagram` only ever does discovery, never a direct
  post refresh).

## Rollback / redeploy

1. Vercel dashboard → Deployments → pick a prior successful deployment → "Promote to Production."
2. If a bad deploy already wrote incompatible data, prefer a forward-fixing migration over
   reverting the database — Neon branching (see below) is the safety net for anything that isn't.

## Neon backup / recovery

Neon retains point-in-time recovery and branching without any extra setup on this project's plan
tier — see the Neon dashboard's "Restore" and "Branches" features for the current retention
window. This project doesn't run its own backup infrastructure; committed migrations (schema
reproducibility) and frozen `daily_reports` payloads (historical report reproducibility even if
underlying `posts` rows are later pruned by retention) are the two mechanisms this system already
relies on for reproducibility.

## Secret rotation

Rotating any of these requires only an env update + redeploy — never a code change:

| Variable | Rotation note |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Update env, redeploy, then rerun `telegram:set-webhook` (a new token needs its webhook re-registered) |
| `TELEGRAM_WEBHOOK_SECRET` | Update env, redeploy, then rerun `telegram:set-webhook` |
| `CRON_SECRET` | Update env, redeploy, then update the header value in cron-job.org's job config |
| `PROVIDER_WEBHOOK_SECRET` | Update env, redeploy |
| `APIFY_API_TOKEN` / `BRIGHTDATA_API_TOKEN` | Update env, redeploy |
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | Update env, redeploy (only if the Neon connection string itself changes, e.g. password rotation) |

## Deployment checklist

- [ ] Neon project created, `DATABASE_URL` + `DATABASE_URL_UNPOOLED` configured
- [ ] Migrations applied (`npm run db:migrate`)
- [ ] Seed applied (`npm run db:seed`)
- [ ] Vercel project created, repo connected, production env variables configured
- [ ] Deployment status = READY
- [ ] `GET /api/health` → 200
- [ ] `POST /api/cron/tick` with correct `Authorization` → 200, no exception
- [ ] `POST /api/cron/daily` with correct `Authorization` → 200, no exception
- [ ] Telegram `getMe` returns the expected bot username
- [ ] `ADMIN_TELEGRAM_ID` / `TELEGRAM_ALLOWED_USER_IDS` / `TELEGRAM_REPORT_CHAT_ID` configured
- [ ] `telegram:set-commands` run against the production bot
- [ ] `telegram:set-webhook` run against the production origin
- [ ] cron-job.org job enabled (every 30 min, correct `Authorization` header)
- [ ] `vercel.json` daily cron present and correct, no second native cron added
- [ ] `BUDGET_PROFILE` intentional, hard cap confirmed active
- [ ] `collection_paused` is `false`
- [ ] At least one real provider job reached `INGESTED`
- [ ] `/status` reflects real production state
- [ ] Secret scan clean (no token/secret in git history, tracked files, or logs)
