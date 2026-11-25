import { prisma } from "@/lib/db/client";

import { reachableArticles } from "./read-state.db";

/*
 * The saved shelf (§2, M12).
 *
 * `saved_at` SITS ON THE SAME ROW AS `read_at` AND SHARES NOTHING ELSE WITH IT.
 * That is the whole reason this is a separate function rather than a field on
 * the read-state batch: read marks are automatic and plural — the scroll
 * observer produces them by the screenful and flushes every two seconds — while
 * a save is one deliberate press on one article. Folding it in would hand it an
 * `ids` array it never has more than one of, and a retry policy designed for a
 * background flush it is not.
 *
 * ARCHITECTURE's Writes table had no endpoint for this at all; the stub named
 * its neighbour's by borrowing. Settled at M12: a server action, because a
 * route is for a machine caller and this is a button someone pressed. The
 * reasoning is in the memo.
 *
 * Three properties, the same three read state has and for the same reasons:
 *
 *   IDEMPOTENT. `saved_at = COALESCE(saved_at, now())`, so pressing Save twice
 *   keeps the moment it was first filed. "When did I save this" is the only
 *   thing the saved shelf can order by.
 *
 *   SCOPED BY THE RELATION READS USE, through `reachableArticles` rather than a
 *   second copy of the filter. An id is a number and there is no RLS behind it.
 *
 *   UNSAVING CLEARS, NEVER DELETES. `read_at` is on the same row, so removing
 *   it to express "not saved" would silently mark the article unread.
 */

export type SavedResult = { saved: boolean };

export class ArticleNotReachable extends Error {
  constructor(readonly articleId: number) {
    super("That article is not in any feed you follow.");
    this.name = "ArticleNotReachable";
  }
}

/** Files one article on the saved shelf, or takes it off. */
export async function applySaved(
  userId: string,
  articleId: number,
  saved: boolean,
): Promise<SavedResult> {
  if (!Number.isSafeInteger(articleId) || articleId <= 0) {
    throw new ArticleNotReachable(articleId);
  }

  const id = BigInt(articleId);
  const reachable = await reachableArticles(userId, [id]);

  /*
   * REFUSED, not reported as a count. Read state takes a batch and reports what
   * it ignored, because one stale id must not fail a whole flush; this is a
   * single press on a single article, so there is nothing to partially apply
   * and silence would leave the button looking like it worked.
   */
  if (reachable.length === 0) throw new ArticleNotReachable(articleId);

  if (saved) {
    /*
     * Raw and SCHEMA-QUALIFIED, because Prisma's query API has no
     * on-conflict-update that can preserve an existing value — the conflict
     * needs `COALESCE`, not an overwrite.
     */
    await prisma.$executeRaw`
      INSERT INTO cadence.user_articles (user_id, article_id, saved_at)
      VALUES (${userId}, ${id}, now())
      ON CONFLICT (user_id, article_id)
      DO UPDATE SET saved_at = COALESCE(cadence.user_articles.saved_at, now())
    `;
  } else {
    /*
     * Only an existing row needs clearing: an article with no row was never
     * saved, and inserting one to record that would grow the table for nothing
     * — the same laziness read state relies on (§6.2).
     */
    await prisma.userArticle.updateMany({
      where: { userId, articleId: id },
      data: { savedAt: null },
    });
  }

  return { saved };
}
