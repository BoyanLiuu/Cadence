-- Project 20 · Cadence · initial schema. ARCHITECTURE Appendix D.
--
-- EVERYTHING LIVES IN THE `cadence` SCHEMA. The Supabase project is shared with
-- the workspace's other apps and the schema is the isolation boundary, which is
-- why `users` here can share a name with another app's `users` and neither
-- knows. Matches `paste`.
--
-- `SET search_path` rather than qualifying every object: Prisma emits
-- unqualified DDL when `?schema=` makes `cadence` the connection's default, so
-- the generated half below says `CREATE TABLE "users"`. Pinning the path once
-- makes every unqualified CREATE land in `cadence` deterministically, whatever
-- the connection happens to be configured with — and it is one line to audit
-- instead of twenty-four prefixes to get right.
--
-- THE SECOND HALF IS HAND-WRITTEN, and that is the point of this migration.
-- Prisma's schema DSL cannot express a `WHERE` predicate on an index, and
-- `prisma migrate diff` generated NONE of the six indexes this design depends
-- on. Declaring them in the schema instead produces PLAIN indexes that pass
-- every test and are wrong in production — see the note on `articles_guid`.
--
-- `prisma db push` and `prisma migrate dev` are therefore both unsafe here:
-- each diffs the schema against the database and would DROP everything below
-- the banner. Use `pnpm db:migrate` (deploy) to apply and
-- `pnpm db:new-migration` (--create-only) to author.

CREATE SCHEMA IF NOT EXISTS "cadence";

-- `extensions` is in the path, not hard-coded into the index below.
--
-- Supabase keeps extensions in `extensions`; a plain Postgres has no such
-- schema. Naming it in `search_path` instead of qualifying `gin_trgm_ops`
-- means the operator class resolves WHEREVER pg_trgm happens to live — and a
-- missing schema in a search_path is ignored rather than an error, so this is
-- portable in both directions. `public` is last so nothing resolves there by
-- accident.
SET search_path TO "cadence", extensions, public;

-- CreateEnum
CREATE TYPE "feed_format" AS ENUM ('rss2', 'rss1', 'atom', 'json', 'unknown');

-- CreateEnum
CREATE TYPE "feed_status" AS ENUM ('active', 'backoff', 'dead', 'not_a_feed');

-- CreateEnum
CREATE TYPE "guid_trust" AS ENUM ('auto', 'guid', 'url');

-- CreateEnum
CREATE TYPE "full_text_mode" AS ENUM ('off', 'on_demand', 'always');

-- CreateEnum
CREATE TYPE "extract_status" AS ENUM ('none', 'ok', 'thin', 'blocked', 'failed');

-- CreateEnum
CREATE TYPE "merge_rung" AS ENUM ('guid', 'url', 'content');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tz" TEXT NOT NULL DEFAULT 'UTC',
    "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feeds" (
    "id" BIGSERIAL NOT NULL,
    "feed_url" TEXT NOT NULL,
    "url_hash" BYTEA NOT NULL,
    "site_url" TEXT,
    "title" TEXT NOT NULL,
    "favicon_key" TEXT,
    "format" "feed_format" NOT NULL DEFAULT 'unknown',
    "lang" TEXT,
    "etag" TEXT,
    "last_modified" TEXT,
    "body_hash" BYTEA,
    "fetch_interval_s" INTEGER NOT NULL DEFAULT 3600,
    "next_fetch_at" TIMESTAMP(3),
    "lease_until" TIMESTAMP(3),
    "median_post_gap_s" INTEGER,
    "declared_ttl_s" INTEGER,
    "consecutive_failures" SMALLINT NOT NULL DEFAULT 0,
    "unchanged_polls" SMALLINT NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_text" TEXT,
    "last_error_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "first_failure_at" TIMESTAMP(3),
    "dead_at" TIMESTAMP(3),
    "not_feed_at" TIMESTAMP(3),
    "status" "feed_status" NOT NULL DEFAULT 'active',
    "guid_unstable" BOOLEAN NOT NULL DEFAULT false,
    "guid_unstable_since" TIMESTAMP(3),
    "guid_trust_override" "guid_trust" NOT NULL DEFAULT 'auto',
    "clean_polls" SMALLINT NOT NULL DEFAULT 0,
    "hub_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" BIGSERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "user_id" TEXT NOT NULL,
    "feed_id" BIGINT NOT NULL,
    "folder_id" BIGINT,
    "custom_title" TEXT,
    "full_text_mode" "full_text_mode" NOT NULL DEFAULT 'on_demand',
    "resurface_on_revision" BOOLEAN NOT NULL DEFAULT false,
    "filter_rules" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("user_id","feed_id")
);

-- CreateTable
CREATE TABLE "articles" (
    "id" BIGSERIAL NOT NULL,
    "feed_id" BIGINT NOT NULL,
    "guid_hash" BYTEA,
    "url" TEXT NOT NULL,
    "url_hash" BYTEA NOT NULL,
    "content_hash" BYTEA NOT NULL,
    "norm_version" SMALLINT NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary_html" TEXT,
    "content_html" TEXT,
    "text_len" INTEGER,
    "revised_at" TIMESTAMP(3),
    "revision_count" SMALLINT NOT NULL DEFAULT 0,
    "lang" TEXT,
    "image_url" TEXT,
    "enclosure" JSONB,
    "extract_status" "extract_status" NOT NULL DEFAULT 'none',

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_urls" (
    "url_hash" BYTEA NOT NULL,
    "article_id" BIGINT NOT NULL,
    "url" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_urls_pkey" PRIMARY KEY ("url_hash")
);

-- CreateTable
CREATE TABLE "user_articles" (
    "user_id" TEXT NOT NULL,
    "article_id" BIGINT NOT NULL,
    "read_at" TIMESTAMP(3),
    "saved_at" TIMESTAMP(3),
    "progress" SMALLINT,
    "was_read_at" TIMESTAMP(3),

    CONSTRAINT "user_articles_pkey" PRIMARY KEY ("user_id","article_id")
);

-- CreateTable
CREATE TABLE "summaries" (
    "id" BIGSERIAL NOT NULL,
    "article_id" BIGINT NOT NULL,
    "content_hash" BYTEA NOT NULL,
    "model" TEXT NOT NULL,
    "bullets" JSONB NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fetch_log" (
    "id" BIGSERIAL NOT NULL,
    "feed_id" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_code" SMALLINT,
    "duration_ms" INTEGER NOT NULL,
    "bytes" INTEGER,
    "items_seen" INTEGER NOT NULL DEFAULT 0,
    "items_new" INTEGER NOT NULL DEFAULT 0,
    "merged_by_guid" INTEGER NOT NULL DEFAULT 0,
    "merged_by_url" INTEGER NOT NULL DEFAULT 0,
    "merged_by_content" INTEGER NOT NULL DEFAULT 0,
    "revised" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "note" TEXT,

    CONSTRAINT "fetch_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "feeds_url_hash_key" ON "feeds"("url_hash");

-- CreateIndex
CREATE INDEX "folders_user_id_position_idx" ON "folders"("user_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "folders_user_id_name_key" ON "folders"("user_id", "name");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_folder_id_idx" ON "subscriptions"("user_id", "folder_id");

-- CreateIndex
CREATE INDEX "article_urls_article_id_idx" ON "article_urls"("article_id");

-- CreateIndex
CREATE INDEX "user_articles_article_id_idx" ON "user_articles"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "summaries_article_id_content_hash_key" ON "summaries"("article_id", "content_hash");

-- CreateIndex
CREATE INDEX "fetch_log_feed_id_at_idx" ON "fetch_log"("feed_id", "at" DESC);

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_feed_id_fkey" FOREIGN KEY ("feed_id") REFERENCES "feeds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_feed_id_fkey" FOREIGN KEY ("feed_id") REFERENCES "feeds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_urls" ADD CONSTRAINT "article_urls_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_articles" ADD CONSTRAINT "user_articles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_articles" ADD CONSTRAINT "user_articles_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fetch_log" ADD CONSTRAINT "fetch_log_feed_id_fkey" FOREIGN KEY ("feed_id") REFERENCES "feeds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- THE INDEXES THAT MATTER (hand-written; see the header)
-- ============================================================================

-- `pg_trgm`, wherever this database already keeps it.
--
-- NO `WITH SCHEMA`: that assumed an `extensions` schema this migration does not
-- create, and it is a silent no-op when pg_trgm is already installed somewhere
-- else — after which a hard-coded `extensions.gin_trgm_ops` cannot resolve and
-- the migration fails on a plain Postgres. Unqualified, it installs into the
-- first schema of the path above when absent and is a no-op when present.
--
-- It MUST be created in this first migration. Adding it later works, but
-- FORGETTING it means the title-similarity index silently cannot be created
-- when P2's near-duplicate clustering needs it, and nothing fails until then.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The scheduler's only index. PARTIAL, so dead and not-a-feed rows never bloat
-- it: with 300 feeds and a tick every minute the due query runs 1,440 times a
-- day and must not scan rows that can never be due (§6.4).
CREATE INDEX "feeds_due" ON "feeds" ("next_fetch_at")
  WHERE "status" IN ('active', 'backoff');

-- RUNG 1 of the ladder: the publisher's own claim.
--
-- PARTIAL, and the predicate is load-bearing twice over. Without
-- `WHERE guid_hash IS NOT NULL`:
--   1. every feed with no <guid> permits unlimited duplicate rows, because SQL
--      treats all those NULLs as distinct in a plain unique index;
--   2. the upsert's `ON CONFLICT (feed_id, guid_hash) WHERE guid_hash IS NOT
--      NULL` cannot infer which index to use, and fails at RUNTIME.
CREATE UNIQUE INDEX "articles_guid" ON "articles" ("feed_id", "guid_hash")
  WHERE "guid_hash" IS NOT NULL;

-- RUNG 2: GLOBAL, not per-feed.
--
-- This single word is what collapses one wire story arriving through six feeds
-- into one row (§6.1). Scoping it to `(feed_id, url_hash)` would index the same
-- number of rows and lose the entire benefit.
CREATE UNIQUE INDEX "articles_url" ON "articles" ("url_hash");

-- RUNG 3: content equality, never similarity.
--
-- Not unique: the ladder RESOLVES a content match rather than rejecting the
-- insert. Similarity is a P2 clustering problem, grouped and never merged.
CREATE INDEX "articles_content" ON "articles" ("content_hash");

-- The unread set is the SMALL set, so index only that.
--
-- PARTIAL on `read_at IS NULL`, which is the shape §6.2's count asks for:
-- `LEFT JOIN user_articles ... WHERE ua.read_at IS NULL`. A full index over
-- every row a reader has ever read would grow without bound while answering a
-- question only about the rows they have not.
CREATE INDEX "ua_unread" ON "user_articles" ("user_id", "article_id")
  WHERE "read_at" IS NULL;

-- The per-feed reading list, keyset-ordered.
--
-- Matches the ORDER BY the list query uses, so paging is an index scan rather
-- than a sort. Never OFFSET (N6).
CREATE INDEX "articles_feed_time" ON "articles" ("feed_id", "published_at" DESC, "id" DESC);

-- Near-duplicate titles and search. P2 USES this; M6 CREATES it, because the
-- extension above has to exist first and this is the only migration guaranteed
-- to run before any data does.
--
-- The operator class is UNQUALIFIED, resolved through the `search_path` set at
-- the top. Hard-coding `extensions.` tied this migration to Supabase.
CREATE INDEX "articles_title_trgm" ON "articles" USING gin ("title" gin_trgm_ops);

-- Every address an article has ever been reachable at, REPLAYABLE.
--
-- `url_hash` is already the primary key; this is on the URL itself, which
-- exists so a `norm_version` bump can re-hash the alternates this table owns —
-- a digest cannot be re-derived from itself (M3's review).
CREATE INDEX "article_urls_norm" ON "article_urls" ("url");

-- ============================================================================
-- RLS: on, with no policies, as defence in depth.
-- ============================================================================
--
-- The role Prisma connects as owns these tables and therefore BYPASSES RLS, so
-- application queries are unaffected. What this buys is that a leaked Supabase
-- anon key reads nothing at all.
--
-- Ownership is still enforced by an explicit filter in the service layer. RLS
-- is the backstop, not the authorization model.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feeds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "articles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "article_urls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_articles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fetch_log" ENABLE ROW LEVEL SECURITY;
