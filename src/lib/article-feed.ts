import type { Article } from "./types";

/*
 * Which feed to CREDIT an article to, in a reader's own view.
 *
 * `articles.feed_id` is the feed that saw an article FIRST, not the feed this
 * reader got it through, and rung 2 being global (§6.1) is what makes those
 * different. One story carried by two feeds is one row owned by whichever
 * polled first — so an article can appear in a reader's list because a feed
 * they follow delivered it, while `feed_id` names a feed they have never heard
 * of.
 *
 * Labelling from `feed_id` therefore rendered **"Unknown feed"** on a row the
 * reader was looking at in one of their own lists. Which is worse than a wrong
 * name: it reads as the app having lost track of where the article came from,
 * on the screen whose whole job is to say where things came from.
 *
 * Pure and separate so it can be tested. Both lists, the reader pane and the
 * saved screen label rows, and a rule applied in four places by hand is a rule
 * that will be applied three ways.
 */

/**
 * The feed id to label this article with for this reader.
 *
 * The owning feed when the reader follows it — that is the feed the row's
 * metadata came from, so it is the most accurate answer. Otherwise the
 * EARLIEST arrival the reader follows, which is the feed that actually put the
 * article in front of them.
 *
 * Falls back to the owning feed when nothing matches, rather than inventing an
 * answer: that is a genuinely inconsistent state (an article in a list through
 * no subscribed feed) and it should surface as "Unknown feed" rather than be
 * papered over.
 */
export function displayFeedId(
  article: Pick<Article, "feedId" | "arrivals">,
  isSubscribed: (feedId: number) => boolean,
): number {
  if (isSubscribed(article.feedId)) return article.feedId;
  // `arrivals` is null when the caller did not load them — distinct from `[]`,
  // which means the article genuinely has none.
  const subscribed = article.arrivals?.find((a) => isSubscribed(a.feedId));
  return subscribed?.feedId ?? article.feedId;
}
