import { describe, expect, it } from "vitest";

import { normalize, resolveUrl } from "./normalize";
import { parse } from "./parse";
import { closeUnclosedTags, escapeBareAmpersands, repair, sanitize } from "./preclean";
import { sniffText } from "./sniff";

/*
 * Regressions.
 *
 * Every case below is a bug this module actually had, found by review rather
 * than by the corpus. They live together because they share one cause: the
 * repair pass runs on exactly ONE corpus body, so almost nothing exercised it,
 * and a transform that makes a document worse is invisible until a real feed
 * trips it. A fixture per bug would be more faithful to M2's method; these are
 * unit cases because each is a property of a transform, not of a publisher.
 */

const FEED = { feedUrl: "https://harbourwire.example/rss" };
const xml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${body}</channel></rss>`;

describe("the repair pass never damages a document", () => {
  it("leaves a balanced tag alone, even with markup inside it", () => {
    // THE BUG: `<description>A teaser with <em>markup</em></description>` was
    // closed at the `<em`, orphaning the rest. A feed whose only real defect
    // was an unclosed `<language>` came back with EVERY description empty.
    const doc = xml(
      "<language>en<item><title>T</title><link>https://x.example/1</link>" +
        "<description>A teaser with <em>markup</em> inside it</description></item>",
    );
    const repaired = repair(doc);
    expect(repaired).toContain("<em>markup</em> inside it</description>");

    const result = parse(new TextEncoder().encode(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].summaryHtml).toContain("markup");
  });

  it("does not touch a tag whose opens and closes already balance", () => {
    const doc = "<title>One</title><title>Two</title>";
    expect(closeUnclosedTags(doc)).toBe(doc);
  });

  it("closes only as many tags as are actually unclosed", () => {
    // Two opens, one close: exactly one needs repairing, and it is the first.
    const out = closeUnclosedTags("<title>Unclosed <link>x</link><title>Closed</title>");
    expect(out).toBe("<title>Unclosed </title><link>x</link><title>Closed</title>");
  });

  it("never appends a close tag to a self-closing element", () => {
    // THE BUG: `[^>]*` ate the trailing slash, so `<link href="…"/>` became
    // `<link href="…"/></link>` — making an Atom feed that failed the first
    // attempt strictly LESS parseable than before the repair.
    const doc = '<link rel="alternate" href="https://x.example/1"/><title>T';
    const out = closeUnclosedTags(doc);
    expect(out).not.toContain("/></link>");
    expect(out).toContain('<link rel="alternate" href="https://x.example/1"/>');
  });

  it("still repairs a genuinely unclosed Atom link", () => {
    const out = closeUnclosedTags("<link>https://x.example/1<title>T</title>");
    expect(out).toBe("<link>https://x.example/1</link><title>T</title>");
  });

  it("leaves ampersands inside CDATA alone", () => {
    // THE BUG: `Smith & Sons` inside CDATA is already valid. "Repairing" it
    // writes a literal `&amp;` into the article body — visible to the reader
    // and baked into the content hash.
    const doc = "<description><![CDATA[Smith & Sons, est. 1840 — ?x=1&y=2]]></description>";
    expect(escapeBareAmpersands(doc)).toBe(doc);
  });

  it("still escapes a bare ampersand outside CDATA", () => {
    expect(escapeBareAmpersands("<title>Ledger & Lathe</title>")).toBe(
      "<title>Ledger &amp; Lathe</title>",
    );
  });

  it("leaves existing character references untouched", () => {
    const doc = "<title>Already &amp; escaped &#8230; &hellip;</title>";
    expect(escapeBareAmpersands(doc)).toBe(doc);
  });

  it("does not close tags inside a CDATA section", () => {
    const doc = "<description><![CDATA[<title>not markup]]></description>";
    expect(closeUnclosedTags(doc)).toBe(doc);
  });

  it("is a no-op on a well-formed document", () => {
    // The strongest property available: a body that already parses must come
    // out of the repair pass byte-identical.
    const doc = xml(
      "<title>Harbour Wire</title><item><title>T</title>" +
        "<link>https://x.example/1</link><guid>g1</guid></item>",
    );
    expect(repair(doc)).toBe(doc);
  });
});

describe("sanitize runs unconditionally and repair does not", () => {
  it("strips controls without touching structure", () => {
    expect(sanitize("<a>one\u0008two</a>")).toBe("<a>onetwo</a>");
    expect(sanitize("<a>keep\tthis\nand this</a>")).toBe("<a>keep\tthis\nand this</a>");
  });

  it("strips controls even inside CDATA, because XML forbids them there too", () => {
    expect(sanitize("<d><![CDATA[a\u001fb]]></d>")).toBe("<d><![CDATA[ab]]></d>");
  });
});

describe("the article URL comes from the right field", () => {
  it("uses a guid as the URL when isPermaLink is absent", () => {
    // THE BUG: `isPermaLink` DEFAULTS TO TRUE in RSS 2.0, and feedsmith leaves
    // it undefined when the attribute is missing. Testing `=== true` meant the
    // most common form in the wild — `<guid>https://…</guid>` with no `<link>`
    // — produced no URL at all, leaving rung 2 nothing to key on.
    const result = parse(
      new TextEncoder().encode(
        xml("<item><title>T</title><guid>https://x.example/post/1</guid></item>"),
      ),
    );
    expect(result.ok && result.items[0].url).toBe("https://x.example/post/1");
  });

  it("refuses a non-URL guid even when isPermaLink claims true", () => {
    const result = parse(
      new TextEncoder().encode(
        xml('<item><title>T</title><guid isPermaLink="true">tag:x.example,2026:1</guid></item>'),
      ),
    );
    expect(result.ok && result.items[0].url).toBeNull();
    expect(result.ok && result.items[0].guid).toBe("tag:x.example,2026:1");
  });

  it("ignores a guid marked isPermaLink=false", () => {
    const result = parse(
      new TextEncoder().encode(
        xml('<item><title>T</title><guid isPermaLink="false">https://x.example/?p=1</guid></item>'),
      ),
    );
    expect(result.ok && result.items[0].url).toBeNull();
  });

  it("prefers <link> over a permalink guid", () => {
    const result = parse(
      new TextEncoder().encode(
        xml(
          "<item><title>T</title><link>https://x.example/pretty</link>" +
            "<guid>https://x.example/?p=1842</guid></item>",
        ),
      ),
    );
    expect(result.ok && result.items[0].url).toBe("https://x.example/pretty");
  });

  it("never takes an Atom enclosure link as the article URL", () => {
    // THE BUG: falling back to `links[0]` handed a podcast's .mp3 back as the
    // article URL, which then became rung 2's dedupe key.
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>ep-1</id><title>Episode one</title>
        <link rel="enclosure" type="audio/mpeg" href="https://x.example/audio/1.mp3"/>
      </entry></feed>`;
    const result = parse(new TextEncoder().encode(atom));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].url).toBeNull();
    expect(result.items[0].guid).toBe("ep-1");
  });
});

describe("only http and https survive normalisation", () => {
  it.each(["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "file:///etc/passwd"])(
    "drops %s",
    (url) => {
      // Feed content is remote user input and this value ends up in an href.
      // `new URL()` resolves these happily — it is a parser, not a filter — so
      // the refusal has to be explicit and it has to be here, at the boundary,
      // rather than at each place that later renders the value.
      expect(resolveUrl(url, FEED)).toBeNull();
    },
  );

  it("drops a javascript: URL arriving through the full pipeline", () => {
    const result = parse(
      new TextEncoder().encode(
        xml("<item><title>Click me</title><link>javascript:alert(1)</link></item>"),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const normalized = normalize(result.items, FEED);
    // The item survives on its title, which is identity enough for rung 3.
    expect(normalized.items).toHaveLength(1);
    expect(normalized.items[0].url).toBeNull();
  });

  it("keeps http and https", () => {
    expect(resolveUrl("http://x.example/a", FEED)).toBe("http://x.example/a");
    expect(resolveUrl("https://x.example/a", FEED)).toBe("https://x.example/a");
  });
});

describe("sniffing a truncated head", () => {
  it("recognises a JSON Feed from a head too short to JSON.parse", () => {
    // THE BUG: the JSON branch did a full `JSON.parse`, so sniffing the first
    // kilobyte of a 50 KB JSON Feed always threw and returned `unknown` —
    // which the pipeline reports as `unsupported`. Every JSON fixture happened
    // to be under 1 KB, so the corpus could not catch it.
    const whole = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "Long feed",
      items: Array.from({ length: 200 }, (_, i) => ({ id: String(i), title: `Item ${i}` })),
    });
    expect(whole.length).toBeGreaterThan(2000);
    expect(sniffText(whole.slice(0, 1024))).toBe("json");
  });

  it("still refuses JSON that is not a feed, truncated or whole", () => {
    const whole = JSON.stringify({ ok: true, data: Array.from({ length: 300 }, (_, i) => i) });
    expect(sniffText(whole)).toBe("unknown");
    expect(sniffText(whole.slice(0, 200))).toBe("unknown");
  });
});
