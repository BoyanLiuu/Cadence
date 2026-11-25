import { fetchFeed } from "@/lib/ingest/fetch";
import { guardUrl } from "@/lib/net/guard";
import { normalize } from "@/lib/ingest/normalize";
import { parse } from "@/lib/ingest/parse";
import { nextIntervalSeconds } from "@/lib/schedule/interval";
import type { Candidate, DiscoveryResult, FeedFormat } from "@/lib/types";

/*
 * Resolving an address to feeds, for real (§6.3, M12).
 *
 * EVERY CANDIDATE IS FETCHED BEFORE IT IS OFFERED. That is the point of the
 * screen: it states the format, the item count and the last post, so a reader
 * decides with facts rather than discovering at subscribe time that the address
 * was a login page. §6.3's "validates each by fetching it" is this function.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND-ORDER FETCH, which is what makes this the riskiest code in the
 * project
 * ---------------------------------------------------------------------------
 * A site address is fetched, and its HTML is read for `<link rel="alternate">`.
 * Those hrefs come from the PAGE, not from the reader — so a public site can
 * advertise `http://169.254.169.254/latest/meta-data/` as its feed and this
 * server will dial it from inside its own network. Guarding the URL someone
 * typed says nothing about what the response tells us to fetch next.
 *
 * So every discovered URL goes back through `guardUrl` before it is fetched,
 * and `fetchFeed` guards each redirect hop again on top of that. Three places
 * the same address is checked, because each is a different address: what was
 * typed, what the page claimed, and where the redirect went.
 *
 * `MAX_CANDIDATES` caps the fan-out. One request becoming an unbounded number
 * of outbound fetches is an amplifier pointed at a host someone else chose, and
 * a page listing more than a handful of feeds is not a feed list.
 *
 * KNOWN AND ACCEPTED: timing. The reader waits on this, so a refusal that
 * returns instantly, a filtered port that hangs to the timeout and a closed
 * port that resets quickly are distinguishable — which makes discovery a slow
 * internal port scanner even when every fetch is refused. Padding every
 * response to a fixed floor would fix it and make the ordinary case worse for
 * the one reader this instance has. Recorded rather than assumed away, like
 * `REBIND_RESIDUAL` beside it.
 *
 * ALSO NOT DONE HERE: the rate limit ARCHITECTURE's table names. M14 is where
 * budgets and etiquette are measured; this notes the gap rather than
 * pretending to close it.
 */

/** The most feeds one page may advertise before this stops reading. */
export const MAX_CANDIDATES = 5;

/** Dialects `parse` reports that are feeds. */
const FEED_FORMATS = new Set<FeedFormat>(["rss2", "rss1", "atom", "json"]);

/**
 * `<link rel="alternate" type="...">` hrefs, in document order.
 *
 * A REGEX OVER HTML, which is the wrong tool in general and the right one here:
 * the alternative is a DOM parser on an attacker-controlled page, which is more
 * code, more dependency and more attack surface than reading two attributes.
 * Being wrong costs a missed candidate, and every href it does find is guarded
 * before anything is done with it — so a false positive is refused rather than
 * fetched.
 */
export function alternateLinks(html: string): string[] {
  const out: string[] = [];
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];

  for (const tag of tags) {
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (rel !== "alternate") continue;

    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const isFeedType = type.includes("rss") || type.includes("atom") || type.includes("feed+json");
    if (!isFeedType) continue;

    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href !== undefined && href.trim() !== "") out.push(href.trim());
  }
  return out;
}

/** `example.com/feed` → `https://example.com/feed`; anything with a scheme is left alone. */
export function withScheme(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return trimmed;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

type Fetcher = typeof fetchFeed;

/** One fetched address turned into a candidate, or `null` if it is not a feed. */
function candidateFrom(
  feedUrl: string,
  body: Uint8Array,
  contentType: string | undefined,
): Candidate | null {
  const parsed = parse(body, contentType);
  if (!parsed.ok || !FEED_FORMATS.has(parsed.dialect)) return null;

  const { items } = normalize(parsed.items, {
    xmlBase: parsed.xmlBase,
    siteUrl: parsed.siteUrl,
    feedUrl,
  });

  const published = items
    .map((item) => item.publishedAt)
    .filter((at): at is string => typeof at === "string" && at !== "")
    .sort()
    .reverse();

  /*
   * The interval shown is the one the scheduler WOULD choose, computed from
   * this feed's own rhythm — not a guess and not a default. A reader deciding
   * whether to follow something should see the cadence it will actually get
   * (§6.4), and deriving it here from the same function means the number on the
   * screen cannot drift from the number the sweep uses.
   */
  const intervalS = nextIntervalSeconds(0, {
    publishedAts: published,
    declaredTtlS: parsed.declaredTtlS,
    unchangedPolls: 0,
  });

  return {
    title: parsed.title ?? feedUrl,
    feedUrl,
    format: parsed.dialect,
    items: items.length,
    lastPost: published[0] ?? "",
    intervalS,
    preview: items.slice(0, 3).map((item) => ({
      title: item.title ?? "(untitled)",
      at: item.publishedAt ?? "",
    })),
  };
}

/**
 * Resolves a site or feed address to validated candidates. Writes nothing.
 *
 * `fetcher` is injected for the same reason `fetchFeed` injects its validator:
 * the tests need a loopback server, which the real guard correctly refuses.
 * Production takes the default.
 */
export async function discoverAt(
  input: unknown,
  fetcher: Fetcher = fetchFeed,
): Promise<DiscoveryResult> {
  if (typeof input !== "string" || input.trim() === "") {
    return { kind: "invalid", reason: "Paste a feed address or a site address." };
  }

  const typed = withScheme(input);

  const guard = await guardUrl(typed);
  if (!guard.ok) {
    /*
     * The guard's reason code is NOT shown. It distinguishes `private_address`
     * from `dns_failed` from `port_not_allowed`, which is exactly what an
     * operator needs in `fetch_log` and exactly what a prober wants from a
     * screen. A refusal here is "not an address we will fetch", and the three
     * reasons it might be are not the reader's business — the honest ones among
     * them are their own typo.
     */
    return { kind: "invalid", reason: "That is not an address Cadence can fetch." };
  }

  const first = await fetcher(guard.url.href);
  if (first.kind !== "changed") {
    return { kind: "unreachable", reason: "That address did not answer." };
  }

  // The address itself may be the feed, which is the common case for someone
  // pasting a feed URL rather than a site.
  const direct = candidateFrom(guard.url.href, first.body, first.contentType ?? undefined);
  if (direct !== null) return { kind: "found", candidates: [direct] };

  const html = new TextDecoder("utf-8", { fatal: false }).decode(first.body);
  const hrefs = alternateLinks(html);
  if (hrefs.length === 0) {
    return { kind: "none", reason: "No feed is advertised at that address." };
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  /*
   * SLICED, so the cap bounds ATTEMPTS and not successes. Counting collected
   * candidates instead let a page of sixty non-feed `rel=alternate` links cost
   * sixty guards and sixty fetches while the cap still read as five — which is
   * the amplifier the cap exists to prevent, measured at 61 calls.
   */
  for (const href of hrefs.slice(0, MAX_CANDIDATES)) {
    let absolute: string;
    try {
      /*
       * Resolved against where the body was SERVED FROM — `landedUrl`, which
       * is always set — rather than `finalUrl`, which only exists for a chain
       * that was permanent all the way through. A 302 from `/` to `/blog/`
       * leaves `finalUrl` null, so the old base was the typed address and the
       * feed was looked for on the wrong path.
       */
      absolute = new URL(href, first.landedUrl).href;
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    // THE SECOND-ORDER CHECK. This href came from the page.
    const hrefGuard = await guardUrl(absolute);
    if (!hrefGuard.ok) continue;

    const result = await fetcher(hrefGuard.url.href);
    if (result.kind !== "changed") continue;

    const candidate = candidateFrom(
      hrefGuard.url.href,
      result.body,
      result.contentType ?? undefined,
    );
    if (candidate !== null) candidates.push(candidate);
  }

  if (candidates.length === 0) {
    return { kind: "none", reason: "Nothing at that address parsed as a feed." };
  }
  return { kind: "found", candidates };
}
