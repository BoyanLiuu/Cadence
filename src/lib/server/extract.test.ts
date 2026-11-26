import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { FetchOutcome } from "@/lib/ingest/fetch";

import { getArticle } from "./article-service.db";
import { ArticleNotExtractable, applyExtraction } from "./extract.db";

/*
 * What this suite is for: the three ways an on-open fetch stops being defensible.
 *
 *   FETCHING MORE THAN ONCE. §6.5's entire permission to fetch at all rests on
 *   "once per article, cached forever" — at ingest it would be an `[assumed]`
 *   9 000 unrequested page loads a day, which is the line between a reader and
 *   a crawler. A cache that only covers the SUCCESSFUL case re-fetches every
 *   paywalled and every dead article on every open, which is the opposite of
 *   polite and aimed at the publishers least willing to be read.
 *
 *   FETCHING SOMEBODY ELSE'S ARTICLE. Articles are global rows (Appendix B), so
 *   an id is a number and `reachableArticles` is the only thing between a
 *   reader and the whole corpus. Without it `extractArticle(n)` is an
 *   arbitrary-URL fetcher.
 *
 *   FETCHING WHAT WE ALREADY HAVE. A feed that sent the whole article must not
 *   cause an outbound request.
 *
 * THE FETCHER IS INJECTED AND RECORDS EVERY CALL, so "no request was made" is
 * observed rather than inferred. That is the same choice `discover.test.ts`
 * makes, and for the same reason: "it was refused" and "it was never dialled"
 * are different claims.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

const sha = (v: string) => new Uint8Array(createHash("sha256").update(v).digest());
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const READER = `user_test_extract_${RUN}`;

/** Enough prose that the extraction clears the `thin` threshold. */
const LONG = Array.from(
  { length: 8 },
  (_, i) =>
    `<p>Paragraph ${i + 1}. The harbour council voted last night to raise the tidal barrier at the mouth of the estuary by a metre, ending two years of argument.</p>`,
).join("");

const page = (body: string) =>
  `<!doctype html><html><head><title>A page</title></head><body>
     <nav><a href="/">Home</a></nav><article>${body}</article>
     <footer>© Harbour Wire</footer></body></html>`;

const changed = (html: string, landedUrl: string): FetchOutcome => ({
  kind: "changed",
  status: 200,
  body: new TextEncoder().encode(html),
  contentType: "text/html",
  etag: null,
  lastModified: null,
  bodyHash: new Uint8Array(32),
  finalUrl: null,
  landedUrl,
  durationMs: 1,
  bytes: html.length,
});

const failedWith = (status: number | null): FetchOutcome => ({
  kind: "failed",
  status,
  code: status === null ? "timeout" : "http_error",
  detail: null,
  retryAfterS: null,
  durationMs: 1,
});

/** A fetcher that answers from a map and records every address it was asked for. */
function recordingFetcher(pages: Record<string, FetchOutcome>) {
  const calls: string[] = [];
  const fetcher = (url: string) => {
    calls.push(url);
    return Promise.resolve(pages[url] ?? failedWith(null));
  };
  return { calls, fetcher: fetcher as unknown as typeof import("@/lib/ingest/fetch").fetchFeed };
}

describeDb("reading the full text off the page", () => {
  const feeds: bigint[] = [];

  /** A teaser article in a feed this reader follows, unless `follow` is false. */
  async function makeArticle(
    label: string,
    opts: {
      contentHtml?: string | null;
      follow?: boolean;
      fullTextMode?: "off" | "on_demand";
    } = {},
  ) {
    const feed = await prisma.feed.create({
      data: {
        feedUrl: `https://extract-${label}-${RUN}.example/feed`,
        urlHash: sha(`feed-${label}-${RUN}`),
        title: label,
        format: "rss2",
      },
    });
    feeds.push(feed.id);

    if (opts.follow !== false) {
      await prisma.subscription.create({
        data: {
          userId: READER,
          feedId: feed.id,
          fullTextMode: opts.fullTextMode ?? "on_demand",
        },
      });
    }

    const url = `https://extract-${label}-${RUN}.example/article`;
    const article = await prisma.article.create({
      data: {
        feedId: feed.id,
        url,
        urlHash: sha(`article-${label}-${RUN}`),
        contentHash: sha(`content-${label}-${RUN}`),
        title: `${label} article`,
        publishedAt: new Date(),
        normVersion: 1,
        contentHtml: opts.contentHtml === undefined ? "<p>A teaser.</p>" : opts.contentHtml,
        arrivals: { create: [{ feedId: feed.id }] },
      },
    });
    return { articleId: article.id, url, feedId: feed.id };
  }

  const rowFor = (id: bigint) =>
    prisma.article.findUniqueOrThrow({
      where: { id },
      select: {
        extractStatus: true,
        extractedHtml: true,
        extractFinalUrl: true,
        extractedAt: true,
        contentHtml: true,
        textLen: true,
      },
    });

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: READER, email: `${READER}@example.invalid`, name: "Extract reader" },
    });
  }, 20_000);

  afterAll(async () => {
    await prisma.userArticle.deleteMany({ where: { userId: READER } });
    await prisma.subscription.deleteMany({ where: { userId: READER } });
    for (const id of feeds) await prisma.feed.delete({ where: { id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: READER } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("reads the article and stores it SEPARATELY from what the feed sent", async () => {
    const { articleId, url } = await makeArticle("ok");
    const { calls, fetcher } = recordingFetcher({ [url]: changed(page(LONG), url) });

    const result = await applyExtraction(READER, Number(articleId), fetcher);

    expect(result.status).toBe("ok");
    expect(result.contentHtml).toContain("Paragraph 1.");
    expect(calls).toEqual([url]);

    const row = await rowFor(articleId);
    expect(row.extractStatus).toBe("ok");
    expect(row.extractedHtml).toContain("Paragraph 1.");
    /*
     * THE FEED'S OWN BODY IS UNTOUCHED, and this is the assertion that protects
     * three things at once: `thin`'s copy is "this is what the feed sent" and
     * needs it to exist, `content_hash` is computed from it so overwriting
     * makes the next poll call this an edit (§6.2 — an edit must not
     * re-notify), and "what the feed sent" versus "what we read" are different
     * claims.
     */
    expect(row.contentHtml).toBe("<p>A teaser.</p>");
  }, 30_000);

  it("drops the page's CHROME, so a nav bar is not stored as the article", async () => {
    const { articleId, url } = await makeArticle("chrome");
    const { fetcher } = recordingFetcher({ [url]: changed(page(LONG), url) });

    await applyExtraction(READER, Number(articleId), fetcher);

    const row = await rowFor(articleId);
    expect(row.extractedHtml).not.toContain("Home");
    expect(row.extractedHtml).not.toContain("Harbour Wire");
  }, 30_000);

  it("makes ZERO requests on a second open", async () => {
    /*
     * THE RULE THE WHOLE FEATURE RESTS ON. The plan calls this
     * `extract-once.spec.ts` and asks for exactly this number.
     */
    const { articleId, url } = await makeArticle("once");
    const first = recordingFetcher({ [url]: changed(page(LONG), url) });
    await applyExtraction(READER, Number(articleId), first.fetcher);
    expect(first.calls).toHaveLength(1);

    const second = recordingFetcher({ [url]: changed(page(LONG), url) });
    const result = await applyExtraction(READER, Number(articleId), second.fetcher);

    expect(second.calls).toEqual([]);
    // And it still ANSWERS, from the stored copy — a cache that returns nothing
    // would pass the call count and leave the pane empty.
    expect(result.status).toBe("ok");
    expect(result.contentHtml).toContain("Paragraph 1.");
  }, 30_000);

  it("makes zero requests on a second open of a THIN or BLOCKED article", async () => {
    /*
     * The half a cache usually misses. Caching only success re-fetches every
     * paywalled article on every open — repeated unrequested traffic aimed
     * exactly at the publishers least willing to serve it, which is worse than
     * the behaviour the on-open rule exists to avoid.
     */
    const thin = await makeArticle("thin");
    /*
     * A REALISTIC GATED PAGE, which matters: my first version used
     * `<p>Subscribers only.</p>` — eighteen characters — and got `failed`,
     * correctly, because that is below the floor where there is no article at
     * all. A real paywall serves the standfirst and the opening paragraph and
     * then stops, which is a couple of hundred characters: over the
     * no-article floor and under `THIN_TEXT_CHARS`. That gap IS `thin`, and a
     * fixture outside it tests the wrong state.
     */
    const thinFirst = recordingFetcher({
      [thin.url]: changed(
        page(
          `<p>The harbour council voted last night to raise the tidal barrier by a metre,
             ending two years of argument over how high the town should build.</p>
           <p>Subscribers can read the rest of this article.</p>`,
        ),
        thin.url,
      ),
    });
    await applyExtraction(READER, Number(thin.articleId), thinFirst.fetcher);
    expect((await rowFor(thin.articleId)).extractStatus).toBe("thin");

    const thinAgain = recordingFetcher({});
    await applyExtraction(READER, Number(thin.articleId), thinAgain.fetcher);
    expect(thinAgain.calls, "a gated article was re-fetched").toEqual([]);

    const blocked = await makeArticle("blocked");
    const blockedFirst = recordingFetcher({ [blocked.url]: failedWith(403) });
    await applyExtraction(READER, Number(blocked.articleId), blockedFirst.fetcher);
    expect((await rowFor(blocked.articleId)).extractStatus).toBe("blocked");

    const blockedAgain = recordingFetcher({});
    await applyExtraction(READER, Number(blocked.articleId), blockedAgain.fetcher);
    expect(blockedAgain.calls, "a refusing host was re-fetched").toEqual([]);
  }, 40_000);

  it("REFUSES an article the reader cannot reach, and fetches nothing", async () => {
    /*
     * Without the subscription filter this function is an arbitrary-URL
     * fetcher: hand it any id in the corpus and it dials that address. The
     * assertion is on the recorded calls, because a refusal that happened
     * after the request is not a refusal.
     */
    const theirs = await makeArticle("unfollowed", { follow: false });
    const { calls, fetcher } = recordingFetcher({ [theirs.url]: changed(page(LONG), theirs.url) });

    await expect(applyExtraction(READER, Number(theirs.articleId), fetcher)).rejects.toBeInstanceOf(
      ArticleNotExtractable,
    );

    expect(calls, "the page was fetched before the refusal").toEqual([]);
    expect((await rowFor(theirs.articleId)).extractStatus).toBe("none");
  }, 30_000);

  it("fetches NOTHING for a feed that already sent the whole article", async () => {
    // The expensive direction to be wrong in: an outbound request for text we
    // are already holding.
    const full = await makeArticle("full", { contentHtml: LONG + LONG });
    const { calls, fetcher } = recordingFetcher({ [full.url]: changed(page(LONG), full.url) });

    await applyExtraction(READER, Number(full.articleId), fetcher);

    expect(calls).toEqual([]);
    expect((await rowFor(full.articleId)).extractStatus).toBe("none");
  }, 30_000);

  it("fetches nothing when this reader set the feed to `off`", async () => {
    // Per-subscription, so it is the ASKING reader's setting. `off` has to be
    // checked before the request, not after.
    const off = await makeArticle("off", { fullTextMode: "off" });
    const { calls, fetcher } = recordingFetcher({ [off.url]: changed(page(LONG), off.url) });

    await applyExtraction(READER, Number(off.articleId), fetcher);

    expect(calls).toEqual([]);
    expect((await rowFor(off.articleId)).extractStatus).toBe("none");
  }, 30_000);

  it("records a page it could not read as FAILED, not thin", async () => {
    /*
     * `thin` claims the publisher is gating the text, which is a statement
     * about the publisher and tells the reader what to do next. It must not be
     * said about a response we could not parse at all.
     */
    const bad = await makeArticle("unreadable");
    const { fetcher } = recordingFetcher({ [bad.url]: changed("<<<>>>", bad.url) });

    const result = await applyExtraction(READER, Number(bad.articleId), fetcher);

    expect(result.status).toBe("failed");
    expect((await rowFor(bad.articleId)).extractedAt).not.toBeNull();
  }, 30_000);

  it("appends where the fetch LANDED to article_urls, closing the shortener gap", async () => {
    /*
     * §6.1: ingestion never follows a redirect to canonicalise, because one
     * request per item turns a 40-item poll into 40. So a shortened address is
     * stored as itself and the first extraction is when we learn the real one.
     * Appending it is what makes a later feed carrying that address resolve to
     * THIS row instead of inserting a second.
     */
    const short = await makeArticle("shortener");
    const landed = `https://extract-shortener-${RUN}.example/real/article-path`;
    const { fetcher } = recordingFetcher({ [short.url]: changed(page(LONG), landed) });

    await applyExtraction(READER, Number(short.articleId), fetcher);

    const urls = await prisma.articleUrl.findMany({
      where: { articleId: short.articleId },
      select: { url: true },
    });
    expect(urls.map((u) => u.url)).toContain(landed);
    expect((await rowFor(short.articleId)).extractFinalUrl).toBe(landed);
  }, 30_000);

  it("SERVES the stored extraction to the reader, not the feed's teaser", async () => {
    /*
     * THE PAYOFF OF CACHING, and it was missing. The write path stored the
     * extraction correctly and `db/map.ts` kept reading `content_html`, so the
     * pane rendered the teaser forever: one outbound request per article and
     * nothing to show for it.
     *
     * Every test above passed while that was true, because every one of them
     * asserts on the COLUMN. This one asks the question the reader asks —
     * "what do I see" — through `getArticle`, which is the only read that
     * reaches the pane.
     */
    const { articleId, url } = await makeArticle("served");
    const { fetcher } = recordingFetcher({ [url]: changed(page(LONG), url) });
    await applyExtraction(READER, Number(articleId), fetcher);

    const viewer = { kind: "user", user: { id: READER } } as unknown as Parameters<
      typeof getArticle
    >[0];
    const article = await getArticle(viewer, Number(articleId));

    expect(article).not.toBeNull();
    expect(article!.body, "the reader is still being shown the teaser").toContain("Paragraph 1.");
    expect(article!.body).not.toBe("<p>A teaser.</p>");
  }, 30_000);

  it("RETRIES after a transient failure, and never after a permanent one", async () => {
    /*
     * Everything here is written once and never retried — the rule that makes
     * on-open fetching defensible. Applied to a 429 or a 503 it marked an
     * article permanently unreadable because the publisher was busy for one
     * second, and nothing would ever revisit it.
     *
     * So the two outcomes that explicitly mean "later" record NOTHING, and the
     * ones that mean "no" stick. Both halves are asserted, because a version
     * that retried everything would pass the first and reintroduce the
     * unrequested traffic aimed at the hosts least willing to receive it.
     */
    for (const status of [429, 503, null]) {
      const busy = await makeArticle(`busy-${status ?? "timeout"}`);
      const first = recordingFetcher({ [busy.url]: failedWith(status) });
      await applyExtraction(READER, Number(busy.articleId), first.fetcher);

      const row = await rowFor(busy.articleId);
      expect(row.extractStatus, `HTTP ${status} must not be terminal`).toBe("none");
      // The CLAIM is released too, or the retry could never happen.
      expect(row.extractedAt, `HTTP ${status} left the claim held`).toBeNull();

      const retry = recordingFetcher({ [busy.url]: changed(page(LONG), busy.url) });
      const result = await applyExtraction(READER, Number(busy.articleId), retry.fetcher);
      expect(retry.calls, `HTTP ${status} was not retried`).toEqual([busy.url]);
      expect(result.status).toBe("ok");
    }

    for (const [status, expected] of [
      [403, "blocked"],
      [404, "failed"],
    ] as const) {
      const gone = await makeArticle(`gone-${status}`);
      const first = recordingFetcher({ [gone.url]: failedWith(status) });
      await applyExtraction(READER, Number(gone.articleId), first.fetcher);
      expect((await rowFor(gone.articleId)).extractStatus).toBe(expected);

      const again = recordingFetcher({});
      await applyExtraction(READER, Number(gone.articleId), again.fetcher);
      expect(again.calls, `HTTP ${status} was re-fetched`).toEqual([]);
    }
  }, 60_000);

  it("reads a page in the charset it DECLARES, not as UTF-8", async () => {
    /*
     * Extraction is never retried, so a mis-decode is stored permanently:
     * every windows-1252 page would keep its mojibake forever. The repo's own
     * `decode` already handles the BOM, the Content-Type and the meta charset
     * (§6.3); a hardcoded `TextDecoder("utf-8")` here threw that away.
     */
    const latin = await makeArticle("latin1");
    const text = `Côte, naïve, £40 — ${LONG}`;
    const bytes = new Uint8Array(
      [...`<!doctype html><html><body><article><p>${text}</p></article></body></html>`].map((c) =>
        c.charCodeAt(0) <= 0xff ? c.charCodeAt(0) : 0x3f,
      ),
    );

    const { fetcher } = recordingFetcher({
      [latin.url]: {
        kind: "changed",
        status: 200,
        body: bytes,
        contentType: "text/html; charset=windows-1252",
        etag: null,
        lastModified: null,
        bodyHash: new Uint8Array(32),
        finalUrl: null,
        landedUrl: latin.url,
        durationMs: 1,
        bytes: bytes.length,
      },
    });

    await applyExtraction(READER, Number(latin.articleId), fetcher);

    const row = await rowFor(latin.articleId);
    expect(row.extractedHtml, "the declared charset was ignored").toContain("Côte");
    expect(row.extractedHtml).toContain("£40");
    // The replacement character is what a wrong decode leaves behind.
    expect(row.extractedHtml).not.toContain("\ufffd");
  }, 30_000);

  it("shows the FEED's body for a thin extraction, as its notice promises", async () => {
    /*
     * §6.5 pairs `thin` with "the publisher likely gates the full text. This is
     * what the feed sent." Preferring the extraction would put the gated
     * snippet under a sentence promising the feed's version — and a teaser is
     * often the LONGER of the two, so the reader loses text as well as being
     * told something false. This is the reason the column is separate.
     */
    const gated = await makeArticle("thin-served", {
      contentHtml: `<p>A properly substantial teaser from the feed, longer than the snippet the page will yield.</p>`,
    });
    const { fetcher } = recordingFetcher({
      [gated.url]: changed(
        page(
          `<p>The harbour council voted last night to raise the tidal barrier by a metre,
             ending two years of argument.</p><p>Subscribers can read the rest.</p>`,
        ),
        gated.url,
      ),
    });

    await applyExtraction(READER, Number(gated.articleId), fetcher);
    expect((await rowFor(gated.articleId)).extractStatus).toBe("thin");

    const viewer = { kind: "user", user: { id: READER } } as unknown as Parameters<
      typeof getArticle
    >[0];
    const article = await getArticle(viewer, Number(gated.articleId));

    expect(article!.body).toContain("A properly substantial teaser");
    expect(article!.body, "the gated snippet was served as the article").not.toContain(
      "Subscribers can read the rest",
    );
  }, 30_000);

  it("honours `off` on the feed that DELIVERED the article, not its owner", async () => {
    /*
     * Rung 2 is global, so an article is owned by whichever feed carried it
     * first and may reach a reader through an entirely different one. Reading
     * the OWNING feed's subscription meant that for a cross-feed arrival there
     * was no row for this reader at all — the mode silently defaulted to
     * `on_demand`, and a reader who had set `off` on the feed they actually
     * follow got the fetch anyway.
     */
    const owner = await makeArticle("owned-elsewhere", { follow: false });

    // A second feed, which this reader follows with extraction OFF, also
    // carries the article — which is what `article_feeds` records.
    const mine = await prisma.feed.create({
      data: {
        feedUrl: `https://extract-delivering-${RUN}.example/feed`,
        urlHash: sha(`feed-delivering-${RUN}`),
        title: "delivering",
        format: "rss2",
      },
    });
    feeds.push(mine.id);
    await prisma.subscription.create({
      data: { userId: READER, feedId: mine.id, fullTextMode: "off" },
    });
    await prisma.articleFeed.create({ data: { articleId: owner.articleId, feedId: mine.id } });

    const { calls, fetcher } = recordingFetcher({ [owner.url]: changed(page(LONG), owner.url) });
    await applyExtraction(READER, Number(owner.articleId), fetcher);

    expect(calls, "`off` on the delivering feed was ignored").toEqual([]);
    expect((await rowFor(owner.articleId)).extractStatus).toBe("none");
  }, 30_000);

  it("serves an extracted article's images THROUGH THE PROXY", async () => {
    /*
     * The end-to-end property, and the one that spans the two decisions in
     * this feature that could each look right alone.
     *
     * The extraction is stored with ABSOLUTE image addresses, not proxied
     * ones: the signature depends on `CADENCE_IMG_SECRET`, and a stored
     * signature stops verifying the moment that key is rotated — every image
     * in every article broken until a backfill. So the rewrite happens on
     * READ, in `db/map.ts`, which costs one HMAC per image and survives
     * rotation.
     *
     * Those two halves are in different files and neither test covers the
     * seam, so this asks the only question that matters: what is in the `src`
     * the reader's browser will fetch.
     */
    /*
     * SET AND UNSET AROUND THE WHOLE CASE. Assigned without a `finally` it
     * leaked into every later test in this file whenever an assertion here
     * failed — which is how a suite starts depending on its own run order.
     */
    process.env.CADENCE_IMG_SECRET = "test-secret-for-extraction-end-to-end";
    try {
      const withImage = await makeArticle("proxied");
      const { fetcher } = recordingFetcher({
        [withImage.url]: changed(page(`${LONG}<p><img src="/photo.jpg"></p>`), withImage.url),
      });
      await applyExtraction(READER, Number(withImage.articleId), fetcher);

      // STORED ABSOLUTE, which is the half that survives key rotation.
      const stored = await rowFor(withImage.articleId);
      expect(stored.extractedHtml).toContain(`https://extract-proxied-${RUN}.example/photo.jpg`);
      expect(stored.extractedHtml).not.toContain("/api/img");

      const viewer = { kind: "user", user: { id: READER } } as unknown as Parameters<
        typeof getArticle
      >[0];
      const article = await getArticle(viewer, Number(withImage.articleId));

      /*
       * SERVED PROXIED, so the publisher never sees the reader's IP or Referer.
       *
       * READ OFF THE PARSED ATTRIBUTE, not the markup string. In serialised HTML
       * the separator is `&amp;s=`, which is correct and which a substring check
       * for `&s=` fails on — asserting on the raw string tests the serialiser,
       * not the behaviour. This is the value the browser will actually request.
       */
      const doc = new DOMParser().parseFromString(`<body>${article!.body}</body>`, "text/html");
      const src = doc.body.querySelector("img")?.getAttribute("src") ?? "";

      /*
       * THE TEST IS WHERE THE BROWSER WILL GO, which is our own origin. The
       * publisher's address IS in the query string — that is the design, and an
       * earlier version of this assertion read its presence as a leak and
       * failed. What would be a leak is the `src` pointing AT the publisher, so
       * that is what is checked: a relative path to `/api/img`.
       */
      expect(src.startsWith("/api/img?")).toBe(true);
      expect(src).toContain("&s=");
      expect(src).toContain(encodeURIComponent(`https://extract-proxied-${RUN}.example/photo.jpg`));
    } finally {
      delete process.env.CADENCE_IMG_SECRET;
    }
  }, 30_000);

  it("refuses an id that is not an id, rather than reaching BigInt()", async () => {
    // These arrive from a client. `BigInt(1.5)` throws a RangeError, which
    // surfaces as a 500 on opening an article.
    const { calls, fetcher } = recordingFetcher({});
    for (const bad of [0, -1, 1.5]) {
      await expect(applyExtraction(READER, bad, fetcher)).rejects.toBeInstanceOf(
        ArticleNotExtractable,
      );
    }
    expect(calls).toEqual([]);
  });
});
