/**
 * Which raw provider field a normalized post's `views` count actually came
 * from. This is mandatory provenance, not decoration: TikTok and Instagram
 * measure "views" differently, and even the same platform can expose more
 * than one competing number (Instagram's `videoPlayCount` vs the usually-
 * absent `videoViewCount` — see docs/PROVIDER_SPIKE.md). Two posts with the
 * same `viewsMetric` are comparable; two with different ones are not, and
 * later analytics (Phase 6 scoring) must normalize them separately rather
 * than pool raw values across metrics.
 *
 * Provider is encoded in the tag (not just platform) because TikTok's
 * `playCount` via Apify and `play_count` via Bright Data are two
 * independently-collected numbers, not guaranteed to agree.
 *
 * Real, verified sources (Phase 1 / 1B, see PROVIDER_SPIKE.md):
 *   - tt_apify_play_count:        TikTok, Apify actor field `playCount`
 *   - tt_brightdata_play_count:   TikTok, Bright Data field `play_count`
 *   - ig_apify_video_play_count:  Instagram, Apify field `videoPlayCount`
 *   - ig_apify_video_view_count:  Instagram, Apify field `videoViewCount`
 *     (schema-supported but NOT observed present in any real Phase 1
 *     sample — kept only as a defensive fallback if a future post has it
 *     instead of videoPlayCount; never invented, never preferred).
 */
export const VIEWS_METRICS = [
  "tt_apify_play_count",
  "tt_brightdata_play_count",
  "ig_apify_video_play_count",
  "ig_apify_video_view_count",
] as const;
export type ViewsMetric = (typeof VIEWS_METRICS)[number];

export function isViewsMetric(value: string): value is ViewsMetric {
  return (VIEWS_METRICS as readonly string[]).includes(value);
}
