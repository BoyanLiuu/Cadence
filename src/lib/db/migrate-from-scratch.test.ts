import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "./client";
import { CAN_READ_DB } from "./guards";

/*
 * What this suite is for: the missing extension.
 *
 * `pg_trgm` must be created in the FIRST migration. Adding it later works, but
 * forgetting it means the title-similarity index silently cannot be created
 * when P2's near-duplicate clustering needs it — and nothing fails in the
 * meantime, so the gap is discovered a year later by someone else.
 *
 * The migration SQL is also checked as TEXT, which runs without a database.
 * That half matters because the hand-written index block is the part Prisma
 * does not generate and therefore the part a careless `prisma migrate dev`
 * would quietly drop.
 */

const MIGRATION = join(
  __dirname,
  "../../../prisma/migrations/20261121013320_init_cadence_schema/migration.sql",
);
const sql = readFileSync(MIGRATION, "utf8");

/**
 * The migration with its `--` comments removed.
 *
 * Needed for any assertion about ORDER: the header comment explains the
 * `SET search_path` line, so a naive `indexOf` finds the explanation before the
 * statement and the ordering check fails on prose. Same trap as
 * `no-offset.test.ts`, which failed on the comments describing its own rule.
 */
const statements = sql.replace(/^\s*--.*$/gm, "");

// Read-only, so a configured database is enough.
const HAS_DB = CAN_READ_DB;
const describeDb = HAS_DB ? describe : describe.skip;

describe("the migration SQL says what it must", () => {
  it("creates pg_trgm without pinning a schema", () => {
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/i);
    // `WITH SCHEMA extensions` assumed a schema this migration does not create
    // and was a silent no-op when pg_trgm already lived elsewhere — after
    // which the qualified operator class could not resolve at all.
    expect(sql).not.toMatch(/pg_trgm WITH SCHEMA/i);
  });

  it("pins the search_path, so unqualified DDL lands in cadence", () => {
    // Prisma emits unqualified DDL when `?schema=` makes cadence the default,
    // so the generated half says `CREATE TABLE "users"`. Without this line the
    // tables would land wherever the connection happened to point — which in
    // a SHARED project means another app's schema or `public`.
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "cadence"');
    expect(sql).toMatch(/SET search_path TO "cadence"/);
    // And the order matters: the schema must exist before the path names it.
    expect(statements.indexOf("CREATE SCHEMA")).toBeLessThan(statements.indexOf("SET search_path"));
  });

  it("resolves the trigram operator class through search_path, not a prefix", () => {
    // Unqualified, with `extensions` named in the search_path at the top. That
    // resolves wherever pg_trgm lives — Supabase keeps it in `extensions`, a
    // plain Postgres has no such schema — and a missing schema in a
    // search_path is ignored rather than an error.
    expect(sql).toMatch(/USING gin \("title" gin_trgm_ops\)/);
    expect(sql).toMatch(/SET search_path TO "cadence", extensions, public/);
  });

  it("creates every index Appendix D names", () => {
    for (const index of [
      "feeds_due",
      "articles_guid",
      "articles_url",
      "articles_content",
      "ua_unread",
      "articles_feed_time",
      "articles_title_trgm",
    ]) {
      expect(sql, `migration does not create ${index}`).toContain(`"${index}"`);
    }
  });

  it("gives the three partial indexes their WHERE clauses", () => {
    // Without the predicate they are plain indexes: wrong in the one way that
    // silently permits duplicates, and undetectable from the schema file.
    expect(sql).toMatch(/articles_guid[\s\S]{0,200}WHERE "guid_hash" IS NOT NULL/);
    expect(sql).toMatch(/ua_unread[\s\S]{0,200}WHERE "read_at" IS NULL/);
    expect(sql).toMatch(/feeds_due[\s\S]{0,200}WHERE "status" IN/);
  });

  it("makes articles_url unique and global", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "articles_url" ON "articles" \("url_hash"\)/);
  });

  it("enables RLS on every table", () => {
    // Defence in depth: the role Prisma connects as owns the tables and
    // bypasses RLS, so a leaked anon key reads nothing while app queries are
    // unaffected. Ownership is still enforced in the service layer.
    for (const table of [
      "users",
      "feeds",
      "folders",
      "subscriptions",
      "articles",
      "article_urls",
      "user_articles",
      "summaries",
      "fetch_log",
    ]) {
      expect(sql, `RLS not enabled on ${table}`).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );
    }
  });
});

describeDb("against a real database", () => {
  it("has pg_trgm installed, wherever the shared project keeps it", async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `;
    expect(rows).toHaveLength(1);
    await prisma.$disconnect();
  });

  it("can actually use gin_trgm_ops, which is what the extension is for", async () => {
    // Asserting the extension row exists is not quite enough: the index needs
    // the `gin_trgm_ops` OPERATOR CLASS to be reachable, which is a different
    // question from whether the extension is installed somewhere.
    const rows = await prisma.$queryRaw<{ opcname: string }[]>`
      SELECT opcname FROM pg_opclass WHERE opcname = 'gin_trgm_ops'
    `;
    expect(rows.length).toBeGreaterThan(0);
    await prisma.$disconnect();
  });

  it("has every table the schema declares", async () => {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'cadence'
    `;
    const names = new Set(rows.map((r) => r.tablename));
    for (const table of [
      "users",
      "feeds",
      "folders",
      "subscriptions",
      "articles",
      "article_urls",
      "user_articles",
      "summaries",
      "fetch_log",
    ]) {
      expect(names.has(table), `missing table ${table}`).toBe(true);
    }
    await prisma.$disconnect();
  });
});
