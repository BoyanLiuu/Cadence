import { describe, expect, it } from "vitest";

import { PAGE_SIZE, type Cursor } from "@/lib/types";

import * as service from "./article-service";
import * as mutations from "./mutations";
import { NotImplementedInStaticPhase } from "./mutations";
import { assertCan, getViewer, NotAllowedError } from "./viewer";

/*
 * What this suite is for: the signature drift that makes phase 2 a rewrite.
 *
 * Appendix C's contract is that no caller changes shape when M6–M9 replace
 * these bodies with Postgres. Two properties carry that, and both are easy to
 * break by writing one convenient synchronous helper:
 *
 *   - every service function returns a promise
 *   - every one takes the viewer as its first argument
 *
 * A function that reads fixtures synchronously works perfectly in phase 1 and
 * forces every call site to change in phase 2. That is the whole cost this
 * suite exists to prevent, so it asserts the shape rather than the data.
 */

const anon = { kind: "anon" } as const;

describe("the service layer keeps Appendix C's contract", () => {
  const reads = Object.entries(service);
  const writes = Object.entries(mutations).filter(
    ([, v]) => typeof v === "function" && v !== NotImplementedInStaticPhase,
  );

  it("exports the functions Appendix C names", () => {
    expect(Object.keys(service).sort()).toEqual([
      "getArticle",
      "getFeedHealth",
      "listArticles",
      "listFolders",
      "listSubscriptions",
    ]);
  });

  it.each(reads)("%s is async", async (_name, fn) => {
    expect(typeof fn).toBe("function");
    const result = (fn as (...a: unknown[]) => unknown)(anon, { kind: "unread" }, undefined);
    // A promise even on the failure path: a function that throws synchronously
    // for anon and returns a promise otherwise has two shapes, not one.
    expect(result).toBeInstanceOf(Promise);
    await (result as Promise<unknown>).catch(() => undefined);
  });

  it.each(reads)("%s takes the viewer first and refuses an anon", async (_name, fn) => {
    await expect(
      (fn as (...a: unknown[]) => Promise<unknown>)(anon, { kind: "unread" }, undefined),
    ).rejects.toBeInstanceOf(NotAllowedError);
  });

  it.each(writes)("%s takes the viewer first and refuses an anon", async (_name, fn) => {
    await expect(
      (fn as (...a: unknown[]) => Promise<unknown>)(anon, 1, true),
    ).rejects.toBeInstanceOf(NotAllowedError);
  });
});

describe("mutations are declared but not implemented", () => {
  it.each(
    Object.entries(mutations).filter(
      ([, v]) => typeof v === "function" && v !== NotImplementedInStaticPhase,
    ),
  )("%s throws NotImplementedInStaticPhase for a real viewer", async (_name, fn) => {
    const viewer = await getViewer();
    await expect(
      (fn as (...a: unknown[]) => Promise<unknown>)(viewer, 1, true),
    ).rejects.toBeInstanceOf(NotImplementedInStaticPhase);
  });

  it("names the endpoint, so the receipt screens can say what was not sent", async () => {
    const viewer = await getViewer();
    await expect(mutations.subscribe(viewer, { feedUrl: "x" })).rejects.toMatchObject({
      endpoint: "POST /api/subscriptions",
    });
  });
});

describe("the viewer", () => {
  it("resolves to a user with a Clerk-shaped id", async () => {
    const viewer = await getViewer();
    expect(viewer.kind).toBe("user");
    if (viewer.kind === "user") expect(viewer.user.id).toMatch(/^user_/);
  });

  it("denies an anon every capability, because there is no public reading surface", () => {
    expect(() => assertCan(anon, "read")).toThrow(NotAllowedError);
    expect(() => assertCan(anon, "subscribe")).toThrow(NotAllowedError);
  });
});

describe("reads are scoped and paged", () => {
  it("returns one page and a cursor that advances", async () => {
    const viewer = await getViewer();
    const first = await service.listArticles(viewer, { kind: "unread" });
    expect(first.items.length).toBeLessThanOrEqual(PAGE_SIZE);
    expect(first.next).not.toBeNull();

    const second = await service.listArticles(viewer, { kind: "unread" }, first.next!);
    // The bug this catches is the one an OFFSET would cause: a row appearing on
    // both pages, or a row between them going missing.
    const firstIds = new Set(first.items.map((a) => a.id));
    expect(second.items.some((a) => firstIds.has(a.id))).toBe(false);
  });

  it("never returns a read article in the unread scope", async () => {
    const viewer = await getViewer();
    const page = await service.listArticles(viewer, { kind: "unread" });
    expect(page.items.every((a) => a.readAt === null)).toBe(true);
  });

  it("derives the sidebar unread count rather than reading a column", async () => {
    const viewer = await getViewer();
    const subs = await service.listSubscriptions(viewer);
    expect(subs.length).toBeGreaterThan(0);

    for (const s of subs) {
      // Page all the way through rather than checking the first page, so the
      // assertion can be EQUALITY. A `>=` here would pass on any over-count,
      // which is precisely the drift the sidebar count must not have.
      let counted = 0;
      let cursor = undefined as Cursor | undefined;
      do {
        const page = await service.listArticles(viewer, { kind: "feed", feedId: s.feedId }, cursor);
        counted += page.items.filter((a) => a.readAt === null).length;
        cursor = page.next ?? undefined;
      } while (cursor);

      expect(s.unread).toBe(counted);
    }
  });

  it("scopes folders to the reader who filed them", async () => {
    // Catches the read that is correct only while there is one fixture user:
    // folders are per-user (Appendix D), so an unscoped `return [...folders]`
    // works today and leaks another reader's filing the moment M11 lands.
    const viewer = await getViewer();
    const user = viewer.kind === "user" ? viewer.user : null;
    const got = await service.listFolders(viewer);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((f) => f.userId === user!.id)).toBe(true);
    // The corpus carries one folder belonging to another reader, so an
    // unscoped read fails here rather than passing until a second user exists.
    expect(got.some((f) => f.name === "Someone else's folder")).toBe(false);
  });

  it("returns folders in their stored order", async () => {
    const viewer = await getViewer();
    const got = await service.listFolders(viewer);
    const positions = got.map((f) => f.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("returns null for an article the reader does not subscribe to", async () => {
    const viewer = await getViewer();
    expect(await service.getArticle(viewer, 999_999)).toBeNull();
  });

  it("returns an empty log for a feed the reader does not follow", async () => {
    const viewer = await getViewer();
    expect(await service.getFeedHealth(viewer, 999_999)).toEqual([]);
  });
});
