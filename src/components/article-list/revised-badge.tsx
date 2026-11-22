import type { Article } from "@/lib/types";
import { otherFeedCount } from "@/lib/types";

/*
 * The row badges: "Revised", and "Also in N feeds".
 *
 * Extracted from the row because both now render from REAL data and both say
 * something the row cannot otherwise say. Appendix E lists the collapse explanation
 * among the three copy rules that carry the product's credibility, and the
 * revision badge is the other half of the same promise: §6.2 keeps `read_at`
 * through an edit, so without a marker an article silently changes under a
 * reader who has already read it.
 */

const CHIP =
  "gap-2xs border-rule bg-paper-hi text-ink-2 px-xs inline-flex min-h-5 items-center " +
  "rounded-[2px] border text-xs font-medium whitespace-nowrap";

/**
 * Says an article changed after it was published.
 *
 * Rendered from `revisedAt`, which M8 made real: it is set only when a rung
 * matched AND the `content_hash` had moved, so an unchanged re-poll does not
 * light it up. That mattered more than it looks — the flag was silently false
 * for every revision until M8, because it had been inferred by comparing a
 * `TIMESTAMP(3)` column to microsecond `now()`.
 *
 * A RESURFACED article says so, because the reader is being shown something
 * they already read and the row would otherwise look like a new arrival. Only
 * the feeds that opted into `resurface_on_revision` ever produce this
 * (Appendix G question 3), so the extra word is rare and earns its space.
 */
export function RevisedBadge({
  article,
}: {
  article: Pick<Article, "revisedAt" | "wasReadAt" | "readAt">;
}) {
  if (!article.revisedAt) return null;
  /*
   * Resurfaced means BOTH: there is a read to remember (`wasReadAt`) and the
   * article is unread again (`readAt === null`). Testing `wasReadAt` alone
   * would keep the longer label forever, including after the reader reads it a
   * second time — at which point "back in unread" is simply false.
   */
  const resurfaced = article.wasReadAt !== undefined && article.readAt === null;
  return <span className={CHIP}>{resurfaced ? "Revised, back in unread" : "Revised"}</span>;
}

/**
 * Says how many of the reader's own feeds carry this article.
 *
 * Counts DISTINCT feeds rather than arrivals — one feed can deliver an article
 * at two addresses, and "also in 2 feeds" when there is one feed is the kind of
 * wrong number that makes a reader stop believing the rest of the screen.
 */
export function AlsoInFeedsBadge({ article }: { article: Article }) {
  const alsoIn = otherFeedCount(article);
  if (alsoIn <= 0) return null;
  return (
    <span className={CHIP}>
      Also in {alsoIn} {alsoIn === 1 ? "feed" : "feeds"}
    </span>
  );
}

/** Both badges, or nothing at all rather than an empty row of chips. */
export function ArticleBadges({ article }: { article: Article }) {
  if (otherFeedCount(article) <= 0 && !article.revisedAt) return null;
  return (
    <span className="gap-2xs mt-3xs flex flex-wrap">
      <AlsoInFeedsBadge article={article} />
      <RevisedBadge article={article} />
    </span>
  );
}
