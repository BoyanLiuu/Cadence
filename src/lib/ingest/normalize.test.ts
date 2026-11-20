import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RawItem } from "@/lib/types";

import { normalize, resolveUrl } from "./normalize";
import { parse } from "./parse";

/*
 * What this suite is for: an item with no identity at all.
 *
 * §6.3 is blunt about it — synthesising an id from an array position is the ONE
 * choice that guarantees duplicates. The position changes on the next poll, so
 * the same item gets a new id and inserts again, every poll, forever. There is
 * no later fix: the duplicates are already in the table and already read.
 *
 * The second job here is relative URL resolution, which is less dangerous but
 * more visible: get it wrong and every link in the reader is broken.
 */

const DIR = join(__dirname, "../../../test/fixtures/feeds");
const bytes = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: null,
  author: null,
  publishedAt: null,
  contentHtml: null,
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

const FEED = { feedUrl: "https://harbourwire.example/rss" };

describe("an item with no identity is dropped and counted", () => {
  it("drops an item with no guid, no url and no title", () => {
    const result = normalize([item({ summaryHtml: "orphan text" })], FEED);
    expect(result.items).toHaveLength(0);
    expect(result.droppedNoIdentity).toBe(1);
  });

  it("counts the drop rather than discarding it silently", () => {
    // The count goes into `fetch_log`. Without it, a feed that starts dropping
    // every item is indistinguishable from a feed that went quiet.
    const result = normalize([item(), item(), item({ guid: "keep" })], FEED);
    expect(result.items).toHaveLength(1);
    expect(result.droppedNoIdentity).toBe(2);
  });

  it("never assigns an index-derived id to replace the missing one", () => {
    const result = normalize([item(), item()], FEED);
    expect(result.items).toEqual([]);
    expect(result.items.map((i) => i.guid)).not.toContain("0");
  });

  it("keeps an item that has only a title", () => {
    // A title alone IS identity: rung 3 hashes the normalised title with the
    // first 500 characters of text, so a titled item still resolves.
    const result = normalize([item({ title: "Only a title" })], FEED);
    expect(result.items).toHaveLength(1);
    expect(result.droppedNoIdentity).toBe(0);
  });

  it("keeps an item that has only a url, and one that has only a guid", () => {
    expect(normalize([item({ url: "https://x.example/1" })], FEED).items).toHaveLength(1);
    expect(normalize([item({ guid: "tag:x,2026:1" })], FEED).items).toHaveLength(1);
  });

  it("treats whitespace-only fields as absent", () => {
    // "   " is not identity. Trusting it produces a row keyed on a blank.
    const result = normalize([item({ guid: "  ", url: "", title: "\n\t" })], FEED);
    expect(result.items).toHaveLength(0);
    expect(result.droppedNoIdentity).toBe(1);
  });

  it("drops exactly one item from the corpus fixture built for it", () => {
    const parsed = parse(bytes("21-item-with-no-identity.xml"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toHaveLength(2);

    const result = normalize(parsed.items, FEED);
    expect(result.items).toHaveLength(1);
    expect(result.droppedNoIdentity).toBe(1);
    expect(result.items[0].title).toBe("A sound item beside it");
  });
});

describe("relative URLs resolve against the base chain", () => {
  it("resolves against the feed URL when nothing else is given", () => {
    const result = normalize([item({ url: "/post/4", guid: "/post/4" })], FEED);
    expect(result.items[0].url).toBe("https://harbourwire.example/post/4");
  });

  it("prefers xml:base over the site URL and the feed URL", () => {
    expect(
      resolveUrl("ferry-timetable", {
        xmlBase: "https://fenwickreview.example/essays/",
        siteUrl: "https://fenwickreview.example",
        feedUrl: "https://fenwickreview.example/feed.atom",
      }),
    ).toBe("https://fenwickreview.example/essays/ferry-timetable");
  });

  it("prefers the site URL over the feed URL", () => {
    expect(
      resolveUrl("/a", {
        siteUrl: "https://other.example/x/",
        feedUrl: "https://harbourwire.example/rss",
      }),
    ).toBe("https://other.example/a");
  });

  it("skips a base that is itself relative", () => {
    // A publisher setting `xml:base="/essays/"` gives a base that cannot be a
    // base. Falling through beats producing nothing.
    expect(
      resolveUrl("ferry", { xmlBase: "/essays/", feedUrl: "https://fenwickreview.example/feed" }),
    ).toBe("https://fenwickreview.example/ferry");
  });

  it("leaves an already-absolute URL alone", () => {
    const url = "https://elsewhere.example/a/b?c=1#d";
    expect(resolveUrl(url, FEED)).toBe(url);
  });

  it("returns null rather than guessing when resolution is impossible", () => {
    // A broken link the reader can see beats a plausible wrong one it cannot.
    expect(resolveUrl("http://[not a host]/x", FEED)).toBeNull();
    expect(resolveUrl(null, FEED)).toBeNull();
    expect(resolveUrl("   ", FEED)).toBeNull();
  });

  it("resolves an Atom entry against the document's xml:base, end to end", () => {
    // The full chain, wired as the ingest pipeline will wire it at M7.
    const parsed = parse(bytes("02-atom-xml-base.xml"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = normalize(parsed.items, {
      xmlBase: parsed.xmlBase,
      siteUrl: parsed.siteUrl,
      feedUrl: "https://fenwickreview.example/feed.atom",
    });
    expect(result.items[0].url).toBe("https://fenwickreview.example/essays/ferry-timetable");
  });

  it("would resolve that entry wrongly without xml:base, which is the point", () => {
    // Proves the chain's first link is load-bearing rather than decorative:
    // drop it and the link silently becomes a 404 the reader cannot explain.
    const parsed = parse(bytes("02-atom-xml-base.xml"));
    if (!parsed.ok) throw new Error("fixture did not parse");

    const withoutBase = normalize(parsed.items, {
      siteUrl: parsed.siteUrl,
      feedUrl: "https://fenwickreview.example/feed.atom",
    });
    expect(withoutBase.items[0].url).toBe("https://fenwickreview.example/ferry-timetable");
  });

  it("lets an entry's own xml:base narrow the feed's", () => {
    // The three shapes, from the fixture built for this hazard. The cost of
    // getting it wrong is not a broken link: a wrong URL is a wrong url_hash,
    // which is rung 2's dedupe key.
    const parsed = parse(bytes("31-entry-level-xml-base.xml"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = normalize(parsed.items, {
      xmlBase: parsed.xmlBase,
      siteUrl: parsed.siteUrl,
      feedUrl: "https://fenwickreview.example/feed.atom",
    });

    expect(result.items.map((i) => i.url)).toEqual([
      // inherits the feed's base
      "https://fenwickreview.example/essays/ferry-timetable",
      // its own base is RELATIVE, so it resolves against the feed's first
      "https://fenwickreview.example/essays/2026/second-draft",
      // its own base is absolute and replaces the feed's outright
      "https://elsewhere.example/reprints/letters-to-a-harbourmaster",
    ]);
  });

  it("ignores an item base that cannot be resolved, rather than losing the URL", () => {
    const result = normalize([item({ guid: "x", url: "a", xmlBase: "http://[bad host]/" })], {
      xmlBase: "https://site.example/essays/",
      feedUrl: "https://site.example/feed",
    });
    expect(result.items[0].url).toBe("https://site.example/essays/a");
  });

  it("does not carry xmlBase past normalisation", () => {
    // Resolution has happened. Leaving the base on the item invites a second,
    // inconsistent resolution downstream.
    const result = normalize([item({ guid: "x", url: "a", xmlBase: "2026/" })], FEED);
    expect(result.items[0].xmlBase).toBeNull();
  });

  it("resolves the corpus's relative-only fixture end to end", () => {
    const parsed = parse(bytes("13-relative-links-only.xml"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = normalize(parsed.items, { siteUrl: parsed.siteUrl, ...FEED });
    expect(result.items[0].url).toBe("https://harbourwire.example/post/4");
  });

  it("does not follow a redirect to canonicalise", () => {
    // §6.1: one HTTP request per item turns a 40-item poll into 40 requests
    // against a publisher you were being polite to. `normalize` is pure, and
    // this test documents that it must stay that way — shortened URLs are
    // resolved lazily by the first extraction (§6.5).
    const shortened = "https://exmpl.co/abc123";
    expect(resolveUrl(shortened, FEED)).toBe(shortened);
  });
});

describe("text is tidied without changing meaning", () => {
  it("collapses whitespace runs, so a reflowed title is not a new title", () => {
    // A publisher re-indenting their template must not change the content hash
    // and resurface every article as new.
    const result = normalize([item({ title: "Council  votes\n   to raise\tthe barrier" })], FEED);
    expect(result.items[0].title).toBe("Council votes to raise the barrier");
  });

  it("trims the guid, which is a hash input", () => {
    const result = normalize([item({ guid: "  tag:x,2026:1  " })], FEED);
    expect(result.items[0].guid).toBe("tag:x,2026:1");
  });

  it("leaves content and summary HTML untouched", () => {
    // Collapsing whitespace inside markup would change `<pre>` blocks, and
    // sanitisation is §6.5's job rather than this module's.
    const html = "<pre>  two   spaces\n  kept</pre>";
    const result = normalize([item({ guid: "x", contentHtml: html, summaryHtml: html })], FEED);
    expect(result.items[0].contentHtml).toBe(html);
    expect(result.items[0].summaryHtml).toBe(html);
  });

  it("is pure: the same input twice gives the same output", () => {
    // No clock, no network, no counter. M7 reruns this on every poll and a
    // difference between runs would read as an edit.
    const input = [item({ guid: "x", url: "/a", title: "A  title" })];
    expect(normalize(input, FEED)).toEqual(normalize(input, FEED));
  });
});
