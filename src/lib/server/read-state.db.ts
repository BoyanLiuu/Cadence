import { prisma } from "@/lib/db/client";
import type { ListFilter, Scope } from "@/lib/types";

import { scopedArticleWhere } from "./article-service.db";

/*
 * Durable read state (§6.2, M11).
 *
 * THREE PROPERTIES, and each one is a bug that has shipped in other readers:
 *
 *  1. IDEMPOTENT. `read_at = COALESCE(read_at, now())`, so replaying a batch
 *     after a dropped connection leaves the original timestamp alone. The
 *     alternative — assigning `now()` on conflict — moves the mark every retry,
 *     and "when did I read this" stops meaning anything.
 *  2. LAZY. A row is written only for an article actually being marked. The
 *     tempting shape is a row per article per subscriber at subscribe time,
 *     which is 500 writes for one click on a feed with 500 articles and a table
 *     that grows with the product of readers and articles. Unread is derived
 *     from the ABSENCE of a row (§6.2), which is what makes that possible.
 *  3. SCOPED BY THE SAME RELATION READS USE. An article is this reader's to
 *     mark only if it arrived through a feed they follow. RLS is bypassed by
 *     the owning role, so this filter IS the authorization model (§3) — not a
 *     convenience on top of one.
 *
 * MARKING UNREAD SETS `read_at` TO NULL RATHER THAN DELETING THE ROW. The row
 * also carries `saved_at` and `was_read_at`, so deleting it to express "unread"
 * would silently unsave the article. Reads test `read_at IS NOT NULL`, so a
 * null is exactly as unread as no row at all.
 */

export type ReadStateResult = {
  /** Articles whose state now matches the request. */
  applied: number;
  /**
   * Ids the reader cannot reach through any feed they follow.
   *
   * REPORTED RATHER THAN SILENT. Zero here is the normal case, and a non-zero
   * count means either a client bug or someone posting ids they guessed — both
   * worth seeing. The rows are not written either way.
   */
  ignored: number;
};

/**
 * Marks articles read or unread for one reader.
 *
 * `ids` is deduplicated and the whole batch is one statement per direction, so
 * a 50-row flush is not 50 round trips.
 */
export async function applyReadState(
  userId: string,
  ids: number[],
  read: boolean,
): Promise<ReadStateResult> {
  /*
   * DEDUPLICATE, THEN VALIDATE, and count what falls out on the way.
   *
   * Ids rejected here used to be counted in neither bucket, so a client sending
   * junk got `{ applied: 0, ignored: 0 }` — which reads as "nothing to do"
   * rather than "none of that was usable", and contradicts what `ignored`
   * promises. The early return also counted `ids.length` where the main path
   * counts unique ones, so the same batch reported differently depending on
   * whether anything in it was valid.
   */
  const unique = [...new Set(ids)];
  const usable = unique.filter((id) => Number.isSafeInteger(id) && id > 0);

  if (usable.length === 0) return { applied: 0, ignored: unique.length };

  const asBigInt = usable.map((id) => BigInt(id));

  /*
   * REACHABILITY FIRST, as its own query, and deliberately not folded into the
   * write's `WHERE`.
   *
   * Folding it in would be fewer statements and would silently apply to the
   * subset — leaving no way to tell "nothing to do" from "you asked about
   * someone else's articles". The count is the only thing that distinguishes a
   * client bug from a quiet success.
   *
   * The relation is the one `scopeWhere` uses for reads: an arrival through a
   * feed this reader subscribes to. Checking the subscription on the ARRIVING
   * feed rather than on the article is what stops a shared article being
   * reachable through somebody else's subscription.
   */
  const reachable = await prisma.article.findMany({
    where: {
      id: { in: asBigInt },
      arrivals: { some: { feed: { subscriptions: { some: { userId } } } } },
    },
    select: { id: true },
  });

  if (reachable.length === 0) return { applied: 0, ignored: unique.length };

  const reachableIds = reachable.map((row) => row.id);

  if (read) {
    /*
     * `createMany` + `skipDuplicates` cannot express this: the conflict needs
     * an UPDATE that preserves an existing timestamp, which is
     * `ON CONFLICT … DO UPDATE SET read_at = COALESCE(excluded…, existing)`.
     * Prisma's query API has no on-conflict-update for a batch, so this is raw
     * — SCHEMA-QUALIFIED, because `$queryRaw` is passed through verbatim and
     * the connection's `search_path` does not include `cadence`.
     *
     * `was_read_at` is left alone. It belongs to the resurfacing rule (§6.2),
     * which is the only thing that should write it.
     */
    await prisma.$executeRaw`
      INSERT INTO cadence.user_articles (user_id, article_id, read_at)
      SELECT ${userId}, id, now()
      FROM unnest(${reachableIds}::bigint[]) AS id
      ON CONFLICT (user_id, article_id)
      DO UPDATE SET read_at = COALESCE(cadence.user_articles.read_at, now())
    `;
  } else {
    /*
     * Only rows that EXIST need clearing — an article with no row is already
     * unread, and inserting one to say so would defeat property 2.
     */
    await prisma.userArticle.updateMany({
      where: { userId, articleId: { in: reachableIds } },
      data: { readAt: null },
    });
  }

  return { applied: reachableIds.length, ignored: unique.length - reachableIds.length };
}

/**
 * Marks everything in a scope read — the "Mark all read" button.
 *
 * NOT AN ID LIST, and that is the whole reason this exists separately.
 * `PATCH /api/read-state` caps a batch at 500 because it is reachable by anyone
 * with a session and the work is proportional to the ids; a scope can hold more
 * than that, and a client paging through its own ids to work around the cap
 * would be doing the database's job badly. So the scope travels instead and the
 * set is resolved here.
 *
 * IT USES THE SAME `where` THE LIST USES, imported rather than rewritten. The
 * articles marked have to be exactly the articles shown — INCLUDING the search
 * filter, whose omission meant a reader looking at three search results marked
 * every unread article in the scope. The subscription relation inside that
 * filter is also the authorization check (§3), so a second copy would be two
 * chances to disagree with the write being the dangerous one.
 *
 * The id fetch is unbounded, which is a real limit rather than an oversight: a
 * personal reader's widest view is thousands of rows, and `unnest` takes an
 * array that size. A shared instance would want this paged.
 *
 * Idempotent on the same terms as the batch path: `COALESCE` keeps an existing
 * `read_at`, so a double-click marks nothing twice and moves no timestamp.
 */
export async function applyScopeRead(
  userId: string,
  scope: Scope,
  filter?: ListFilter,
): Promise<{ applied: number }> {
  const where = await scopedArticleWhere(userId, scope, filter);
  if (where === null) return { applied: 0 };

  /*
   * The ids are fetched and sent back rather than resolved inside one
   * `INSERT … SELECT`, because the filter is a Prisma `where` and not SQL. The
   * cost is one round trip carrying the ids; the alternative is hand-writing
   * the scope rules in SQL, which is the duplication this function exists to
   * avoid. A personal reader's "all unread" is thousands of rows at the very
   * most, and `unnest` takes an array that size without complaint.
   */
  const rows = await prisma.article.findMany({ where, select: { id: true } });
  if (rows.length === 0) return { applied: 0 };

  const ids = rows.map((row) => row.id);
  await prisma.$executeRaw`
    INSERT INTO cadence.user_articles (user_id, article_id, read_at)
    SELECT ${userId}, id, now()
    FROM unnest(${ids}::bigint[]) AS id
    ON CONFLICT (user_id, article_id)
    DO UPDATE SET read_at = COALESCE(cadence.user_articles.read_at, now())
  `;

  return { applied: ids.length };
}
