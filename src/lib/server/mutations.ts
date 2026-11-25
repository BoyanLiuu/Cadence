import { resolveSample } from "@/lib/fixtures/discover";
import type {
  DiscoveryResult,
  Extraction,
  FullTextMode,
  ListFilter,
  Scope,
  Subscription,
  Viewer,
} from "@/lib/types";

import { dataSource } from "./article-service";
import { applyReadState, applyScopeRead, type ReadStateResult } from "./read-state.db";
import { discoverAt } from "@/lib/ingest/discover";
import { applyExtraction } from "./extract.db";
import { applySaved, type SavedResult } from "./saved.db";
import {
  addSubscription,
  editSubscription,
  markFollowed,
  removeSubscription,
} from "./subscriptions.db";
import { assertCan, requireUser } from "./viewer";

/*
 * Every write the app will ever make, declared in M1 and implemented later.
 *
 * They exist now, throwing, for one reason: the forms render and validate
 * against the real signature, and the prototype's "nothing was sent" receipts
 * (`ux-03`, `ux-10`, `ux-24`, `ux-44`, `ux-53`) are a designed part of phase 1
 * rather than placeholders. A form wired to a function that does not exist yet
 * gets rewritten when it arrives; a form wired to this one does not.
 *
 * The `endpoint` on the error is what those receipts display, so the screen can
 * say exactly which request was not sent.
 */

/**
 * RETIRED AT M13, and kept rather than deleted — see below.
 *
 * NOTHING THROWS THIS ANY MORE. Every mutation this module declares is
 * implemented, which is the end of the mechanism described above: there is no
 * longer a write that renders a receipt instead of happening, so no screen can
 * tell a reader "nothing was sent" and be right.
 *
 * It stays for two reasons rather than one. `service-contract.test.ts` asserts
 * the set of mutations throwing it is EMPTY, which is a stronger claim than
 * "this list is in sync" and needs the class to express. And a mutation added
 * in a future phase that is wired to a form before it is built should use this
 * rather than inventing a second receipt — the shape, and the argument for it,
 * are worth keeping where they can be found.
 *
 * `NoDatabase` is the one that is still live, and it means something
 * different: the code exists and the configuration does not.
 */
export class NotImplementedInStaticPhase extends Error {
  constructor(
    /** The route that will carry this write (§3). */
    readonly endpoint: string,
    /** The milestone that implements it, so the message says when. */
    readonly milestone: string,
  ) {
    super(`Nothing was sent. ${endpoint} arrives in ${milestone}.`);
    this.name = "NotImplementedInStaticPhase";
  }
}

/**
 * A write that is implemented but has no database to write to.
 *
 * Distinct from `NotImplementedInStaticPhase`, which means "this milestone has
 * not happened yet" and carries the milestone in its message. This means the
 * code exists and the configuration does not — a different thing to tell
 * somebody, and the only honest answer in fixtures mode, where the corpus is
 * deep-frozen and a "write" could only pretend.
 */
export class NoDatabase extends Error {
  constructor(readonly endpoint: string) {
    super(`Nothing was sent. ${endpoint} needs a database, and DATABASE_URL is not configured.`);
    this.name = "NoDatabase";
  }
}

export type SubscribeInput = {
  feedUrl: string;
  folderId?: number | null;
};

export type UpdateSubscriptionInput = {
  folderId?: number | null;
  customTitle?: string | null;
  fullTextMode?: FullTextMode;
  resurfaceOnRevision?: boolean;
  guidTrustOverride?: "auto" | "guid" | "url";
};

/**
 * Resolves a site or feed address to validated candidates. Writes nothing (§6.3).
 *
 * PURE at M5, networked at M12 (Appendix C). At M5 the sample map IS the web;
 * at M12 the same shape comes back from `feedscout` plus a validating fetch of
 * every candidate — which is what lets this screen state the format, the item
 * count and the last post before anyone subscribes (§6.3).
 *
 * Two deviations from Appendix C's one-line sketch, both forced:
 *
 *  - It takes the VIEWER, because §3 requires a session and a rate limit on
 *    this route, and both need to know who is asking.
 *  - It returns `DiscoveryResult`, not `Candidate[]`. An array cannot say
 *    "already followed", "did not answer" or "that is not an address", and
 *    those are three of the four failure states this screen is built around.
 */
export async function discoverFeeds(viewer: Viewer, url: string): Promise<DiscoveryResult> {
  assertCan(viewer, "discover");

  /*
   * FIXTURES MODE KEEPS THE SAMPLE MAP, which is not a fallback but the point
   * of it: a clone with no database still demonstrates every state this screen
   * has, and 561 of this project's tests predate the schema. Appendix C's "M5
   * pure, M12 networked" is this branch.
   */
  if (dataSource !== "db") return resolveSample(url);

  const found = await discoverAt(url);
  if (found.kind !== "found") return found;

  /*
   * ALREADY FOLLOWED is decided in `subscriptions.db`, beside the upsert whose
   * key it compares on, and it is the only part of the answer that depends on
   * WHO is asking — everything else is a fact about the address. §6.3 makes it
   * one of the four distinct outcomes, and it is what lets `addSubscription` be
   * idempotent without the screen pretending a duplicate press was new.
   */
  return markFollowed(requireUser(viewer).id, found.candidates);
}

/**
 * Upserts `feeds` on `url_hash`, so ten readers share one feed row and one
 * fetch. A duplicate subscription returns the existing one rather than erroring.
 */
export async function subscribe(viewer: Viewer, input: SubscribeInput): Promise<Subscription> {
  assertCan(viewer, "subscribe");
  const user = requireUser(viewer);
  if (dataSource !== "db") throw new NoDatabase("POST /api/subscriptions");

  /*
   * VALIDATED HERE, where the trust boundary is. Three separate failures were
   * reachable without this, all of them 500s on a form:
   *
   *   `feedUrl: "my favourite blog"` created a permanent, unfetchable `feeds`
   *   row — permanent because feed rows are deliberately never reaped
   *   (`removeSubscription` explains why), so one typo is a row forever.
   *
   *   `folderId: 1.5` reached `BigInt()` inside `checkFolder` and threw a
   *   RangeError. `feedId` was already checked on the other two mutations; this
   *   one let a folder id past.
   *
   *   `fullTextMode: "whatever"` would have reached the enum column.
   */
  const feedUrl = typeof input?.feedUrl === "string" ? input.feedUrl.trim() : "";
  if (!isHttpUrl(feedUrl)) throw new Error("That is not a feed address.");

  const folderId = input?.folderId ?? null;
  if (folderId !== null && !Number.isSafeInteger(folderId)) {
    throw new Error(`Not a folder id: ${JSON.stringify(folderId)}`);
  }

  return addSubscription(user.id, feedUrl, folderId);
}

/** An address the poller could actually fetch. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** `fullTextMode`'s values, which arrive from a form and are not a type. */
const FULL_TEXT_MODES: readonly FullTextMode[] = ["off", "on_demand", "always"];

export async function updateSubscription(
  viewer: Viewer,
  feedId: number,
  input: UpdateSubscriptionInput,
): Promise<Subscription> {
  assertCan(viewer, "subscribe");
  const user = requireUser(viewer);
  if (dataSource !== "db") throw new NoDatabase("PATCH /api/subscriptions/:feedId");
  if (!Number.isSafeInteger(feedId)) throw new Error(`Not a feed id: ${JSON.stringify(feedId)}`);

  /*
   * `guidTrustOverride` is accepted by the type and NOT forwarded. It is in the
   * database and in this input shape, but not on the `Feed` domain type and not
   * on any screen — Appendix E leaves it as an escape hatch for a feed whose
   * ids cannot be judged automatically. Forwarding it would mean a reader
   * changing a column that belongs to the SHARED feed row, which is the one
   * thing this file refuses throughout. It needs its own decision first.
   */
  if (
    input?.folderId !== undefined &&
    input.folderId !== null &&
    !Number.isSafeInteger(input.folderId)
  ) {
    throw new Error(`Not a folder id: ${JSON.stringify(input.folderId)}`);
  }
  if (input?.fullTextMode !== undefined && !FULL_TEXT_MODES.includes(input.fullTextMode)) {
    throw new Error(`Not a full-text mode: ${JSON.stringify(input.fullTextMode)}`);
  }

  return editSubscription(user.id, feedId, {
    folderId: input?.folderId,
    customTitle: input?.customTitle,
    fullTextMode: input?.fullTextMode,
    resurfaceOnRevision: input?.resurfaceOnRevision,
  });
}

/** The feed row survives while any subscriber remains. */
export async function unsubscribe(viewer: Viewer, feedId: number): Promise<void> {
  assertCan(viewer, "unsubscribe");
  const user = requireUser(viewer);
  if (dataSource !== "db") throw new NoDatabase("DELETE /api/subscriptions/:feedId");
  if (!Number.isSafeInteger(feedId)) throw new Error(`Not a feed id: ${JSON.stringify(feedId)}`);

  return removeSubscription(user.id, feedId);
}

/**
 * Marks articles read or unread. IMPLEMENTED at M11 — the first durable write.
 *
 * Batched and IDEMPOTENT: `read_at = COALESCE(read_at, now())`, so a retry
 * after a dropped connection cannot un-read anything or double-count (§6.2).
 *
 * `assertCan` answers only "is this a signed-in reader". Which articles are
 * THEIRS is a per-row question, and `applyReadState` answers it with the same
 * subscription relation reads use — see `read-state.db.ts`.
 *
 * POSTGRES ONLY, with no fixtures counterpart, and that is the rule for every
 * write rather than a shortcut here. Appendix C's two implementations exist so
 * a READ can be compared; the fixture corpus is deep-frozen, so a fixtures
 * "write" could only lie about having persisted. With no database this throws
 * `NoDatabase`, the route answers 501, and the client gives up and un-dims —
 * so nothing on screen claims a mark that was never recorded.
 */
export async function setReadState(
  viewer: Viewer,
  ids: number[],
  read: boolean,
): Promise<ReadStateResult> {
  assertCan(viewer, "set-read-state");
  const user = requireUser(viewer);

  if (dataSource !== "db") {
    /*
     * `NoDatabase`, not the phase error. That one's message is "… arrives in
     * M11", which is now false and was briefly worse — passing "a database" as
     * the milestone produced the user-visible "arrives in a database."
     */
    throw new NoDatabase("PATCH /api/read-state");
  }

  return applyReadState(user.id, ids, read);
}

/**
 * Marks every article in a scope read — the "Mark all read" button.
 *
 * TAKES THE SCOPE AND THE FILTER, not ids: `/api/read-state` caps a batch at
 * 500 and a view can hold more. The set is resolved on the server against the
 * same `where` the list itself uses, so what gets marked is exactly what was
 * shown — the search term included, which it was not at first.
 *
 * Same gate and same per-row rule as `setReadState`: `assertCan` answers only
 * "is this a signed-in reader", and the subscription relation inside the scope
 * filter answers which articles are theirs.
 */
export async function markScopeRead(
  viewer: Viewer,
  scope: Scope,
  filter?: ListFilter,
): Promise<{ applied: number }> {
  assertCan(viewer, "set-read-state");
  const user = requireUser(viewer);

  /*
   * VALIDATED HERE AS WELL, because this scope crosses a trust boundary: it
   * arrives from a client, and `Scope` is a TypeScript type that guarantees
   * nothing at runtime. `scopeWhere` now throws on an unknown kind, and this is
   * the second line of that defence rather than a duplicate of it — refusing at
   * the edge means a malformed scope never reaches a query builder at all.
   *
   * This is not hypothetical. Before either check existed, `{}` resolved to
   * `where: undefined`, which Prisma reads as no filter — one call marked the
   * seeded corpus's 124 articles read, across feeds the reader does not follow.
   */
  if (!isScope(scope)) {
    throw new Error(`Not a scope: ${JSON.stringify(scope)}`);
  }

  if (dataSource !== "db") throw new NoDatabase("mark all read");

  return applyScopeRead(user.id, scope, filter);
}

/** A runtime check for `Scope`, which as a type is only a compile-time promise. */
function isScope(value: unknown): value is Scope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as { kind?: unknown; feedId?: unknown; folderId?: unknown };
  switch (scope.kind) {
    case "unread":
    case "all":
    case "saved":
      return true;
    // INTEGERS, not just numbers. `1.5` passed a `typeof` check, reached
    // `BigInt()` inside Prisma, and surfaced as a RangeError on the button.
    case "feed":
      return Number.isSafeInteger(scope.feedId);
    case "folder":
      return Number.isSafeInteger(scope.folderId);
    default:
      return false;
  }
}

export async function saveArticle(viewer: Viewer, id: number, saved = true): Promise<SavedResult> {
  assertCan(viewer, "save");
  const user = requireUser(viewer);
  if (dataSource !== "db") throw new NoDatabase("saving an article");

  return applySaved(user.id, id, saved);
}

/**
 * Reads the full text off the article's page, once and cached forever (§6.5).
 *
 * ONE PAGE LOAD PER ARTICLE A PERSON OPENED is the entire justification for
 * being allowed to fetch at all: at ingest this would be an `[assumed]` 9 000
 * unrequested page loads a day, which §6.5 calls the line between a reader and
 * a crawler. So "cached forever" is not a performance choice here.
 */
export async function extractArticle(viewer: Viewer, id: number): Promise<Extraction> {
  assertCan(viewer, "extract");
  const user = requireUser(viewer);
  if (dataSource !== "db") throw new NoDatabase("POST /api/articles/:id/extract");

  return applyExtraction(user.id, id);
}
