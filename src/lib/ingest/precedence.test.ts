import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parse } from "./parse";

/*
 * What this suite is for: the two field choices that make the product feel
 * broken while every test still passes.
 *
 *   - Take `description` over `content:encoded` and the reader shows a teaser
 *     forever, on roughly half the feeds on the web. The app looks like it
 *     cannot fetch articles.
 *   - Take `updated` over `published` and every edited post jumps to the top of
 *     the list. The reader looks like it is inventing news.
 *
 * Both are one-line mistakes that a library's defaults make for you, which is
 * why §6.3 writes the precedence down instead of inheriting it.
 */

const DIR = join(__dirname, "../../../test/fixtures/feeds");
const bytes = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));

const firstItem = (file: string) => {
  const result = parse(bytes(file));
  if (!result.ok) throw new Error(`${file} did not parse: ${result.reason} ${result.detail}`);
  return result.items[0];
};

describe("content precedence", () => {
  it("prefers content:encoded over a truncated description", () => {
    const item = firstItem("22-teaser-vs-content-encoded.xml");
    expect(item.contentHtml).toContain("the whole argument happens below the rule");
    // The teaser is kept as the summary rather than thrown away: the list shows
    // the summary and the reading pane shows the content.
    expect(item.summaryHtml).toContain("argue with herself in public");
    expect(item.contentHtml).not.toBe(item.summaryHtml);
  });

  it("unwraps CDATA in both fields", () => {
    const item = firstItem("01-rss2-cdata.xml");
    expect(item.contentHtml).toContain("<p>The harbour council voted last night");
    expect(item.contentHtml).not.toContain("CDATA");
    expect(item.summaryHtml).not.toContain("CDATA");
  });

  it("leaves contentHtml null when the feed ships only a description", () => {
    // Null rather than a copy of the summary, because §6.5's teaser detection
    // keys on `contentHtml == null` to decide whether to extract.
    const item = firstItem("12-no-guid-anywhere.xml");
    expect(item.contentHtml).toBeNull();
    expect(item.summaryHtml).not.toBeNull();
  });

  it("takes content from Atom's content element, not its summary", () => {
    const item = firstItem("02-atom-xml-base.xml");
    expect(item.contentHtml).toContain("<p>A timetable is a record");
    expect(item.summaryHtml).toBe("A timetable is a record of what a town agreed to wait for.");
  });

  it("reads content:encoded in RSS 1.0 too", () => {
    const item = firstItem("03-rdf-rss1.xml");
    expect(item.contentHtml).toContain("I walked the length of Orchard Street");
  });
});

describe("date precedence", () => {
  it("prefers published over updated, so an edit does not re-sort the list", () => {
    const item = firstItem("23-atom-published-vs-updated.xml");
    expect(item.publishedAt).toBe("2026-10-28T06:00:00.000Z");
    expect(item.publishedAt).not.toBe("2026-11-03T02:14:00.000Z");
  });

  it("falls back to updated when there is no published", () => {
    // Better than null: an undated item sorts to the bottom of every list.
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>x</id><title>Only updated</title><updated>2026-11-02T10:00:00Z</updated></entry></feed>`;
    const result = parse(new TextEncoder().encode(atom));
    expect(result.ok && result.items[0].publishedAt).toBe("2026-11-02T10:00:00.000Z");
  });

  it("reads dc:date when it is the only date present", () => {
    const item = firstItem("25-dc-date-only.xml");
    expect(item.publishedAt).toBe("2026-10-27T07:30:00.000Z");
  });

  it("parses RFC 822 pubDate into ISO", () => {
    const item = firstItem("01-rss2-cdata.xml");
    expect(item.publishedAt).toBe("2026-11-12T09:12:00.000Z");
  });

  it("returns null for an unparseable date rather than today", () => {
    // Defaulting to `now` is what makes a whole feed look new on every poll.
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><item>
      <title>Bad date</title><link>https://x.example/1</link>
      <pubDate>last Tuesday-ish</pubDate></item></channel></rss>`;
    const result = parse(new TextEncoder().encode(rss));
    expect(result.ok && result.items[0].publishedAt).toBeNull();
  });
});

describe("url precedence", () => {
  it("prefers the alternate link over a permalink guid", () => {
    // A permalink guid is often the CMS's `?p=1842` form, which canonicalises
    // to a different key than the pretty URL every other feed carries.
    const item = firstItem("24-guid-permalink-vs-link.xml");
    expect(item.url).toBe("https://harbourwire.example/2026/11/12/canonical");
    expect(item.guid).toBe("https://harbourwire.example/?p=1842");
  });

  it("takes Atom's rel=alternate link, not merely the first link", () => {
    // Raw and unresolved: `parse` reports what the document said and
    // `normalize` resolves it against the base chain. The resolved form is
    // asserted in normalize.test.ts.
    const item = firstItem("02-atom-xml-base.xml");
    expect(item.url).toBe("ferry-timetable");
    expect(item.url).not.toContain("/comments");
  });

  it("keeps the guid and the url as separate fields", () => {
    // The ladder needs both: rung 1 keys on the guid, rung 2 on the url. A
    // parser that collapses them into one id makes rung 2 impossible.
    const item = firstItem("01-rss2-cdata.xml");
    expect(item.guid).toBe("tag:harbourwire.example,2026:1842");
    expect(item.url).toBe("https://harbourwire.example/2026/11/12/tidal-barrier-vote");
  });
});

describe("author precedence", () => {
  it("reads dc:creator when there is no author element", () => {
    const item = firstItem("01-rss2-cdata.xml");
    expect(item.author).toBe("Dana Okoro");
  });

  it("reads an Atom author name", () => {
    expect(firstItem("02-atom-xml-base.xml").author).toBe("Ines Calloway");
  });

  it("reads a JSON Feed author name", () => {
    expect(firstItem("04-json-feed.json").author).toBe("The Plainfield team");
  });
});

describe("feed-level fields", () => {
  it("reads <ttl> in seconds, for the scheduler to treat as a floor", () => {
    const result = parse(bytes("17-declares-ttl.xml"));
    // `<ttl>60</ttl>` is 60 MINUTES in RSS. Reading it as seconds would make
    // the floor 60s and the reader 60x more aggressive than the publisher asked.
    expect(result.ok && result.declaredTtlS).toBe(3600);
  });

  it("leaves declaredTtlS null when no ttl is given", () => {
    const result = parse(bytes("01-rss2-cdata.xml"));
    expect(result.ok && result.declaredTtlS).toBeNull();
  });

  it("reads the feed's own alternate link, which is the second base link", () => {
    const result = parse(bytes("02-atom-xml-base.xml"));
    expect(result.ok && result.siteUrl).toBe("https://fenwickreview.example");
  });

  it("reports xml:base, which is the first base link", () => {
    // Without this the whole xml:base hazard is unreachable: `normalize`
    // accepts an `xmlBase` nobody could supply, and fixture 02 silently
    // resolves against the feed URL instead.
    const result = parse(bytes("02-atom-xml-base.xml"));
    expect(result.ok && result.xmlBase).toBe("https://fenwickreview.example/essays/");
  });

  it("leaves xmlBase null when the document declares none", () => {
    const result = parse(bytes("01-rss2-cdata.xml"));
    expect(result.ok && result.xmlBase).toBeNull();
  });
});
