import { prisma } from "@/lib/db/client";

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
