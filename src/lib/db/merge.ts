import { prisma } from "@/lib/db/client";
import { NORM_VERSION } from "@/lib/ingest/canonical-url";

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
   *
   * Each hash is carried WITH the URL that produced it, and that pairing is
   * load-bearing rather than informational. A replayed alternate is a hash no
   * row holds yet — `applyMergePlan` has to INSERT it — and `article_urls.url`
   * is NOT NULL precisely so the next bump can replay it in turn. A plan
   * carrying bare hashes cannot write those rows at all, which would make the
   * column M3's review added unfillable by the one caller that needs it.
   */
  addresses: { urlHash: string; url: string }[];
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
 * Drops unkeyable entries and duplicate hashes, then sorts by hash.
 *
 * FIRST URL WINS for a repeated hash. Two addresses collapsing to one hash is
 * the normal case after a bump — that is what a bump DOES — and `article_urls`
 * is keyed on the hash, so only one of them can be stored. Keeping the first
 * makes the plan deterministic, which is what lets two runs be compared.
 */
function dedupeAddresses(
  entries: { urlHash: string | null; url: string }[],
): { urlHash: string; url: string }[] {
  const byHash = new Map<string, string>();
  for (const entry of entries) {
    if (entry.urlHash === null) continue;
    if (!byHash.has(entry.urlHash)) byHash.set(entry.urlHash, entry.url);
  }
  return [...byHash.entries()]
    .map(([urlHash, url]) => ({ urlHash, url }))
    .sort((a, b) => (a.urlHash < b.urlHash ? -1 : a.urlHash > b.urlHash ? 1 : 0));
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
      addresses: dedupeAddresses([
        // The group's new key. Every member rehashes to it, so the winner's
        // URL is as good a source as any and is the one that survives.
        { urlHash, url: keep.candidate.url },
        // Each member's CURRENT hash, which is the v1 digest of that member's
        // stored URL — the address a feed is still publishing right now.
        ...sorted.map((r) => ({ urlHash: r.currentUrlHash, url: r.candidate.url })),
        // Every alternate, REPLAYED. A v1 digest cannot be re-derived, so
        // carrying the old hash forward would leave it dead and the next poll
        // would re-insert that address as a new article.
        ...sorted.flatMap((r) =>
          r.candidate.knownUrls.map((u) => ({ urlHash: rehash(u), url: u })),
        ),
      ]),
    });
  }

  return {
    groups: groups.sort((a, b) => a.keepId - b.keepId),
    rehashOnly: rehashOnly.sort((a, b) => a.id - b.id),
    unchanged,
  };
}

/*
 * Prisma's interactive-transaction defaults are 2s to acquire and 5s to run,
 * and 5s is not a budget this work fits in.
 *
 * A group's write is step 1b's one round trip PER REPLAYED ADDRESS plus five
 * fixed statements, against a REMOTE Postgres at roughly a hundred
 * milliseconds each. A group with a dozen alternates is already past five
 * seconds, and the timeout aborts it MID-MIGRATION — leaving the plan
 * half-applied across groups, which is the state this function is written to
 * avoid.
 *
 * Generous rather than tuned: this runs once per `NORM_VERSION` bump, so the
 * cost of a long ceiling is nothing and the cost of a short one is an
 * incident.
 */
const TX_OPTIONS = { timeout: 120_000, maxWait: 30_000 };

/** What applying a plan actually did, for the migration's own log. */
export type MergeApplied = {
  groupsMerged: number;
  rowsDeleted: number;
  addressesMoved: number;
  rehashed: number;
};

/**
 * Applies a plan, ONE TRANSACTION PER GROUP.
 *
 * The step order below is not stylistic — every step depends on the one before,
 * and getting it wrong produces exactly the duplicates the migration exists to
 * remove:
 *
 *  1. Move the losers' `article_urls` rows onto the winner FIRST, and insert
 *     every replayed alternate. No address may be unresolvable, not even
 *     briefly: a concurrent poll that looks one up and misses re-inserts it as
 *     a new article.
 *  2. Union `user_articles` onto the winner with `COALESCE`-and-`LEAST`
 *     semantics, so the merge can only ever ADD read state. Losing a read is
 *     what makes the unread count lie, and §6.1 puts the product's credibility
 *     on that count.
 *  3. Re-point `summaries` and `article_feeds` at the winner.
 *  4. Delete the losers — only now that nothing references them.
 *  5. Write the new `url_hash` and `norm_version` on the winner.
 *
 * ONE TRANSACTION PER GROUP, not one for the whole plan. A bump over a large
 * table is thousands of groups; a single transaction would hold locks on most
 * of `articles` for the duration and time out against a pooled connection.
 * Per-group is still atomic where atomicity matters — a half-applied GROUP is
 * what leaves rows pointing at a deleted article — and a plan that stops
 * halfway leaves earlier groups correctly merged and later ones simply not yet
 * started, which is resumable by re-planning.
 */
export async function applyMergePlan(plan: MergePlan): Promise<MergeApplied> {
  const applied: MergeApplied = {
    groupsMerged: 0,
    rowsDeleted: 0,
    addressesMoved: 0,
    rehashed: 0,
  };

  for (const group of plan.groups) {
    const keepId = BigInt(group.keepId);
    const dropIds = group.dropIds.map((id) => BigInt(id));

    await prisma.$transaction(async (tx) => {
      // ---- STEP 1a: the losers' addresses become the winner's.
      //
      // An UPDATE rather than insert-and-delete, so each row keeps its `url`
      // and its original `first_seen_at`. `url_hash` is the primary key, so
      // no row can collide with one the winner already holds.
      const moved = await tx.$executeRaw`
        UPDATE cadence.article_urls SET article_id = ${keepId}
        WHERE article_id = ANY(${dropIds}::bigint[])
      `;

      // ---- STEP 1b: every replayed alternate, which no row holds yet.
      //
      // `DO NOTHING` rather than repointing: a hash held by an article
      // OUTSIDE this group is a conflict the manual merge exists for, and
      // stealing it would silently move an address between articles.
      for (const address of group.addresses) {
        await tx.$executeRaw`
          INSERT INTO cadence.article_urls (url_hash, article_id, url, first_seen_at)
          VALUES (decode(${address.urlHash}, 'hex'), ${keepId}, ${address.url}, now())
          ON CONFLICT (url_hash) DO NOTHING
        `;
      }

      /*
       * ---- STEP 2: the unioned read state, aggregated from the ROWS.
       *
       * Read from `user_articles` rather than from `group.userState`, and that
       * is deliberate. A plan is computed as a dry run and may be applied much
       * later; read state changes constantly in between. Replaying the plan's
       * snapshot would DISCARD every read that happened since it was made,
       * which is the one thing a merge may never do. The planner's union stays
       * as the preview; the executor unions what is actually there.
       *
       * It also carries every column automatically. `was_read_at` was missing
       * when this was built from the plan, because `MergePlanGroup.userState`
       * has no such field — so M8's resurface state was silently dropped with
       * the losers.
       *
       * `min()` IGNORES NULLS, which is exactly the semantics wanted: the
       * earliest non-null timestamp wins and a null never erases a real one.
       * `LEAST` and `GREATEST` skip nulls the same way. `COALESCE` alone would
       * have kept whichever row happened to be written first.
       *
       * ONE aggregate over all losers, not a statement per loser.
       * `UPDATE ... FROM user_articles AS loser` with two losers joins twice
       * and takes ONE of them unpredictably — so `progress` lost the furthest
       * read position whenever a group had more than one loser, which is the
       * case this whole function exists for.
       */
      await tx.$executeRaw`
        INSERT INTO cadence.user_articles
          (user_id, article_id, read_at, saved_at, progress, was_read_at)
        SELECT user_id, ${keepId},
               min(read_at), min(saved_at), max(progress), min(was_read_at)
        FROM cadence.user_articles
        WHERE article_id = ANY(${dropIds}::bigint[])
        GROUP BY user_id
        ON CONFLICT (user_id, article_id) DO UPDATE SET
          read_at     = LEAST(cadence.user_articles.read_at,     EXCLUDED.read_at),
          saved_at    = LEAST(cadence.user_articles.saved_at,    EXCLUDED.saved_at),
          progress    = GREATEST(cadence.user_articles.progress, EXCLUDED.progress),
          was_read_at = LEAST(cadence.user_articles.was_read_at, EXCLUDED.was_read_at)
      `;

      // ---- STEP 3: the remaining children.
      //
      // Summaries move only where the winner has no summary for that
      // `content_hash` — `(article_id, content_hash)` is unique, and two
      // merged rows with identical bodies both have one. The duplicate is
      // dropped with its article in step 4; it describes the same text.
      await tx.$executeRaw`
        UPDATE cadence.summaries SET article_id = ${keepId}
        WHERE article_id = ANY(${dropIds}::bigint[])
          AND NOT EXISTS (
            SELECT 1 FROM cadence.summaries keep
            WHERE keep.article_id = ${keepId}
              AND keep.content_hash = cadence.summaries.content_hash
          )
      `;
      // Arrivals: the losers' feeds genuinely delivered this article, so the
      // winner must answer for them or "also in 2 feeds" undercounts after a
      // bump.
      await tx.$executeRaw`
        INSERT INTO cadence.article_feeds (article_id, feed_id, first_seen_at)
        SELECT ${keepId}, feed_id, first_seen_at FROM cadence.article_feeds
        WHERE article_id = ANY(${dropIds}::bigint[])
        ON CONFLICT (article_id, feed_id) DO NOTHING
      `;

      // ---- STEP 4: the losers go.
      //
      // `user_articles`, `summaries` and `article_feeds` rows still on a loser
      // at this point are the duplicates step 2 and 3 deliberately did not
      // move, and they cascade.
      const deleted = await tx.$executeRaw`
        DELETE FROM cadence.articles WHERE id = ANY(${dropIds}::bigint[])
      `;

      // ---- STEP 5: the winner's new key.
      //
      // LAST, because until the losers are gone the unique index on
      // `url_hash` may still be holding this value.
      await tx.$executeRaw`
        UPDATE cadence.articles
        SET url_hash = decode(${group.urlHash}, 'hex'), norm_version = ${NORM_VERSION}
        WHERE id = ${keepId}
      `;

      applied.groupsMerged += 1;
      applied.rowsDeleted += deleted;
      applied.addressesMoved += moved;
    }, TX_OPTIONS);
  }

  /*
   * The collision-free rehashes, in TWO passes.
   *
   * The planner proves no two rows want the SAME new hash — that is what makes
   * these "collision-free" and not groups. It does NOT prove a row's new hash
   * is free, and that gap is a real failure:
   *
   *     row 412   url_hash H1   ->  H2
   *     row 907   url_hash H2   ->  H3     <- still holding H2
   *
   * Neither shares a new hash with anyone, so both land here. But `url_hash`
   * is uniquely indexed and the index is checked per row as the statement
   * walks them, in an order nothing specifies — so if 412 is updated before
   * 907 vacates H2, the update is REFUSED mid-migration. A swap (`H1 -> H2`,
   * `H2 -> H1`) cannot be ordered correctly at all.
   *
   * Vacating everything first removes the question rather than answering it.
   * Pass 1 gives every row a random hash, which cannot collide with anything;
   * pass 2 writes the real ones, which by then nothing holds. No ordering, no
   * topological sort, no special case for cycles.
   *
   * A random hash is safe as an intermediate because NOTHING RESOLVES ON
   * `articles.url_hash` — rung 2 reads `article_urls`, which neither pass
   * touches. So even a process killed between the passes leaves every address
   * still resolving, and a re-plan recomputes from `url`, which is untouched
   * too. `norm_version` is written in pass 2, so a half-done row still reads
   * as needing the bump.
   */
  const BATCH = 500;
  const rehashIds = plan.rehashOnly.map((r) => BigInt(r.id));

  for (let i = 0; i < rehashIds.length; i += BATCH) {
    const ids = rehashIds.slice(i, i + BATCH);
    // `id` is mixed into the digest as well as `random()`, so two rows cannot
    // collide even on a repeated random draw.
    await prisma.$executeRaw`
      UPDATE cadence.articles
      SET url_hash = decode(md5(random()::text || id::text), 'hex')
      WHERE id = ANY(${ids}::bigint[])
    `;
  }

  for (let i = 0; i < plan.rehashOnly.length; i += BATCH) {
    const batch = plan.rehashOnly.slice(i, i + BATCH);
    const ids = batch.map((r) => BigInt(r.id));
    const hashes = batch.map((r) => r.urlHash);
    applied.rehashed += await prisma.$executeRaw`
      UPDATE cadence.articles AS a SET
        url_hash = decode(v.url_hash, 'hex'),
        norm_version = ${NORM_VERSION}
      FROM unnest(${ids}::bigint[], ${hashes}::text[]) AS v(id, url_hash)
      WHERE a.id = v.id
    `;
  }

  return applied;
}
