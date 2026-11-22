import { prisma } from "@/lib/db/client";

/*
 * What happens to read state when an article is edited.
 *
 * APPENDIX G QUESTION 3, SETTLED: an edited article does NOT return to unread.
 * It gets a revision badge and keeps its `read_at`, following NewsBlur (§6.2).
 * The hedge is a per-subscription `resurface_on_revision`, defaulting to off.
 *
 * The reasoning, because this is the kind of decision that gets reopened:
 *
 *   A publisher fixing a typo must not re-notify every subscriber. Worse, a CMS
 *   that rewrites timestamps or re-renders bodies on every deploy would make a
 *   feed PERMANENTLY and falsely unread — and an unread count that cannot be
 *   cleared is the failure §6.1 says actually loses readers. Defaulting to
 *   resurface means one badly-behaved publisher can break the number the whole
 *   product rests on.
 *
 *   But for changelogs, status pages and "live" posts the opposite is plainly
 *   right: the edit IS the news. So the toggle exists, per subscription rather
 *   than per feed, because two readers can want different answers about the
 *   same feed and `subscriptions` is where per-reader choices live.
 *
 * `was_read_at` is why this is not simply "clear `read_at`". A resurfaced
 * article records what its read state HAD been, so the UI can say "you read
 * this on the 11th, it changed on the 14th" rather than presenting a
 * previously-read article as if it were new. It is also what makes the toggle
 * reversible: turning resurfacing off does not have to guess.
 */

/** One reader whose row was resurfaced, for the caller's counters. */
export type Resurfaced = {
  userId: string;
  articleId: bigint;
};

/**
 * Applies the resurface rule to one revised article.
 *
 * Called ONLY for articles a poll actually revised — `resolution.revised`,
 * which is true when a rung matched and the `content_hash` had changed. An
 * unchanged re-poll must not touch read state at all, and calling this for
 * every resolved item would make that depend on a `WHERE` clause rather than on
 * the caller's intent.
 *
 * Scoped to subscribers who opted IN. A reader with no `user_articles` row is
 * already unread and is not touched — there is nothing to resurface, and
 * writing a row would defeat §6.2's "a missing row means unread".
 */
export async function resurfaceRevised(articleId: bigint): Promise<Resurfaced[]> {
  const rows = await prisma.$queryRaw<{ user_id: string }[]>`
    UPDATE cadence.user_articles AS ua SET
      -- What the read state HAD been. COALESCE so a second revision before the
      -- reader catches up does not overwrite the ORIGINAL read time with a
      -- null: the first resurface is the one that answers "when did you read
      -- it".
      was_read_at = COALESCE(ua.was_read_at, ua.read_at),
      read_at     = NULL
    FROM cadence.subscriptions s
    WHERE ua.article_id = ${articleId}
      AND s.user_id = ua.user_id
      AND s.resurface_on_revision
      -- Already unread: nothing to resurface, and writing was_read_at would
      -- claim a read that never happened.
      AND ua.read_at IS NOT NULL
      -- The subscription must be to a feed that actually DELIVERED this
      -- article. Without this join an opted-in subscription to any feed would
      -- resurface every article the reader has read, because subscriptions and
      -- user_articles share only user_id.
      AND EXISTS (
        SELECT 1 FROM cadence.article_feeds af
        WHERE af.article_id = ua.article_id AND af.feed_id = s.feed_id
      )
    RETURNING ua.user_id
  `;
  return rows.map((r) => ({ userId: r.user_id, articleId }));
}

/**
 * Applies the rule to every article a poll revised.
 *
 * Serial, like the rest of the write path: §6.4 puts database work at a
 * concurrency of 1 because the sweep's limit is the connection pool.
 */
export async function resurfaceAll(articleIds: bigint[]): Promise<Resurfaced[]> {
  const out: Resurfaced[] = [];
  // Deduplicated: two items in one poll can resolve to the same article, and
  // resurfacing twice would be a second `UPDATE` finding nothing — harmless,
  // but it would double-count the result.
  for (const id of [...new Set(articleIds)]) {
    out.push(...(await resurfaceRevised(id)));
  }
  return out;
}
