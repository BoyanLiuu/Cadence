import { NotImplementedInStaticPhase } from "@/lib/server/mutations";

/*
 * Replay-and-merge: the repair for a problem the canonicaliser creates.
 *
 * §6.1 requires this to be written ALONGSIDE the normaliser rather than when
 * it is first needed, and the reason is mechanical rather than cautious.
 *
 * `articles.url_hash` carries a UNIQUE index — that IS rung 2. When
 * `NORM_VERSION` is bumped, rows that were legitimately distinct under v1 can
 * be EQUAL under v2:
 *
 *     row 412   site.example/post/a           v1: h(post/a)        v2: h(post/a)
 *     row 907   site.example/post/a?si=xyz    v1: h(post/a?si=xyz) v2: h(post/a)  ← collides
 *
 * So the obvious migration — "re-hash every row" — FAILS. Both rows want the
 * same `url_hash` and the unique index rejects the second. You cannot re-hash
 * without merging, and you cannot merge without deciding what happens to read
 * state. That decision is the whole of this file.
 *
 * It is also the same operation as the manual escape hatch:
 * `POST /api/articles/merge` (M12) is this, for a group of exactly two.
 */

/** One article row, reduced to the fields a merge decision needs. */
export type MergeCandidate = {
  id: number;
  /** The address as stored, which the new ruleset is replayed over. */
  url: string;
  /**
   * Every ADDRESS this row has ever been reachable at, as a URL.
   *
   * Addresses, not hashes, and that distinction is load-bearing. A v1 hash
   * cannot be replayed under v2 — it is a digest, not an input — so carrying
   * the old hashes forward leaves them dead: after the bump, ingestion looks
   * up v2 hashes and will never match a v1 one again. The alternate address
   * then resolves to nothing and the next poll re-inserts it as a new
   * article, which is precisely what `article_urls` exists to prevent.
   *
   * SCHEMA CONSEQUENCE FOR M6: Appendix D's `article_urls` is
   * `(article_id, url_hash, first_seen_at)` with no URL column. It needs one,
   * or a `norm_version` bump can never replay the alternates it owns.
   */
  knownUrls: string[];
  /** Per-user state, from `user_articles`. A missing entry means unread. */
  userState: {
    userId: string;
    readAt: string | null;
    savedAt: string | null;
  }[];
};

/** What one collapsing group becomes. */
export type MergePlanGroup = {
  /** The new key every row in this group now hashes to. */
  urlHash: string;
  /** The row that survives: the OLDEST id. */
  keepId: number;
  /** The rows merged into it and then deleted. */
  dropIds: number[];
  /**
   * The union of per-user state, which the winner must end up carrying.
   *
   * Earliest non-null wins for both timestamps. Losing a read is the failure
   * that makes the unread count lie, and the count is what §6.1 says the
   * product's credibility rests on — so the merge can only ever ADD read
   * state, never remove it.
   */
  userState: { userId: string; readAt: string | null; savedAt: string | null }[];
  /**
   * Every address from every row in the group, which all move to the winner.
   *
   * This is why `article_urls` is one-to-many. Without it the loser's address
   * resolves to nothing and the next poll re-inserts it as a new article — so
   * a migration meant to REMOVE duplicates would manufacture them.
   */
  urlHashes: string[];
};

export type MergePlan = {
  /** Groups that need merging: every one has at least two rows. */
  groups: MergePlanGroup[];
  /** Rows whose key changed but which collide with nothing — a plain update. */
  rehashOnly: { id: number; urlHash: string }[];
  /** Rows the new ruleset leaves untouched. */
  unchanged: number;
};

/**
 * Earliest of two nullable timestamps; null only when both are null.
 *
 * Compared as INSTANTS, not as strings. A lexicographic compare is right only
 * while every value is UTC with the same precision — and
 * `2026-11-01T00:00:00+02:00` sorts after `2026-11-01T01:00:00Z` as text while
 * being the earlier instant. Getting that backwards moves a read forward in
 * time, which breaks the one guarantee this function has: a merge may only
 * ever ADD read state.
 */
function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  // An unparseable timestamp falls back to a string compare rather than
  // silently losing to NaN.
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a < b ? a : b;
  return ta <= tb ? a : b;
}

/**
 * Works out what a `NORM_VERSION` bump would do, without touching anything.
 *
 * PURE, and that is the point of having it this early: the dangerous part of
 * the migration is the grouping and the state union, not the SQL. Both can be
 * tested against fixtures today, with no schema, rather than being written
 * against a live table during an incident.
 *
 * @param rows   every article, with its stored URL and current hash
 * @param rehash the new ruleset — `canonicalUrl` composed with the hasher
 */
export function planMerges(
  rows: { candidate: MergeCandidate; currentUrlHash: string }[],
  rehash: (url: string) => string | null,
): MergePlan {
  const byNewHash = new Map<string, { candidate: MergeCandidate; currentUrlHash: string }[]>();
  let unchanged = 0;

  for (const row of rows) {
    const next = rehash(row.candidate.url);
    /*
     * A row the new ruleset cannot key keeps its EXISTING hash, and is bucketed
     * under it rather than set aside.
     *
     * Setting it aside was a real bug: it still occupies that `url_hash` in the
     * table, so if another row's NEW hash happens to equal it, the migration
     * writes a duplicate key and the UNIQUE index rejects it — mid-migration,
     * after some rows have already been merged. Bucketing it means the
     * collision is seen at planning time, where it is a group rather than a
     * failure.
     */
    const key = next ?? row.currentUrlHash;
    const bucket = byNewHash.get(key);
    if (bucket) bucket.push(row);
    else byNewHash.set(key, [row]);
  }

  const groups: MergePlanGroup[] = [];
  const rehashOnly: { id: number; urlHash: string }[] = [];

  for (const [urlHash, bucket] of byNewHash) {
    if (bucket.length === 1) {
      const only = bucket[0];
      if (only.currentUrlHash === urlHash) unchanged += 1;
      else rehashOnly.push({ id: only.candidate.id, urlHash });
      continue;
    }

    // Oldest id wins. It is the row readers have already read, already saved,
    // and whose id is already in their history — so keeping it is the choice
    // that breaks the fewest things outside this table.
    const sorted = [...bucket].sort((a, b) => a.candidate.id - b.candidate.id);
    const keep = sorted[0];
    const drop = sorted.slice(1);

    const merged = new Map<
      string,
      { userId: string; readAt: string | null; savedAt: string | null }
    >();
    for (const row of sorted) {
      for (const state of row.candidate.userState) {
        const existing = merged.get(state.userId);
        merged.set(
          state.userId,
          existing
            ? {
                userId: state.userId,
                readAt: earliest(existing.readAt, state.readAt),
                savedAt: earliest(existing.savedAt, state.savedAt),
              }
            : { ...state },
        );
      }
    }

    groups.push({
      urlHash,
      keepId: keep.candidate.id,
      dropIds: drop.map((d) => d.candidate.id),
      userState: [...merged.values()].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
      /*
       * Every key the winner must answer to afterwards:
       *
       *  - the new key itself;
       *  - every member's CURRENT hash, because that is the address a feed is
       *    still publishing right now. These were missing, and without them
       *    the next poll resolves a loser's address to nothing and inserts a
       *    new article — a migration meant to remove duplicates manufacturing
       *    them;
       *  - every alternate address REPLAYED through the new ruleset, because
       *    a v1 digest cannot be re-derived and so would be dead weight.
       *
       * Deduplicated and sorted so a plan is comparable between runs.
       */
      urlHashes: [
        ...new Set(
          [
            urlHash,
            ...sorted.map((r) => r.currentUrlHash),
            ...sorted.flatMap((r) => r.candidate.knownUrls.map((u) => rehash(u))),
          ].filter((h): h is string => h !== null),
        ),
      ].sort(),
    });
  }

  return {
    groups: groups.sort((a, b) => a.keepId - b.keepId),
    rehashOnly: rehashOnly.sort((a, b) => a.id - b.id),
    unchanged,
  };
}

/**
 * Applies a plan, in one transaction.
 *
 * Declared now and implemented at M6, when there are tables to write to. The
 * contract it must honour, in this order, because every step depends on the
 * one before:
 *
 *  1. Move every `article_urls` row from the losers onto the winner FIRST, so
 *     no address is ever unresolvable — not even briefly, since a concurrent
 *     poll would re-insert it.
 *  2. Upsert the unioned `user_articles` onto the winner with
 *     `read_at = COALESCE(read_at, …)` semantics, so the merge can only add
 *     read state.
 *  3. Re-point `summaries` and any other child rows at the winner.
 *  4. Delete the losers.
 *  5. Write the new `url_hash` and `norm_version` on the winner.
 *
 * Steps 1–5 must be ONE transaction. A merge that half-applies leaves rows
 * pointing at a deleted article, which is worse than the duplicates it was
 * fixing.
 */
export async function applyMergePlan(plan: MergePlan): Promise<void> {
  void plan;
  throw new NotImplementedInStaticPhase("replay-and-merge migration", "M6");
}
