import { describe, expect, it } from "vitest";

import type { FetchOutcome } from "@/lib/ingest/fetch";

import { MAX_CANDIDATES, alternateLinks, discoverAt, withScheme } from "./discover";

/*
 * What this suite is for: the second-order fetch, which is the riskiest thing
 * this project does.
 *
 * Discovery reads `<link rel="alternate">` out of a page and fetches what it
 * finds. Those hrefs come from the PAGE, not from the reader — so guarding the
 * address someone typed says nothing about what the response tells us to fetch
 * next, and a public site can advertise `http://169.254.169.254/` as its feed.
 * The assertion that matters is not "it was refused" but "it was never dialled":
 * the injected fetcher records every call, so a request to a blocked address is
 * visible rather than inferred.
 *
 * NO DNS, deliberately. Every address here is a literal IP, which `guardUrl`
 * checks without a lookup — so the suite cannot fail because a name stopped
 * resolving, and it never touches the network. The fetcher is injected for the
 * same reason `fetchFeed` injects its validator.
 */

/** A public literal address: no DNS, and the real guard allows it. */
const PUBLIC = "http://93.184.216.34";
/** AWS's instance metadata endpoint — the canonical SSRF target. */
const METADATA = "http://169.254.169.254/latest/meta-data/";

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Harbour Wire</title>
  <item><title>One</title><link>${PUBLIC}/1</link><pubDate>Tue, 11 Nov 2026 09:00:00 GMT</pubDate></item>
  <item><title>Two</title><link>${PUBLIC}/2</link><pubDate>Wed, 12 Nov 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;

const bytes = (text: string) => new TextEncoder().encode(text);

const changed = (body: string, contentType: string, at = `${PUBLIC}/`): FetchOutcome => ({
  kind: "changed",
  status: 200,
  body: bytes(body),
  contentType,
  etag: null,
  lastModified: null,
  bodyHash: new Uint8Array(32),
  finalUrl: null,
  landedUrl: at,
  durationMs: 1,
  bytes: body.length,
});

/**
 * A page served from somewhere else after a TEMPORARY redirect.
 *
 * `finalUrl` stays null, which is correct — only a permanently-redirected chain
 * may move `feeds.feed_url` — and `landedUrl` says where the body came from.
 * Discovery must use the latter: reading `finalUrl` resolved relative hrefs
 * against the typed address after any 302, which is the bug this case pins.
 */
const temporarilyRedirectedTo = (body: string, landedUrl: string): FetchOutcome => ({
  kind: "changed",
  status: 200,
  body: bytes(body),
  contentType: "text/html",
  etag: null,
  lastModified: null,
  bodyHash: new Uint8Array(32),
  finalUrl: null,
  landedUrl,
  durationMs: 1,
  bytes: body.length,
});

const failed = (): FetchOutcome => ({
  kind: "failed",
  status: null,
  code: "timeout",
  detail: null,
  retryAfterS: null,
  durationMs: 1,
});

/** A fetcher that answers from a map and records every address it was asked for. */
function recordingFetcher(pages: Record<string, FetchOutcome>) {
  const calls: string[] = [];
  const fetcher = (url: string) => {
    calls.push(url);
    return Promise.resolve(pages[url] ?? failed());
  };
  return { calls, fetcher: fetcher as unknown as typeof import("./fetch").fetchFeed };
}

describe("discovering feeds at an address", () => {
  it("NEVER DIALS a private address a page advertises", async () => {
    /*
     * THE BUG THIS SUITE EXISTS FOR. The page is at a public address and passes
     * the first guard; it then claims its feed lives at the metadata endpoint.
     * Nothing about the reader's input is suspicious — the danger arrives in
     * the response.
     */
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="${METADATA}">
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    </head></html>`;

    const { calls, fetcher } = recordingFetcher({
      [`${PUBLIC}/`]: changed(html, "text/html"),
      [`${PUBLIC}/feed.xml`]: changed(RSS, "application/rss+xml"),
    });

    const result = await discoverAt(`${PUBLIC}/`, fetcher);

    expect(calls).not.toContain(METADATA);
    expect(calls.some((url) => url.includes("169.254"))).toBe(false);
    // And the legitimate sibling link still worked, so the refusal is targeted
    // rather than discovery giving up at the first bad href.
    expect(result.kind).toBe("found");
  });

  it("CAPS the fan-out, so one request cannot become many", async () => {
    /*
     * A page listing more feeds than this is not a feed list; it is a target
     * list, and one request becoming an unbounded number of outbound fetches is
     * an amplifier pointed at a host someone else chose.
     */
    const total = MAX_CANDIDATES + 55;
    const links = Array.from(
      { length: total },
      (_, i) => `<link rel="alternate" type="application/rss+xml" href="/f${i}.xml">`,
    ).join("");

    /*
     * EVERY ADVERTISED LINK ANSWERS WITH SOMETHING THAT IS NOT A FEED, which is
     * the case the first version of this test missed. Counting collected
     * candidates let a page of non-feed links cost one guard and one fetch
     * each: sixty links, sixty-one calls, while the cap still read as five.
     */
    const pages: Record<string, FetchOutcome> = {
      [`${PUBLIC}/`]: changed(`<html><head>${links}</head></html>`, "text/html"),
    };
    for (let i = 0; i < total; i += 1) {
      pages[`${PUBLIC}/f${i}.xml`] = changed("<html>not a feed</html>", "text/html");
    }

    const { calls, fetcher } = recordingFetcher(pages);
    await discoverAt(`${PUBLIC}/`, fetcher);

    // The page itself, plus at most the cap in attempts.
    expect(calls.length).toBeLessThanOrEqual(MAX_CANDIDATES + 1);
  });

  it("resolves a relative href against where the page was SERVED, after a 302", async () => {
    /*
     * A redirect moves what a relative href means. Resolving against the typed
     * address fetches the wrong path — or, on a cross-host redirect, the wrong
     * host.
     *
     * TEMPORARY on purpose: `finalUrl` is only set for a chain that was
     * permanent throughout, so reading it here used the typed address after
     * every 302 and reported "no feed" for a site that simply bounces `/` to
     * `/blog/`. That is the common shape, not the exotic one.
     */
    const html = `<html><head><link rel="alternate" type="application/atom+xml" href="feed"></head></html>`;

    const { calls, fetcher } = recordingFetcher({
      [`${PUBLIC}/`]: temporarilyRedirectedTo(html, `${PUBLIC}/blog/`),
      [`${PUBLIC}/blog/feed`]: changed(RSS, "application/rss+xml"),
    });

    await discoverAt(`${PUBLIC}/`, fetcher);

    expect(calls).toContain(`${PUBLIC}/blog/feed`);
  });

  it("takes the address itself when it IS a feed", async () => {
    // The common case: someone pastes a feed URL rather than a site.
    const { calls, fetcher } = recordingFetcher({
      [`${PUBLIC}/feed`]: changed(RSS, "application/rss+xml"),
    });

    const result = await discoverAt(`${PUBLIC}/feed`, fetcher);

    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.title).toBe("Harbour Wire");
      expect(result.candidates[0]!.items).toBe(2);
      expect(result.candidates[0]!.format).toBe("rss2");
    }
    // One fetch, because there was nothing to follow.
    expect(calls).toEqual([`${PUBLIC}/feed`]);
  });

  it("reports NO last post for a feed whose items carry no date", async () => {
    /*
     * `lastPost: ""`, and the add-feed screen has to handle it: plenty of RSS
     * omits `pubDate` entirely. The screen formatted it unconditionally, so
     * every candidate from such a feed read "Last post Invalid Date" — the
     * fixtures all carried dates, so nothing showed it.
     */
    const undated = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>No Dates Here</title>
  <item><title>One</title><link>${PUBLIC}/1</link></item>
</channel></rss>`;

    const { fetcher } = recordingFetcher({
      [`${PUBLIC}/feed`]: changed(undated, "application/rss+xml"),
    });

    const result = await discoverAt(`${PUBLIC}/feed`, fetcher);

    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.candidates[0]!.lastPost).toBe("");
  });

  it("refuses a blocked address WITHOUT naming the reason", async () => {
    /*
     * The guard distinguishes `private_address` from `dns_failed` from
     * `port_not_allowed`, which is what an operator needs in `fetch_log` and
     * what a prober wants from a screen. The reader gets one answer.
     */
    const { calls, fetcher } = recordingFetcher({});

    const result = await discoverAt(METADATA, fetcher);

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).not.toMatch(/private|dns|port/i);
    }
    // Refused before any request, which is the whole point.
    expect(calls).toEqual([]);
  });

  it("reports an address that did not answer as unreachable, not as no-feed", async () => {
    // Four distinct outcomes exist because a reader who pasted a dead host and
    // one who pasted a feedless site need different next actions (§6.3).
    const { fetcher } = recordingFetcher({});

    const result = await discoverAt(`${PUBLIC}/`, fetcher);
    expect(result.kind).toBe("unreachable");
  });

  it("reports a page with no feed links as none", async () => {
    const { fetcher } = recordingFetcher({
      [`${PUBLIC}/`]: changed(
        "<html><head><title>No feeds here</title></head></html>",
        "text/html",
      ),
    });

    const result = await discoverAt(`${PUBLIC}/`, fetcher);
    expect(result.kind).toBe("none");
  });

  it("rejects something that is not an address before any lookup", async () => {
    const { calls, fetcher } = recordingFetcher({});

    for (const bad of ["", "   ", 42, null, undefined, {}]) {
      const result = await discoverAt(bad, fetcher);
      expect(result.kind, JSON.stringify(bad)).toBe("invalid");
    }
    expect(calls).toEqual([]);
  });
});

describe("reading feed links out of a page", () => {
  it("takes only rel=alternate with a feed type", () => {
    // A stylesheet and a canonical link are both `<link>`; neither is a feed,
    // and fetching them would be the fan-out spent on nothing.
    const html = `
      <link rel="stylesheet" href="/app.css">
      <link rel="canonical" href="https://x.example/">
      <link rel="alternate" type="text/html" href="/amp">
      <link rel="alternate" type="application/rss+xml" href="/rss">
      <link rel='alternate' type='application/atom+xml' href='/atom'>
      <link rel="alternate" type="application/feed+json" href="/json">`;

    expect(alternateLinks(html)).toEqual(["/rss", "/atom", "/json"]);
  });
});

describe("filling in a missing scheme", () => {
  it("assumes https for a bare host, and leaves a scheme alone", () => {
    // What a reader types is "example.com/feed". Assuming http would downgrade
    // every paste.
    expect(withScheme("example.com/feed")).toBe("https://example.com/feed");
    expect(withScheme("http://example.com/feed")).toBe("http://example.com/feed");
    expect(withScheme(" https://example.com ")).toBe("https://example.com");
  });
});
