import type { Candidate, Extraction, FullTextMode, Subscription, Viewer } from "@/lib/types";

import { assertCan } from "./viewer";

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
 * Takes the viewer, unlike Appendix C's sketch of `discoverFeeds(url)`: §3
 * requires a session and a rate limit on this route, and both need to know who
 * is asking. Keeping the viewer first also keeps one rule for every function in
 * the layer rather than one exception.
 */
export async function discoverFeeds(viewer: Viewer, url: string): Promise<Candidate[]> {
  assertCan(viewer, "discover");
  void url;
  throw new NotImplementedInStaticPhase(
    "POST /api/feeds/discover",
    "M5 (pure) and M12 (networked)",
  );
}

/**
 * Upserts `feeds` on `url_hash`, so ten readers share one feed row and one
 * fetch. A duplicate subscription returns the existing one rather than erroring.
 */
export async function subscribe(viewer: Viewer, input: SubscribeInput): Promise<Subscription> {
  assertCan(viewer, "subscribe");
  void input;
  throw new NotImplementedInStaticPhase("POST /api/subscriptions", "M11");
}

export async function updateSubscription(
  viewer: Viewer,
  feedId: number,
  input: UpdateSubscriptionInput,
): Promise<Subscription> {
  assertCan(viewer, "subscribe");
  void feedId;
  void input;
  throw new NotImplementedInStaticPhase("PATCH /api/subscriptions/:feedId", "M11");
}

/** The feed row survives while any subscriber remains. */
export async function unsubscribe(viewer: Viewer, feedId: number): Promise<void> {
  assertCan(viewer, "unsubscribe");
  void feedId;
  throw new NotImplementedInStaticPhase("DELETE /api/subscriptions/:feedId", "M11");
}

/**
 * Batched and IDEMPOTENT: `read_at = COALESCE(read_at, now())`, so a retry after
 * a dropped connection cannot un-read anything or double-count (§6.2).
 */
export async function setReadState(viewer: Viewer, ids: number[], read: boolean): Promise<void> {
  assertCan(viewer, "set-read-state");
  void ids;
  void read;
  throw new NotImplementedInStaticPhase("PATCH /api/read-state", "M11");
}

export async function saveArticle(viewer: Viewer, id: number, saved = true): Promise<void> {
  assertCan(viewer, "save");
  void id;
  void saved;
  throw new NotImplementedInStaticPhase("PATCH /api/read-state", "M12");
}

/**
 * The manual dedup escape hatch: writes the loser's `url_hash` into the
 * winner's `article_urls`, so the merged address keeps resolving (§6.1).
 */
export async function mergeArticles(
  viewer: Viewer,
  keepId: number,
  mergeId: number,
): Promise<void> {
  assertCan(viewer, "merge");
  void keepId;
  void mergeId;
  throw new NotImplementedInStaticPhase("POST /api/articles/merge", "M12");
}

/** One fetch per article, cached forever, per-host concurrency of 1 (§6.5). */
export async function extractArticle(viewer: Viewer, id: number): Promise<Extraction> {
  assertCan(viewer, "extract");
  void id;
  throw new NotImplementedInStaticPhase("POST /api/articles/:id/extract", "M13");
}
