import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { RawItem } from "@/lib/types";

import { urlsFor } from "./article-urls";
import { ingestItems, resolveAndWrite, type FeedTrust } from "./dedupe";

/*
 * What this suite is for: a rung that silently never fires.
 *
 * A ladder where rung 2 is dead still passes `parse-twice` — rung 1 catches
 * everything, and the second pass inserts nothing either way. The failure only
 * appears when a publisher does the thing that rung needs: churns a guid,
 * moves a URL, rewrites both. By then the duplicates are permanent.
 *
 * So each rung gets a case that ONLY it can resolve, asserted on which rung
 * reported the match — the same counters `fetch_log` records as the evidence
 * that dedup works (§6.2).
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: "A probe article",
  author: null,
  publishedAt: "2026-11-12T09:12:00.000Z",
  contentHtml: "<p>The opening text of the probe article, which rung 3 hashes.</p>",
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

async function makeFeed(cleanPolls = 3): Promise<FeedTrust> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://rungs-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'Rung probe', ${cleanPolls}, 'active')
    RETURNING id`;
  return { id: rows[0].id, guidUnstable: false, cleanPolls, guidTrustOverride: "auto" };
}

describeDb("each rung fires on the case only it can resolve", { timeout: 120_000 }, () => {
  const made: bigint[] = [];

  beforeEach(() => {
    seq += 1;
  });

  afterAll(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
    }
    await prisma.$disconnect();
  });

  it("RUNG 1: the guid matches while the address has MOVED", async () => {
    // Only rung 1 can resolve this. The URL is new, so rung 2 has nothing to
    // match; the text is new, so rung 3 has nothing either. A publisher
    // renaming a path is the everyday version of this.
    const feed = await makeFeed(3);
    made.push(feed.id);
    const guid = `stable-guid-${unique()}`;

    const first = await resolveAndWrite(
      feed,
      item({ guid, url: `https://moved-${unique()}.example/old-path` }),
      new Date(),
    );
    expect(first?.rung).toBeNull();

    const second = await resolveAndWrite(
      feed,
      item({
        guid,
        url: `https://moved-${unique()}.example/a-completely-new-path`,
        contentHtml: "<p>Rewritten text so rung 3 cannot be what matched.</p>",
      }),
      new Date(),
    );
    expect(second?.rung).toBe("guid");
    expect(second?.articleId).toBe(first?.articleId);
  });

  it("RUNG 2: the address matches while the guid has CHURNED", async () => {
    // Only rung 2 can resolve this: the guid is new on every poll, which is
    // what a static-site generator baking a build timestamp does.
    const feed = await makeFeed(3);
    made.push(feed.id);
    const url = `https://churned-${unique()}.example/post`;

    const first = await resolveAndWrite(
      feed,
      item({ guid: `build-1-${unique()}`, url }),
      new Date(),
    );
    expect(first?.rung).toBeNull();

    const second = await resolveAndWrite(
      feed,
      item({ guid: `build-2-${unique()}`, url }),
      new Date(),
    );
    expect(second?.rung).toBe("url");
    expect(second?.articleId).toBe(first?.articleId);
  });

  it("RUNG 2: the address matches ACROSS FEEDS, because it is global", async () => {
    // The reason rung 2 is not scoped to the feed. One wire story through two
    // feeds is one row — which is `global-rung-2.test.ts`'s whole subject, and
    // worth asserting here too because it is also a rung firing.
    const a = await makeFeed(3);
    const b = await makeFeed(3);
    made.push(a.id, b.id);
    const url = `https://syndicated-${unique()}.example/story`;

    const first = await resolveAndWrite(a, item({ guid: `a-${unique()}`, url }), new Date());
    const second = await resolveAndWrite(b, item({ guid: `b-${unique()}`, url }), new Date());

    expect(second?.rung).toBe("url");
    expect(second?.articleId).toBe(first?.articleId);
  });

  it("RUNG 3: the guid AND the address both changed in one build", async () => {
    // The case §6.1 says rung 3 exists for, and the only case it can resolve.
    // The first 500 characters usually survive an edit, which is why the hash
    // is over the title plus that prefix.
    const feed = await makeFeed(3);
    made.push(feed.id);
    const title = `A title that survives the rebuild ${unique()}`;
    const body = "<p>Opening text that survives a migration of both guid and address.</p>";

    const first = await resolveAndWrite(
      feed,
      item({
        guid: `old-${unique()}`,
        url: `https://rebuilt-${unique()}.example/old`,
        title,
        contentHtml: body,
      }),
      new Date(),
    );
    expect(first?.rung).toBeNull();

    const second = await resolveAndWrite(
      feed,
      item({
        guid: `new-${unique()}`,
        url: `https://rebuilt-${unique()}.example/new`,
        title,
        contentHtml: body,
      }),
      new Date(),
    );
    expect(second?.rung).toBe("content");
    expect(second?.articleId).toBe(first?.articleId);
  });

  it("ORDER: rung 1 beats rung 3 when both could match", async () => {
    /*
     * First match wins, in §6.1's order. This was a real bug.
     *
     * Rung 1's lookup was left to the upsert's `ON CONFLICT`, which runs LAST —
     * so an article that MOVED with its body unchanged was resolved by CONTENT.
     * Two consequences, and neither is cosmetic:
     *
     *  · `fetch_log` recorded a guid match as a content match, and §6.2 makes
     *    those counters the only evidence dedup works. `shouldFlagGuidUnstable`
     *    reads them too, so a feed with perfectly stable guids looked like one
     *    that had never matched on them.
     *  · `content_hash` is deliberately NOT unique, because two articles may
     *    legitimately share a title and opening text. So rung 3 could merge
     *    into the WRONG row ahead of the publisher's own explicit claim.
     */
    const feed = await makeFeed(3);
    made.push(feed.id);
    const guid = `ordered-${unique()}`;
    const title = `A title held constant across the move ${unique()}`;
    const body = "<p>Body text held constant too, so rung 3 would also match.</p>";

    const first = await resolveAndWrite(
      feed,
      item({ guid, url: `https://ordered-${unique()}.example/old`, title, contentHtml: body }),
      new Date(),
    );
    expect(first?.rung).toBeNull();

    const second = await resolveAndWrite(
      feed,
      // Same guid, same text, NEW address: rungs 1 and 3 both match.
      item({ guid, url: `https://ordered-${unique()}.example/new`, title, contentHtml: body }),
      new Date(),
    );
    expect(second?.rung).toBe("guid");
    expect(second?.articleId).toBe(first?.articleId);
  });

  it("ORDER: rung 2 beats rung 3 when both could match", async () => {
    // The same ordering property one rung down: the address is a stronger
    // claim than the text, so a churned guid at a known address reports "url".
    const feed = await makeFeed(3);
    made.push(feed.id);
    const url = `https://ordered2-${unique()}.example/post`;
    const title = `Constant title ${unique()}`;
    const body = "<p>Constant body, so rung 3 would also match.</p>";

    const first = await resolveAndWrite(
      feed,
      item({ guid: `b1-${unique()}`, url, title, contentHtml: body }),
      new Date(),
    );
    const second = await resolveAndWrite(
      feed,
      item({ guid: `b2-${unique()}`, url, title, contentHtml: body }),
      new Date(),
    );

    expect(second?.rung).toBe("url");
    expect(second?.articleId).toBe(first?.articleId);
  });

  it("INSERTS when nothing matches, so no rung is over-eager", async () => {
    // The negative case. A ladder that merged everything would pass every
    // assertion above.
    const feed = await makeFeed(3);
    made.push(feed.id);

    const first = await resolveAndWrite(
      feed,
      item({
        guid: `one-${unique()}`,
        url: `https://distinct-${unique()}.example/a`,
        title: `First ${unique()}`,
      }),
      new Date(),
    );
    const second = await resolveAndWrite(
      feed,
      item({
        guid: `two-${unique()}`,
        url: `https://distinct-${unique()}.example/b`,
        title: `Second ${unique()}`,
        contentHtml: "<p>Entirely different opening text.</p>",
      }),
      new Date(),
    );

    expect(first?.rung).toBeNull();
    expect(second?.rung).toBeNull();
    expect(second?.articleId).not.toBe(first?.articleId);
  });

  it("REPORTS a revision, and only when the body actually changed", async () => {
    /*
     * `revised` was silently near-always FALSE, and the shape that caused it
     * looked correct:
     *
     *     RETURNING (revised_at IS NOT DISTINCT FROM now()) AS revised
     *
     * `revised_at` is `TIMESTAMP(3)`, so what is stored is rounded to the
     * millisecond; `now()` carries microseconds. The two match only when
     * `now()` lands on an exact millisecond — about once in a thousand polls.
     * So `revision_count` was being incremented by SQL nobody could observe,
     * and M8's revised badge reads this flag.
     *
     * Asserted on the CONTENT HASH's behaviour instead: a changed body is a
     * revision, an identical one is a re-poll.
     */
    const feed = await makeFeed(3);
    made.push(feed.id);
    const guid = `revisable-${unique()}`;
    const url = `https://revisable-${unique()}.example/post`;
    const title = `A revisable article ${unique()}`;

    const first = await resolveAndWrite(
      feed,
      item({ guid, url, title, contentHtml: "<p>The body as first published.</p>" }),
      new Date(),
    );
    expect(first?.revised).toBe(false);

    // A re-poll with the SAME body is not a revision.
    const repoll = await resolveAndWrite(
      feed,
      item({ guid, url, title, contentHtml: "<p>The body as first published.</p>" }),
      new Date(),
    );
    expect(repoll?.rung).toBe("guid");
    expect(repoll?.revised).toBe(false);

    // An edit IS.
    const edited = await resolveAndWrite(
      feed,
      item({ guid, url, title, contentHtml: "<p>The body, corrected after publication.</p>" }),
      new Date(),
    );
    expect(edited?.rung).toBe("guid");
    expect(edited?.revised).toBe(true);

    const row = await prisma.$queryRaw<{ revision_count: number; revised_at: Date | null }[]>`
      SELECT revision_count, revised_at FROM cadence.articles WHERE id = ${first!.articleId}`;
    // One edit, one revision — the re-poll must not have counted.
    expect(row[0].revision_count).toBe(1);
    expect(row[0].revised_at).not.toBeNull();
  });

  it("reports a revision that arrives through RUNG 2 as well", async () => {
    // The same property on the other merge path: a feed that churns its guids
    // still has its edits noticed.
    const feed = await makeFeed(3);
    made.push(feed.id);
    const url = `https://rung2-revised-${unique()}.example/post`;
    const title = `Churning but editable ${unique()}`;

    await resolveAndWrite(
      feed,
      item({ guid: `b1-${unique()}`, url, title, contentHtml: "<p>First body.</p>" }),
      new Date(),
    );
    const edited = await resolveAndWrite(
      feed,
      item({ guid: `b2-${unique()}`, url, title, contentHtml: "<p>Second, edited body.</p>" }),
      new Date(),
    );

    expect(edited?.rung).toBe("url");
    expect(edited?.revised).toBe(true);
  });

  it("does NOT touch read state when an article is revised", async () => {
    // §6.2: an edit is not a re-publication. This is the guarantee the whole
    // revision path exists to keep, and the one that would make the unread
    // count lie if it broke.
    const feed = await makeFeed(3);
    made.push(feed.id);
    const guid = `read-${unique()}`;
    const url = `https://read-${unique()}.example/post`;
    const title = `An article already read ${unique()}`;
    const userId = `probe-user-${unique()}`;

    const first = await resolveAndWrite(
      feed,
      item({ guid, url, title, contentHtml: "<p>Body one.</p>" }),
      new Date(),
    );

    await prisma.$executeRaw`
      INSERT INTO cadence.users (id, email, name)
      VALUES (${userId}, ${`${userId}@probe.example`}, 'Revision probe')
      ON CONFLICT (id) DO NOTHING`;
    await prisma.$executeRaw`
      INSERT INTO cadence.user_articles (user_id, article_id, read_at)
      VALUES (${userId}, ${first!.articleId}, now())`;

    const readBefore = await prisma.$queryRaw<{ read_at: Date }[]>`
      SELECT read_at FROM cadence.user_articles
      WHERE user_id = ${userId} AND article_id = ${first!.articleId}`;

    await resolveAndWrite(
      feed,
      item({ guid, url, title, contentHtml: "<p>Body two, edited.</p>" }),
      new Date(),
    );

    const readAfter = await prisma.$queryRaw<{ read_at: Date }[]>`
      SELECT read_at FROM cadence.user_articles
      WHERE user_id = ${userId} AND article_id = ${first!.articleId}`;
    expect(readAfter).toHaveLength(1);
    expect(readAfter[0].read_at.getTime()).toBe(readBefore[0].read_at.getTime());

    await prisma.$executeRaw`DELETE FROM cadence.users WHERE id = ${userId}`;
  });

  it("an UNTRUSTED feed repeating a guid at a new address does not abort the poll", async () => {
    /*
     * The path that used to throw, and it is every new feed's path.
     *
     * With `cleanPolls: 0` the guids are not trusted, so rung 1 does not
     * route. A new address means rung 2 misses; an edited body means rung 3
     * misses. The insert then hits `articles_guid` — a unique index that knows
     * nothing about trust — and the catch handling it was a rung-3 fallback
     * with no error check: the content lookup found nothing and RETHREW, so
     * one repeated guid cost the whole poll.
     *
     * Resolved as "guid" because that is what the constraint decided. The
     * index is the arbiter and the error is how it reports (§6.1).
     */
    const feed = await makeFeed(0);
    made.push(feed.id);
    const guid = `untrusted-${unique()}`;
    const host = `https://untrusted-${unique()}.example`;

    const first = await resolveAndWrite(
      feed,
      item({ guid, url: `${host}/first`, title: `First ${unique()}` }),
      new Date(),
    );
    expect(first?.rung).toBeNull();

    const second = await resolveAndWrite(
      feed,
      item({
        guid,
        // New address, so rung 2 misses...
        url: `${host}/second`,
        title: `Second ${unique()}`,
        // ...and new text, so rung 3 misses too.
        contentHtml: "<p>Completely different body text for the second item.</p>",
      }),
      new Date(),
    );

    expect(second?.rung).toBe("guid");
    expect(second?.articleId).toBe(first?.articleId);

    // And the NEW address was recorded. This path was the only resolution that
    // skipped it, so a later edit arriving at that address inserted a
    // duplicate instead of merging.
    const urls = (await urlsFor(first!.articleId)).map((u) => u.url);
    expect(urls).toContain(`${host}/second`);
  });

  it("the counters a fetch_log row is built from add up", async () => {
    // §6.2: `fetch_log` is the only evidence dedup is working. If the counters
    // do not reconcile, the health screen reports fiction.
    const feed = await makeFeed(3);
    made.push(feed.id);
    const url = `https://counted-${unique()}.example/post`;
    const items = [
      item({ guid: `c1-${unique()}`, url }),
      item({ guid: `c2-${unique()}`, url }),
      item({
        guid: `c3-${unique()}`,
        url: `https://counted-${unique()}.example/other`,
        title: `Other ${unique()}`,
      }),
    ];

    const { counters } = await ingestItems(feed, items);
    expect(counters.itemsSeen).toBe(3);
    expect(
      counters.itemsNew +
        counters.mergedByGuid +
        counters.mergedByUrl +
        counters.mergedByContent +
        counters.droppedNoIdentity,
    ).toBe(counters.itemsSeen);
  });
});
