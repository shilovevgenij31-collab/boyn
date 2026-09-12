# CLAUDE.md — Trend Radar

Read `docs/IMPLEMENTATION_PLAN.md` first — it is the source of truth for architecture, data
model, scoring, and phase scope. This file is the short, load-bearing ruleset for day-to-day
code in this repo.

## Architecture rules

1. `src/core` contains framework-independent, deterministic domain logic.
2. `core` must not import:
   - Next.js (`next`, `next/*`);
   - database adapters (`src/db/*`);
   - Telegram (`src/telegram/*`);
   - provider clients (`src/providers/*`);
   - OpenRouter / `src/insights/*`.
   It may import `src/lib/*` (plain utilities) and other `src/core` modules. This is enforced by
   an ESLint `no-restricted-imports` rule scoped to `src/core/**` — don't disable it to work
   around a shortcut; restructure instead.
3. Core time-dependent logic receives a `Clock` (`src/lib/clock.ts`) — never call `Date.now()` /
   `new Date()` directly inside `core`. Tests use `FixedClock` for determinism.
4. Do not hide failures with patterns like `.catch(() => [])` on an aggregator. That silently
   empties dependent data for the whole caller when only one inner call failed.
5. Catch errors at the smallest meaningful boundary and record the failure (log it / store it),
   rather than catching broadly and discarding what went wrong.
6. Use exhaustive `switch` statements over closed unions/enums, with `assertNever()`
   (`src/lib/exhaustive.ts`) in the `default` branch — this turns "forgot to handle a new tier/
   state/status variant" into a compile error instead of a silent runtime gap.
7. Thresholds and scoring parameters belong in typed `src/config/*.ts` files, not scattered
   magic numbers in business logic.
8. A missing third-party metric (views, likes, comments, shares — especially where a
   platform/provider doesn't expose it) is `null`/unavailable, never silently coerced to `0`. Missing
   data reduces confidence or drops out of a weighted calculation (with renormalisation); it must
   never be treated as evidence of *no* engagement. See IMPLEMENTATION_PLAN §15 (EARLY_BREAKOUT's
   availability-aware engagement floor) and §16.3 (score component renormalisation).
9. The LLM (OpenRouter, `src/insights/*`) is never on the critical path. Every product feature
   must work correctly with `OPENROUTER_API_KEY` unset or the provider failing.
10. Do not add infrastructure dependencies (queues, Redis, a graph/vector DB, a DI framework)
    without a demonstrated requirement — see IMPLEMENTATION_PLAN §5, §37 for why they're
    currently unnecessary.
11. Social data providers (Bright Data, Apify, …) stay behind the `SocialDataProvider` interface
    (Phase 4). Nothing outside `src/providers/*` should know which vendor produced a post.
12. Canonical links (`posts.canonical_url`) must always resolve to the original TikTok/Instagram
    post (`tiktok.com` / `instagram.com`), never a provider/CDN URL. This is a host-allowlist
    check at normalization time, not a convention to remember by hand.
13. Hashtag/trend growth is computed over our own bounded, budgeted sample of tracked tags — it
    is never platform-wide. User-facing copy must say "Radar growth" / "growth in our monitored
    sample", never phrase it as an authoritative platform claim (e.g. not "#tag grew 214% on
    TikTok"). See IMPLEMENTATION_PLAN §17, ADR-022.
14. `market` (geography/audience scope — `global`, `US`, `RU`, …) and `language` (`en`, `ru`, …)
    are separate fields. Don't conflate them, and don't treat `"global"` as a null/unconfigured
    placeholder — it's a real market value. See ADR-020.
15. The daily report distinguishes **Today** (published within the current 24h report window —
    the primary Top 30) from **Still Hot** (published 24–72h ago and still qualifying) as two
    separate, always age-labelled sections — never silently merge Still-Hot content into Today's
    list. See IMPLEMENTATION_PLAN §19, ADR-019.
16. Do not implement future phases early. Build exactly the phase in scope; a later phase's
    schema/interface can still be designed for, but don't pre-populate it with invented logic or
    fabricated values (see the `src/config/*.ts` Phase 0 placeholders for the pattern: a doc
    comment pointing at the future phase, not a guessed implementation).
17. After every phase: run `npm run typecheck`, `npm run lint`, `npm run test` (`npm run check`
    runs all three), and for deploy-relevant changes `npm run build`. Summarize any deviation
    from the approved plan explicitly — don't silently narrow or reinterpret scope.

## Practical notes

- Windows is a first-class dev environment here. Scripts must be Node/TypeScript, not bash-only
  shell scripts.
- Strict TypeScript; avoid `any` without a comment explaining why it's unavoidable.
- Prefer small explicit functions over class hierarchies; avoid DI frameworks and barrel-file
  complexity.
- Don't suppress a TypeScript or ESLint error to make checks pass — fix the underlying issue.
