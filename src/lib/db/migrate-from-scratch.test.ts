import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "./client";

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

const MIGRATION = join(__dirname, "../../../prisma/migrations/0000_init/migration.sql");
const sql = readFileSync(MIGRATION, "utf8");

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

describe("the migration SQL says what it must", () => {
  it("creates pg_trgm", () => {
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm/i);
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
  it("has pg_trgm installed", async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `;
    expect(rows).toHaveLength(1);
    await prisma.$disconnect();
  });

  it("can actually use gin_trgm_ops, which is what the extension is for", async () => {
    // Asserting the extension row exists is not quite enough: the index is
    // created with `gin_trgm_ops`, and that operator class is what would be
    // missing if the extension landed in another schema.
    const rows = await prisma.$queryRaw<{ opcname: string }[]>`
      SELECT opcname FROM pg_opclass WHERE opcname = 'gin_trgm_ops'
    `;
    expect(rows.length).toBeGreaterThan(0);
    await prisma.$disconnect();
  });

  it("has every table the schema declares", async () => {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
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
