import { describe, expect, it } from "vitest";

import { displayFeedId } from "./article-feed";

/*
 * What this suite is for: "Unknown feed" on a row the reader is looking at.
 *
 * Rung 2 is global (§6.1), so one story through two feeds is ONE row owned by
 * whichever polled first. Once the lists started matching on arrivals, an
 * article could appear in a reader's list because a feed they follow delivered
 * it while `articles.feed_id` names a feed they have never subscribed to — and
 * the label, read off `feed_id`, said "Unknown feed".
 *
 * Which is worse than a wrong name. It reads as the app having lost track of
 * where an article came from, on the screen whose whole job is to say that.
 */

const article = (feedId: number, arrivals: number[] | null) => ({
  feedId,
  arrivals:
    arrivals === null
      ? null
      : arrivals.map((id) => ({
          feedId: id,
          url: "https://x.example/a",
          at: "",
          how: "url" as const,
        })),
});

const follows =
  (...ids: number[]) =>
  (id: number) =>
    ids.includes(id);

describe("which feed an article is credited to", () => {
  it("prefers the OWNING feed when the reader follows it", () => {
    // The ordinary case, and the most accurate answer: the row's title,
    // author and dates all came from that feed's copy.
    expect(displayFeedId(article(1, [1, 2]), follows(1, 2))).toBe(1);
  });

  it("falls back to a subscribed ARRIVAL when the owner is not followed", () => {
    // The bug. The reader follows feed 2; feed 1 got there first and owns the
    // row. Labelling from `feed_id` rendered "Unknown feed".
    expect(displayFeedId(article(1, [1, 2]), follows(2))).toBe(2);
  });

  it("takes the EARLIEST subscribed arrival when several are followed", () => {
    // `arrivals` arrives oldest-first, so the first match is the feed that put
    // the article in front of this reader soonest — which is the one their
    // mental model credits.
    expect(displayFeedId(article(9, [3, 4, 5]), follows(5, 4))).toBe(4);
  });

  it("keeps the owning feed when NOTHING is subscribed, rather than inventing one", () => {
    // An article in a list through no subscribed feed is a genuinely
    // inconsistent state. It should surface as "Unknown feed" and be noticed,
    // not be papered over with whichever feed happened to be first.
    expect(displayFeedId(article(1, [1, 2]), follows(7))).toBe(1);
  });

  it("keeps the owning feed when arrivals were not loaded", () => {
    // `null` means "not loaded" and `[]` means "none" — a caller that did not
    // ask for arrivals must not be silently relabelled.
    expect(displayFeedId(article(1, null), follows(2))).toBe(1);
    expect(displayFeedId(article(1, []), follows(2))).toBe(1);
  });
});
