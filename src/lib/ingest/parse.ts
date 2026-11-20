import { parseFeed } from "feedsmith";

import type { Dialect, RawItem } from "@/lib/types";

import { repair, sanitize } from "./preclean";
import { decode, sniffText } from "./sniff";

/*
 * Bytes in, `RawItem[]` out.
 *
 * THIS IS THE ONLY FORMAT-AWARE MODULE IN THE CODEBASE. Everything downstream
 * sees one `RawItem` shape, which is what makes swapping the parser a one-file
 * change (§6.3) and what lets M7's ladder be written once rather than four
 * times.
 *
 * Nothing here throws. A feed that cannot be read returns a TYPED rejection,
 * because the cron route must never answer 500 — a thrown parse error takes
 * down a whole sweep of 25 feeds for one publisher's bad deploy (§4).
 */

export type ParseRejection = {
  ok: false;
  reason: "not_a_feed" | "parse" | "empty" | "unsupported";
  detail: string;
};

export type ParseSuccess = {
  ok: true;
  dialect: Exclude<Dialect, "not_a_feed" | "unknown">;
  items: RawItem[];
  /** The feed's own `<link rel="alternate">`, which is the second base link. */
  siteUrl: string | null;
  /**
   * The document's `xml:base`, which is the FIRST link in the base chain
   * (§6.3). Returned rather than applied, because resolving URLs is
   * `normalize`'s job and this module's is to report what the document said.
   *
   * This is the FEED-level value. `xml:base` is legal on any element and it
   * nests, so an item's own base — carried on `RawItem.xmlBase` — narrows this
   * one.
   */
  xmlBase: string | null;
  title: string | null;
  /** `<ttl>` in seconds. A FLOOR for the scheduler, never a ceiling (§6.4). */
  declaredTtlS: number | null;
  /** True when a repair pass was ATTEMPTED, which only happens after a failure. */
  repaired: boolean;
};

export type ParseResult = ParseSuccess | ParseRejection;

/** Feedsmith's date fields come through as strings; normalise to ISO or null. */
function toIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

type AnyRecord = Record<string, unknown>;

/** An element's own `xml:base`, which narrows the feed's (§6.3). Usually absent. */
function ownXmlBase(raw: AnyRecord): string | null {
  return firstString((raw.xml as { base?: string } | undefined)?.base);
}

/** Looks like a web address, as opposed to a `tag:` or `urn:uuid:` identifier. */
function looksLikeHttpUrl(value: string | null): boolean {
  return value !== null && /^https?:\/\//i.test(value.trim());
}

/*
 * Field precedence, written down here rather than inherited from the library.
 *
 * §6.3's two rules, each of which has a wrong answer that looks like success:
 *   - CONTENT prefers `content:encoded` over `description`. Taking description
 *     shows the reader a teaser forever, on half the feeds on the web.
 *   - DATE prefers `published` over `updated`. Taking updated makes every
 *     edited post jump to the top of the list.
 *   - URL prefers an `alternate` link over `<guid isPermaLink>`, because a
 *     permalink guid is often the CMS's `?p=1842` form.
 */

function rssItemToRaw(raw: AnyRecord): RawItem {
  const guid = raw.guid as AnyRecord | undefined;
  const dc = raw.dc as { creators?: string[]; dates?: unknown[] } | undefined;
  const content = raw.content as { encoded?: string } | undefined;
  const authors = raw.authors as { name?: string }[] | undefined;

  /*
   * `<link>` is RSS's alternate link and wins. A permalink guid is the
   * fallback, and `isPermaLink` DEFAULTS TO TRUE in RSS 2.0 — so an absent
   * attribute means the guid IS a URL. Testing `=== true` instead of
   * `!== false` is a real bug: the most common form in the wild is
   * `<guid>https://…</guid>` with no attribute and no `<link>`, and treating
   * that as having no URL leaves rung 2 of the ladder nothing to key on.
   *
   * The shape guard is still needed, because plenty of feeds write
   * `isPermaLink="true"` over a `tag:` or `urn:uuid:` identifier.
   */
  const guidAsUrl =
    guid?.isPermaLink !== false && looksLikeHttpUrl(firstString(guid?.value))
      ? firstString(guid?.value)
      : null;

  return {
    guid: firstString(guid?.value),
    url: firstString(raw.link, guidAsUrl),
    title: firstString(raw.title),
    author: firstString(authors?.[0]?.name, dc?.creators?.[0]),
    publishedAt: toIso(raw.pubDate) ?? toIso(dc?.dates?.[0]),
    contentHtml: firstString(content?.encoded),
    summaryHtml: firstString(raw.description),
    xmlBase: ownXmlBase(raw),
  };
}

function atomEntryToRaw(raw: AnyRecord): RawItem {
  const links = (raw.links as { href?: string; rel?: string }[] | undefined) ?? [];
  /*
   * ONLY `rel="alternate"`, or a link with no rel at all — Atom's default.
   *
   * There is no fallback to `links[0]`, and that omission is deliberate. A
   * podcast entry often carries only `rel="enclosure"`, so falling back to the
   * first link hands the `.mp3` back as the article URL — which then becomes
   * rung 2's dedupe key and the address the reader opens. No URL is the honest
   * answer; the guid still identifies the item.
   */
  const alternate = links.find((l) => (l.rel ?? "alternate") === "alternate");
  const content = raw.content as { value?: string } | undefined;
  const summary = raw.summary as { value?: string } | string | undefined;
  const title = raw.title as { value?: string } | string | undefined;
  const authors = raw.authors as { name?: string }[] | undefined;

  return {
    guid: firstString(raw.id),
    url: firstString(alternate?.href),
    title: firstString(typeof title === "string" ? title : title?.value),
    author: firstString(authors?.[0]?.name),
    // published over updated: an edit must not re-sort the list.
    publishedAt: toIso(raw.published) ?? toIso(raw.updated),
    contentHtml: firstString(content?.value),
    summaryHtml: firstString(typeof summary === "string" ? summary : summary?.value),
    xmlBase: ownXmlBase(raw),
  };
}

function rdfItemToRaw(raw: AnyRecord): RawItem {
  const dc = raw.dc as { creators?: string[]; dates?: unknown[] } | undefined;
  const content = raw.content as { encoded?: string } | undefined;
  const rdf = raw.rdf as { about?: string } | undefined;

  return {
    // RSS 1.0 has no guid; `rdf:about` is the item's identifier.
    guid: firstString(rdf?.about),
    url: firstString(raw.link, rdf?.about),
    title: firstString(raw.title),
    author: firstString(dc?.creators?.[0]),
    publishedAt: toIso(dc?.dates?.[0]),
    contentHtml: firstString(content?.encoded),
    summaryHtml: firstString(raw.description),
    xmlBase: ownXmlBase(raw),
  };
}

function jsonItemToRaw(raw: AnyRecord): RawItem {
  const authors = raw.authors as { name?: string }[] | undefined;
  return {
    guid: firstString(raw.id),
    url: firstString(raw.url, raw.external_url),
    title: firstString(raw.title),
    author: firstString(authors?.[0]?.name),
    publishedAt: toIso(raw.date_published) ?? toIso(raw.date_modified),
    contentHtml: firstString(raw.content_html),
    summaryHtml: firstString(raw.summary, raw.content_text),
    // JSON Feed has no xml:base; its URLs are absolute by specification.
    xmlBase: null,
  };
}

/** Feedsmith's format names, mapped to ours. */
const DIALECT_OF = {
  rss: "rss2",
  rdf: "rss1",
  atom: "atom",
  json: "json",
} as const;

const ITEM_MAPPER = {
  rss: rssItemToRaw,
  rdf: rdfItemToRaw,
  atom: atomEntryToRaw,
  json: jsonItemToRaw,
} as const;

function channelOf(format: keyof typeof DIALECT_OF, feed: AnyRecord) {
  if (format === "json") {
    return {
      title: firstString(feed.title),
      siteUrl: firstString(feed.home_page_url),
      items: (feed.items as AnyRecord[] | undefined) ?? [],
      ttl: null as number | null,
      xmlBase: null as string | null,
    };
  }
  if (format === "atom") {
    const links = (feed.links as { href?: string; rel?: string }[] | undefined) ?? [];
    const title = feed.title as { value?: string } | string | undefined;
    return {
      title: firstString(typeof title === "string" ? title : title?.value),
      siteUrl: firstString(links.find((l) => (l.rel ?? "alternate") === "alternate")?.href),
      items: (feed.entries as AnyRecord[] | undefined) ?? [],
      ttl: null as number | null,
      xmlBase: firstString((feed.xml as { base?: string } | undefined)?.base),
    };
  }
  const ttl = typeof feed.ttl === "number" ? feed.ttl : Number.parseInt(String(feed.ttl ?? ""), 10);
  return {
    title: firstString(feed.title),
    siteUrl: firstString(feed.link),
    items: (feed.items as AnyRecord[] | undefined) ?? [],
    ttl: Number.isFinite(ttl) && ttl > 0 ? ttl * 60 : null,
    xmlBase: firstString((feed.xml as { base?: string } | undefined)?.base),
  };
}

/** One parse attempt on already-decoded text. Returns null if it threw. */
function attempt(text: string): { format: keyof typeof DIALECT_OF; feed: AnyRecord } | null {
  try {
    const parsed = parseFeed(text) as { format: keyof typeof DIALECT_OF; feed: AnyRecord };
    return parsed.format in DIALECT_OF ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The whole read path: decode, sniff, parse, repair once, map.
 *
 * `contentType` is taken only for its `charset`. It is deliberately NOT used to
 * decide the format — the root element does that, which is what makes an HTML
 * error page a typed state rather than a silently empty feed.
 */
export function parse(bytes: Uint8Array, contentType?: string): ParseResult {
  if (bytes.length === 0) return { ok: false, reason: "empty", detail: "zero-length body" };

  // Sanitised BEFORE the first attempt, not as part of the repair path. A
  // control character that survives into a title also survives into rung 3's
  // content hash, so the same article hashes two ways (see preclean.ts).
  const text = sanitize(decode(bytes, contentType).text);
  if (text.trim() === "") return { ok: false, reason: "empty", detail: "body is whitespace only" };

  const dialect = sniffText(text);
  if (dialect === "not_a_feed") {
    return { ok: false, reason: "not_a_feed", detail: "the body is an HTML document" };
  }
  if (dialect === "unknown") {
    return {
      ok: false,
      reason: "unsupported",
      detail: "no RSS, RDF, Atom or JSON Feed root could be found",
    };
  }

  let repaired = false;
  let parsed = attempt(text);
  if (!parsed && dialect !== "json") {
    // The one repair pass. JSON is excluded: `repair` is an XML repair, and
    // escaping ampersands inside JSON corrupts rather than fixes.
    repaired = true;
    parsed = attempt(repair(text));
  }

  if (!parsed) {
    return {
      ok: false,
      reason: "parse",
      detail: repaired ? "failed to parse, including after one repair pass" : "failed to parse",
    };
  }

  const { format, feed } = parsed;
  const channel = channelOf(format, feed);
  const map = ITEM_MAPPER[format];

  return {
    ok: true,
    dialect: DIALECT_OF[format],
    items: channel.items.map((i) => map(i)),
    siteUrl: channel.siteUrl,
    xmlBase: channel.xmlBase,
    title: channel.title,
    declaredTtlS: channel.ttl,
    repaired,
  };
}
