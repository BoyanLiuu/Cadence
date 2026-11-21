import { describe, expect, it } from "vitest";

import type { Scope } from "@/lib/types";

import * as db from "./article-service.db";
import * as fixtures from "./article-service.fixtures";
import { getViewer } from "./viewer";

/*
 * What this suite is for: the seam.
 *
 * Appendix C's phase-2 check, stated exactly: "swap the service implementation
 * back to fixtures and the UI must be identical." That is the whole claim M1
 * was built to make true — every signature written before a database existed,
 * every function async from the start, the viewer argument there from day one
 * — and this is the only place the claim is actually tested.
 *
 * The comparison is deep-equal on the RESULTS, not on the queries, because
 * what matters is that no component can tell which implementation answered.
 * A difference here is a bug in one of the two, not a difference in the input:
 * `prisma/seed.ts` writes the same fixture corpus through the real schema, so
 * both are answering the same questions about the same articles.
 *
 * SKIPPED, not failed, with no database configured. 561 of the tests in this
 * project predate the schema and must keep running on a clone with no Supabase
 * project.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

const SCOPES: Scope[] = [
  { kind: "unread" },
  { kind: "all" },
  { kind: "saved" },
  { kind: "feed", feedId: 1 },
  { kind: "feed", feedId: 1, unreadOnly: true },
  { kind: "feed", feedId: 4 },
  { kind: "folder", folderId: 2 },
  { kind: "folder", folderId: 2, unreadOnly: true },
];

describeDb("the two implementations answer identically", () => {
  it("listFolders", async () => {
    const viewer = await getViewer();
    expect(await db.listFolders(viewer)).toEqual(await fixtures.listFolders(viewer));
  });

  it("listSubscriptions, including the derived unread counts", async () => {
    // The sharpest comparison available: the unread count is derived two
    // completely different ways — a filter over an array, and a pair of
    // grouped aggregates minus each other — and they must agree exactly.
    const viewer = await getViewer();
    const fromDb = await db.listSubscriptions(viewer);
    const fromFixtures = await fixtures.listSubscriptions(viewer);

    expect(fromDb.map((s) => s.feedId)).toEqual(fromFixtures.map((s) => s.feedId));
    expect(fromDb.map((s) => s.unread)).toEqual(fromFixtures.map((s) => s.unread));
  });

  it.each(SCOPES.map((s) => [JSON.stringify(s), s] as const))(
    "listArticles for %s returns the same rows in the same order",
    async (_label, scope) => {
      const viewer = await getViewer();
      const fromDb = await db.listArticles(viewer, scope);
      const fromFixtures = await fixtures.listArticles(viewer, scope);

      expect(fromDb.items.map((a) => a.id)).toEqual(fromFixtures.items.map((a) => a.id));
      expect(fromDb.next).toEqual(fromFixtures.next);
    },
  );

  it("paginates identically, page for page", async () => {
    // Where a keyset implementation most easily diverges: the tie-break on
    // `(publishedAt, id)` has to be written twice, once in JS and once in SQL.
    const viewer = await getViewer();
    const scope: Scope = { kind: "all" };

    let dbCursor = (await db.listArticles(viewer, scope)).next ?? undefined;
    let fxCursor = (await fixtures.listArticles(viewer, scope)).next ?? undefined;
    expect(dbCursor).toEqual(fxCursor);

    for (let page = 0; page < 3 && dbCursor; page += 1) {
      const fromDb = await db.listArticles(viewer, scope, dbCursor);
      const fromFixtures = await fixtures.listArticles(viewer, scope, fxCursor);
      expect(fromDb.items.map((a) => a.id)).toEqual(fromFixtures.items.map((a) => a.id));
      dbCursor = fromDb.next ?? undefined;
      fxCursor = fromFixtures.next ?? undefined;
      expect(dbCursor).toEqual(fxCursor);
    }
  });

  it("filters by title identically", async () => {
    const viewer = await getViewer();
    for (const query of ["council", "LATHE", "ferry", "zzz-no-match"]) {
      const fromDb = await db.listArticles(viewer, { kind: "all" }, undefined, { query });
      const fromFixtures = await fixtures.listArticles(viewer, { kind: "all" }, undefined, {
        query,
      });
      expect(
        fromDb.items.map((a) => a.id),
        `query ${query}`,
      ).toEqual(fromFixtures.items.map((a) => a.id));
    }
  });

  it("getArticle agrees on the fields a screen renders", async () => {
    const viewer = await getViewer();
    for (const id of [101, 116, 118, 123, 124, 999_999]) {
      const fromDb = await db.getArticle(viewer, id);
      const fromFixtures = await fixtures.getArticle(viewer, id);

      if (fromFixtures === null) {
        expect(fromDb, `article ${id}`).toBeNull();
        continue;
      }
      expect(fromDb, `article ${id}`).not.toBeNull();
      // Compared field by field rather than wholesale: `body`, `revision` and
      // `arrivals` are richer in the fixtures than ingestion can yet produce,
      // and pretending otherwise would be a test that lies in our favour.
      expect(fromDb!.id).toBe(fromFixtures.id);
      expect(fromDb!.title).toBe(fromFixtures.title);
      expect(fromDb!.feedId).toBe(fromFixtures.feedId);
      expect(fromDb!.publishedAt).toBe(fromFixtures.publishedAt);
      expect(fromDb!.readAt).toBe(fromFixtures.readAt);
      expect(fromDb!.savedAt).toBe(fromFixtures.savedAt);
      expect(fromDb!.extractStatus).toBe(fromFixtures.extractStatus);
      expect(fromDb!.revisedAt).toBe(fromFixtures.revisedAt);
    }
  });

  it("refuses an anon in both, before touching any data", async () => {
    const anon = { kind: "anon" } as const;
    await expect(db.listSubscriptions(anon)).rejects.toThrow();
    await expect(fixtures.listSubscriptions(anon)).rejects.toThrow();
  });

  it("scopes folders to their owner in both", async () => {
    // The corpus carries one folder belonging to another reader, so an
    // unscoped read leaks it. Both implementations must refuse.
    const viewer = await getViewer();
    for (const impl of [db, fixtures]) {
      const got = await impl.listFolders(viewer);
      expect(got.some((f) => f.name === "Someone else's folder")).toBe(false);
    }
  });
});

describe("the chooser", () => {
  it("defaults to fixtures with no DATABASE_URL, so a clone still runs", async () => {
    // Appendix C rule 5: the fixture corpus is the test corpus. A clone with
    // no Supabase project must still render every screen and pass every test
    // that predates the schema.
    const { dataSource } = await import("./article-service");
    expect(dataSource).toBe(HAS_DB ? "db" : "fixtures");
  });
});
