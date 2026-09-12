CREATE TYPE "public"."ai_insight_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."availability" AS ENUM('ACTIVE', 'DELETED', 'PRIVATE', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."category" AS ENUM('cosplay', 'streaming', 'gaming', 'pc', 'playstation');--> statement-breakpoint
CREATE TYPE "public"."collection_run_kind" AS ENUM('DISCOVERY', 'REFRESH', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."collection_run_status" AS ENUM('PLANNED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('video', 'reel', 'image', 'carousel', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."error_severity" AS ENUM('INFO', 'WARN', 'ERROR', 'FATAL');--> statement-breakpoint
CREATE TYPE "public"."hashtag_category_source" AS ENUM('SEED', 'KEYWORD', 'COOCCURRENCE', 'MANUAL', 'AI');--> statement-breakpoint
CREATE TYPE "public"."hashtag_source" AS ENUM('SEED', 'DISCOVERED', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'SUBMITTED', 'RUNNING', 'READY', 'INGESTED', 'FAILED', 'TIMED_OUT');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('HASHTAG_DISCOVERY', 'POST_REFRESH');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('tiktok', 'instagram');--> statement-breakpoint
CREATE TYPE "public"."post_category_source" AS ENUM('TAG', 'KEYWORD', 'QUERY', 'AI');--> statement-breakpoint
CREATE TYPE "public"."post_tier" AS ENUM('VIRAL_QUALIFIED', 'EARLY_BREAKOUT', 'WATCH', 'NOISE');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('apify', 'brightdata');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('COMPLETE', 'PARTIAL');--> statement-breakpoint
CREATE TYPE "public"."snapshot_source" AS ENUM('DISCOVERY', 'REFRESH');--> statement-breakpoint
CREATE TYPE "public"."tracking_tier" AS ENUM('CORE', 'ACTIVE', 'EXPLORATION', 'DORMANT');--> statement-breakpoint
CREATE TYPE "public"."trend_state" AS ENUM('BREAKOUT', 'RISING', 'ACTIVE', 'STABLE', 'FALLING', 'DEAD', 'NEW');--> statement-breakpoint
CREATE TYPE "public"."velocity_confidence" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."views_metric" AS ENUM('tt_apify_play_count', 'tt_brightdata_play_count', 'ig_apify_video_play_count', 'ig_apify_video_view_count');--> statement-breakpoint
CREATE TYPE "public"."vph_kind" AS ENUM('OBSERVED', 'ESTIMATED');--> statement-breakpoint
CREATE TABLE "ai_insights" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_insights_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"report_id" bigint,
	"input_hash" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"status" "ai_insight_status" DEFAULT 'PENDING' NOT NULL,
	"raw_output" text,
	"parsed" jsonb,
	"error" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "collection_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "collection_run_kind" NOT NULL,
	"slot_key" text NOT NULL,
	"status" "collection_run_status" DEFAULT 'PLANNED' NOT NULL,
	"planned_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"budget_records" integer,
	"records_used" integer DEFAULT 0 NOT NULL,
	"stats" jsonb,
	"error_summary" text,
	"triggered_by" text,
	CONSTRAINT "collection_runs_slot_key_unique" UNIQUE("slot_key")
);
--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "daily_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"report_date" date NOT NULL,
	"market" text DEFAULT 'global' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"status" "report_status" NOT NULL,
	"partial_reasons" text[],
	"payload" jsonb NOT NULL,
	"scoring_version" integer,
	"generated_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"telegram_message_ids" text[]
);
--> statement-breakpoint
CREATE TABLE "error_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "error_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"severity" "error_severity" NOT NULL,
	"message" text NOT NULL,
	"context" jsonb
);
--> statement-breakpoint
CREATE TABLE "hashtag_categories" (
	"hashtag_id" bigint NOT NULL,
	"category" "category" NOT NULL,
	"source" "hashtag_category_source" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	CONSTRAINT "hashtag_categories_hashtag_id_category_pk" PRIMARY KEY("hashtag_id","category")
);
--> statement-breakpoint
CREATE TABLE "hashtag_cooccurrence_daily" (
	"date" date NOT NULL,
	"platform" "platform" NOT NULL,
	"market" text DEFAULT 'global' NOT NULL,
	"tag_a" bigint NOT NULL,
	"tag_b" bigint NOT NULL,
	"posts" integer DEFAULT 0 NOT NULL,
	"viral_posts" integer DEFAULT 0 NOT NULL,
	"views_sum" bigint,
	CONSTRAINT "hashtag_cooccurrence_daily_date_platform_market_tag_a_tag_b_pk" PRIMARY KEY("date","platform","market","tag_a","tag_b")
);
--> statement-breakpoint
CREATE TABLE "hashtag_daily_stats" (
	"date" date NOT NULL,
	"platform" "platform" NOT NULL,
	"market" text DEFAULT 'global' NOT NULL,
	"hashtag_id" bigint NOT NULL,
	"posts_seen" integer DEFAULT 0 NOT NULL,
	"watch_posts" integer DEFAULT 0 NOT NULL,
	"viral_posts" integer DEFAULT 0 NOT NULL,
	"breakout_posts" integer DEFAULT 0 NOT NULL,
	"distinct_creators" integer DEFAULT 0 NOT NULL,
	"viral_views_sum" bigint,
	"median_vph" numeric(14, 2),
	"scans" integer DEFAULT 0 NOT NULL,
	"trend_state" "trend_state",
	"momentum" numeric(6, 5),
	CONSTRAINT "hashtag_daily_stats_date_platform_market_hashtag_id_pk" PRIMARY KEY("date","platform","market","hashtag_id")
);
--> statement-breakpoint
CREATE TABLE "hashtag_tier_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hashtag_tier_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tracked_hashtag_id" bigint NOT NULL,
	"from_tier" "tracking_tier",
	"to_tier" "tracking_tier" NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hashtags" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hashtags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"is_generic" boolean DEFAULT false NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hashtags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "post_categories" (
	"post_id" bigint NOT NULL,
	"category" "category" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"source" "post_category_source" NOT NULL,
	CONSTRAINT "post_categories_post_id_category_pk" PRIMARY KEY("post_id","category")
);
--> statement-breakpoint
CREATE TABLE "post_discoveries" (
	"post_id" bigint NOT NULL,
	"provider_job_id" bigint NOT NULL,
	"hashtag_id" bigint,
	"query_text" text,
	"rank_in_results" smallint,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "post_discoveries_post_id_provider_job_id_pk" PRIMARY KEY("post_id","provider_job_id")
);
--> statement-breakpoint
CREATE TABLE "post_hashtags" (
	"post_id" bigint NOT NULL,
	"hashtag_id" bigint NOT NULL,
	"position" smallint,
	CONSTRAINT "post_hashtags_post_id_hashtag_id_pk" PRIMARY KEY("post_id","hashtag_id")
);
--> statement-breakpoint
CREATE TABLE "post_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "post_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"post_id" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"views" bigint,
	"views_metric" "views_metric",
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"saves" bigint,
	"source" "snapshot_source" NOT NULL,
	"provider_job_id" bigint
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "posts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"platform" "platform" NOT NULL,
	"external_id" text NOT NULL,
	"market" text DEFAULT 'global' NOT NULL,
	"language" text,
	"canonical_url" text NOT NULL,
	"content_type" "content_type" NOT NULL,
	"creator_username" text,
	"creator_external_id" text,
	"creator_followers" bigint,
	"creator_verified" boolean,
	"caption" text,
	"music_id" text,
	"music_title" text,
	"music_author" text,
	"published_at" timestamp with time zone,
	"duration_sec" numeric(10, 3),
	"views" bigint,
	"views_metric" "views_metric",
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"saves" bigint,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"tier" "post_tier",
	"availability" "availability" DEFAULT 'ACTIVE' NOT NULL,
	"vph" numeric(14, 2),
	"vph_kind" "vph_kind",
	"velocity_confidence" "velocity_confidence",
	"trend_score" smallint,
	"rising_score" smallint,
	"score_components" jsonb,
	"scored_at" timestamp with time zone,
	"scoring_version" integer,
	"next_refresh_at" timestamp with time zone,
	"paid_refresh_count" smallint DEFAULT 0 NOT NULL,
	"discovered_via_hashtag_id" bigint
);
--> statement-breakpoint
CREATE TABLE "provider_jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "provider_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"collection_run_id" bigint NOT NULL,
	"provider" "provider" NOT NULL,
	"platform" "platform" NOT NULL,
	"job_type" "job_type" NOT NULL,
	"external_job_id" text,
	"webhook_token" text,
	"input" jsonb,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"ingested_at" timestamp with time zone,
	"records_returned" integer,
	"records_quarantined" integer,
	"cost_est_usd" numeric(12, 6),
	"http_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "quarantined_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "quarantined_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"provider" "provider" NOT NULL,
	"platform" "platform" NOT NULL,
	"provider_job_id" bigint,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_views" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_baselines" (
	"platform" "platform" NOT NULL,
	"market" text DEFAULT 'global' NOT NULL,
	"metric" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"n" integer NOT NULL,
	"median" numeric(18, 4) NOT NULL,
	"mad" numeric(18, 4) NOT NULL,
	"p10" numeric(18, 4),
	"p90" numeric(18, 4),
	CONSTRAINT "scoring_baselines_platform_market_metric_pk" PRIMARY KEY("platform","market","metric")
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_hashtags" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tracked_hashtags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"hashtag_id" bigint NOT NULL,
	"platform" "platform" NOT NULL,
	"market" text DEFAULT 'global' NOT NULL,
	"tier" "tracking_tier" NOT NULL,
	"source" "hashtag_source" NOT NULL,
	"priority" numeric(10, 4) DEFAULT '0' NOT NULL,
	"trend_state" "trend_state" DEFAULT 'NEW' NOT NULL,
	"trend_state_since" timestamp with time zone,
	"momentum" numeric(6, 5),
	"next_due_at" timestamp with time zone,
	"last_scanned_at" timestamp with time zone,
	"scans_total" integer DEFAULT 0 NOT NULL,
	"probes_in_tier" integer DEFAULT 0 NOT NULL,
	"consecutive_empty_scans" integer DEFAULT 0 NOT NULL,
	"tier_changed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_report_id_daily_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."daily_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hashtag_categories" ADD CONSTRAINT "hashtag_categories_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hashtag_cooccurrence_daily" ADD CONSTRAINT "hashtag_cooccurrence_daily_tag_a_hashtags_id_fk" FOREIGN KEY ("tag_a") REFERENCES "public"."hashtags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hashtag_cooccurrence_daily" ADD CONSTRAINT "hashtag_cooccurrence_daily_tag_b_hashtags_id_fk" FOREIGN KEY ("tag_b") REFERENCES "public"."hashtags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hashtag_daily_stats" ADD CONSTRAINT "hashtag_daily_stats_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hashtag_tier_events" ADD CONSTRAINT "hashtag_tier_events_tracked_hashtag_id_tracked_hashtags_id_fk" FOREIGN KEY ("tracked_hashtag_id") REFERENCES "public"."tracked_hashtags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_categories" ADD CONSTRAINT "post_categories_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_discoveries" ADD CONSTRAINT "post_discoveries_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_discoveries" ADD CONSTRAINT "post_discoveries_provider_job_id_provider_jobs_id_fk" FOREIGN KEY ("provider_job_id") REFERENCES "public"."provider_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_discoveries" ADD CONSTRAINT "post_discoveries_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_hashtags" ADD CONSTRAINT "post_hashtags_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_hashtags" ADD CONSTRAINT "post_hashtags_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_snapshots" ADD CONSTRAINT "post_snapshots_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_snapshots" ADD CONSTRAINT "post_snapshots_provider_job_id_provider_jobs_id_fk" FOREIGN KEY ("provider_job_id") REFERENCES "public"."provider_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_discovered_via_hashtag_id_hashtags_id_fk" FOREIGN KEY ("discovered_via_hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantined_items" ADD CONSTRAINT "quarantined_items_provider_job_id_provider_jobs_id_fk" FOREIGN KEY ("provider_job_id") REFERENCES "public"."provider_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_hashtags" ADD CONSTRAINT "tracked_hashtags_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_insights_input_hash_prompt_version_key" ON "ai_insights" USING btree ("input_hash","prompt_version");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_reports_report_date_market_key" ON "daily_reports" USING btree ("report_date","market");--> statement-breakpoint
CREATE INDEX "hashtag_daily_stats_hashtag_id_date_idx" ON "hashtag_daily_stats" USING btree ("hashtag_id","date");--> statement-breakpoint
CREATE INDEX "post_discoveries_hashtag_id_idx" ON "post_discoveries" USING btree ("hashtag_id");--> statement-breakpoint
CREATE INDEX "post_hashtags_hashtag_id_post_id_idx" ON "post_hashtags" USING btree ("hashtag_id","post_id");--> statement-breakpoint
CREATE INDEX "post_snapshots_post_id_observed_at_idx" ON "post_snapshots" USING btree ("post_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_platform_external_id_key" ON "posts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "posts_platform_market_published_at_idx" ON "posts" USING btree ("platform","market","published_at");--> statement-breakpoint
CREATE INDEX "posts_next_refresh_at_idx" ON "posts" USING btree ("next_refresh_at");--> statement-breakpoint
CREATE INDEX "posts_tier_published_at_idx" ON "posts" USING btree ("tier","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_jobs_provider_external_job_id_key" ON "provider_jobs" USING btree ("provider","external_job_id") WHERE "provider_jobs"."external_job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "provider_jobs_status_next_poll_at_idx" ON "provider_jobs" USING btree ("status","next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_hashtags_hashtag_platform_market_key" ON "tracked_hashtags" USING btree ("hashtag_id","platform","market");--> statement-breakpoint
CREATE INDEX "tracked_hashtags_platform_market_tier_next_due_idx" ON "tracked_hashtags" USING btree ("platform","market","tier","next_due_at");