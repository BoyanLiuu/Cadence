import { describe, expect, it } from "vitest";

import { articleUrlHash } from "./dedupe";
import { canonicalUrl, TRACKING_PARAM_PREFIXES, TRACKING_PARAMS } from "./canonical-url";

/*
 * What this suite is for: the bug that writes a PERMANENT duplicate.
 *
 * Both directions are fatal and neither is reportable:
 *   - collapse two articles and the second is never shown to anyone;
 *   - split one article and the sidebar says unread for something already read.
 *
 * So every rule gets a before/after pair, and the negative cases — URLs that
 * must NOT collapse — get as much weight as the positive ones. §6.1 is the
 * specification; the worked example at its end is reproduced verbatim below.
 */

const K = "simonwillison.net/2026/Nov/18/daniel-stenberg";

describe("the six real-world variants from §6.1 collapse to two keys", () => {
  // This is the architecture's own worked example, and it is the single best
  // summary of what this function is for: five spellings of one article, plus
  // one that differs by a single path character and must stay separate.
  it.each([
    ["https://simonwillison.net/2026/Nov/18/daniel-stenberg/", K],
    ["http://simonwillison.net/2026/Nov/18/daniel-stenberg", K],
    ["https://www.simonwillison.net/2026/Nov/18/daniel-stenberg", K],
    ["https://simonwillison.net/2026/Nov/18/daniel-stenberg?utm_source=rss&utm_medium=feed", K],
    ["https://simonwillison.net/2026/Nov/18/daniel-stenberg#comments", K],
    [
      "https://simonwillison.net/2026/Nov/19/daniel-stenberg",
      "simonwillison.net/2026/Nov/19/daniel-stenberg",
    ],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected);
  });

  it("yields exactly two distinct keys across all six", () => {
    const keys = new Set(
      [
        "https://simonwillison.net/2026/Nov/18/daniel-stenberg/",
        "http://simonwillison.net/2026/Nov/18/daniel-stenberg",
        "https://www.simonwillison.net/2026/Nov/18/daniel-stenberg",
        "https://simonwillison.net/2026/Nov/18/daniel-stenberg?utm_source=rss&utm_medium=feed",
        "https://simonwillison.net/2026/Nov/18/daniel-stenberg#comments",
        "https://simonwillison.net/2026/Nov/19/daniel-stenberg",
      ].map(canonicalUrl),
    );
    expect(keys.size).toBe(2);
  });
});

describe("the scheme is dropped, never rewritten", () => {
  it("makes http and https the same key", () => {
    // §6.1 singles this out as the rule most easily got wrong. Rewriting
    // http->https looks tidier but is not equivalent: a publisher's TLS
    // migration would leave their pre-TLS archive keyed one way and their new
    // feed keyed another, re-publishing years of articles as new.
    expect(canonicalUrl("http://x.example/a")).toBe(canonicalUrl("https://x.example/a"));
  });

  it("leaves no scheme in the key at all", () => {
    expect(canonicalUrl("https://x.example/a")).toBe("x.example/a");
    expect(canonicalUrl("https://x.example/a")).not.toContain("http");
  });

  it("refuses a scheme a reader cannot open", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://x.example/a",
    ]) {
      expect(canonicalUrl(url)).toBeNull();
    }
  });
});

describe("host rules", () => {
  it.each([
    ["https://X.EXAMPLE/a", "x.example/a"],
    ["https://www.x.example/a", "x.example/a"],
    ["https://WWW.X.Example/a", "x.example/a"],
    // Only a LEADING www. — `www.co` as a second label is part of the name.
    ["https://x.www.example/a", "x.www.example/a"],
    // A host that merely starts with the letters www is not a www. prefix.
    ["https://wwwx.example/a", "wwwx.example/a"],
    ["https://x.example:443/a", "x.example/a"],
    ["https://x.example:8443/a", "x.example:8443/a"],
    ["http://x.example:80/a", "x.example/a"],
    ["http://x.example:8080/a", "x.example:8080/a"],
    // Userinfo identifies a requester, never a document.
    ["https://user:pw@x.example/a", "x.example/a"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected);
  });

  it("keeps a non-default port, because it is a different server", () => {
    expect(canonicalUrl("https://x.example:8443/a")).not.toBe(canonicalUrl("https://x.example/a"));
  });

  it("strips the root dot of a fully-qualified name", () => {
    // `x.example.` and `x.example` are the same server to every resolver; the
    // trailing dot is syntax, not identity.
    expect(canonicalUrl("https://x.example./a")).toBe("x.example/a");
    expect(canonicalUrl("https://x.example./a")).toBe(canonicalUrl("https://x.example/a"));
  });
});

describe("path rules", () => {
  it.each([
    ["https://x.example/a/", "x.example/a"],
    ["https://x.example/a//", "x.example/a"],
    ["https://x.example/", "x.example"],
    ["https://x.example", "x.example"],
    ["https://x.example/a/b/", "x.example/a/b"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected);
  });

  it("PRESERVES path case, because a path is case-sensitive", () => {
    // The host is case-insensitive by specification; a path is not. Most
    // servers serve different documents for /Nov/ and /nov/, and collapsing
    // them is the "too loose" failure — one article silently never shown.
    expect(canonicalUrl("https://x.example/Nov/18")).toBe("x.example/Nov/18");
    expect(canonicalUrl("https://x.example/Nov/18")).not.toBe(
      canonicalUrl("https://x.example/nov/18"),
    );
  });

  it("does not collapse two paths differing by one character", () => {
    expect(canonicalUrl("https://x.example/post/18")).not.toBe(
      canonicalUrl("https://x.example/post/19"),
    );
    expect(canonicalUrl("https://x.example/post-a")).not.toBe(
      canonicalUrl("https://x.example/post-b"),
    );
    expect(canonicalUrl("https://x.example/a/b")).not.toBe(canonicalUrl("https://x.example/a-b"));
  });

  it("treats a missing and an empty path as the same key", () => {
    expect(canonicalUrl("https://x.example")).toBe(canonicalUrl("https://x.example/"));
  });
});

describe("fragment rules", () => {
  it.each([
    ["https://x.example/a#comments", "x.example/a"],
    ["https://x.example/a#", "x.example/a"],
    ["https://x.example/a/#section-2", "x.example/a"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected);
  });

  it("makes two fragments of one document the same key", () => {
    // A fragment is a position WITHIN a document. Keying on it would give one
    // article as many rows as it has headings.
    expect(canonicalUrl("https://x.example/a#one")).toBe(canonicalUrl("https://x.example/a#two"));
  });

  it("KEEPS the fragment when there is nothing else to key on", () => {
    // A client-routed site puts the whole address in the fragment. Dropping it
    // unconditionally keyed every item of such a feed as `site.example`, and
    // with UNIQUE(url_hash) as rung 2 that means only the FIRST item is ever
    // stored and the rest of the feed is discarded forever — the "too loose"
    // failure at its worst, because nobody reports articles they never saw.
    const one = canonicalUrl("https://site.example/#!/2026/11/one");
    const two = canonicalUrl("https://site.example/#!/2026/11/two");
    const home = canonicalUrl("https://site.example/");

    expect(one).not.toBe(two);
    expect(one).not.toBe(home);
    expect(one).toBe("site.example#!/2026/11/one");
  });

  it("still drops the fragment as soon as the path carries identity", () => {
    // The exception must not leak into normal URLs: an article with a path has
    // identity already, so `#comments` goes, exactly as §6.1 specifies.
    expect(canonicalUrl("https://x.example/a#comments")).toBe("x.example/a");
    expect(canonicalUrl("https://x.example/?p=1#comments")).toBe("x.example?p=1");
  });
});

describe("tracking parameters", () => {
  it.each(TRACKING_PARAMS.map((p) => [p] as const))("deletes %s", (param) => {
    // One case per name in the deny list, so adding a name without a test, or
    // mistyping one, is caught.
    expect(canonicalUrl(`https://x.example/a?${param}=zzz`)).toBe("x.example/a");
  });

  it.each(TRACKING_PARAM_PREFIXES.map((p) => [p] as const))(
    "deletes anything starting %s",
    (prefix) => {
      expect(canonicalUrl(`https://x.example/a?${prefix}source=rss`)).toBe("x.example/a");
      expect(canonicalUrl(`https://x.example/a?${prefix}anything_at_all=1`)).toBe("x.example/a");
    },
  );

  it("deletes them case-insensitively", () => {
    // The same tag appears as utm_source and UTM_SOURCE in the wild, and a
    // case difference is never a different article.
    expect(canonicalUrl("https://x.example/a?UTM_SOURCE=rss")).toBe("x.example/a");
    expect(canonicalUrl("https://x.example/a?FBCLID=zzz")).toBe("x.example/a");
    expect(canonicalUrl("https://x.example/a?CMP=rss")).toBe("x.example/a");
  });

  it("deletes several at once and keeps the rest", () => {
    expect(canonicalUrl("https://x.example/a?utm_source=rss&id=42&fbclid=zz&page=2&gclid=yy")).toBe(
      "x.example/a?id=42&page=2",
    );
  });

  it("keeps a parameter that merely resembles a tracking one", () => {
    // `reference` is not `ref`, and `sourceId` is not `source`. An over-eager
    // prefix match here is the "too loose" failure.
    expect(canonicalUrl("https://x.example/a?reference=9")).toBe("x.example/a?reference=9");
    expect(canonicalUrl("https://x.example/a?sourceId=9")).toBe("x.example/a?sourceId=9");
    expect(canonicalUrl("https://x.example/a?partnership=9")).toBe("x.example/a?partnership=9");
  });

  it("keeps a parameter that selects the document", () => {
    // The whole point of the deny list being a LIST: `?p=1842` and `?id=42`
    // are which article, not how you arrived.
    expect(canonicalUrl("https://x.example/?p=1842")).toBe("x.example?p=1842");
    expect(canonicalUrl("https://x.example/story?id=42")).toBe("x.example/story?id=42");
  });
});

describe("query rules", () => {
  it("sorts surviving parameters, so reordering is not a new article", () => {
    expect(canonicalUrl("https://x.example/a?b=2&a=1")).toBe("x.example/a?a=1&b=2");
    expect(canonicalUrl("https://x.example/a?b=2&a=1")).toBe(
      canonicalUrl("https://x.example/a?a=1&b=2"),
    );
  });

  it("sorts repeated names by value, deterministically", () => {
    expect(canonicalUrl("https://x.example/a?t=b&t=a")).toBe("x.example/a?t=a&t=b");
    expect(canonicalUrl("https://x.example/a?t=b&t=a")).toBe(
      canonicalUrl("https://x.example/a?t=a&t=b"),
    );
  });

  it("drops an empty query entirely", () => {
    expect(canonicalUrl("https://x.example/a?")).toBe("x.example/a");
    expect(canonicalUrl("https://x.example/a?utm_source=rss")).toBe("x.example/a");
  });

  it("keeps a valueless parameter", () => {
    expect(canonicalUrl("https://x.example/a?draft")).toBe("x.example/a?draft");
  });

  it("does not collapse different values of the same parameter", () => {
    expect(canonicalUrl("https://x.example/a?id=1")).not.toBe(
      canonicalUrl("https://x.example/a?id=2"),
    );
  });
});

describe("percent-encoding", () => {
  it.each([
    // Needlessly-escaped unreserved characters are decoded.
    ["https://x.example/%7Euser", "x.example/~user"],
    ["https://x.example/%41%42", "x.example/AB"],
    ["https://x.example/a%2Db", "x.example/a-b"],
    // Escapes that must stay keep their escape, with upper-case hex.
    ["https://x.example/a%2fb", "x.example/a%2Fb"],
    ["https://x.example/a%20b", "x.example/a%20b"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected);
  });

  it("makes two spellings of one escape agree", () => {
    // A publisher changing URL generator must not re-publish their archive —
    // the same failure mode as rewriting the scheme.
    expect(canonicalUrl("https://x.example/a%2fb")).toBe(canonicalUrl("https://x.example/a%2Fb"));
    expect(canonicalUrl("https://x.example/%7Euser")).toBe(canonicalUrl("https://x.example/~user"));
  });

  it("does not decode an escape that would change the path's shape", () => {
    // `%2F` is an encoded slash and is NOT a path separator. Decoding it would
    // merge `/a%2Fb` with `/a/b`, which are different documents.
    expect(canonicalUrl("https://x.example/a%2Fb")).not.toBe(canonicalUrl("https://x.example/a/b"));
  });

  it("leaves a malformed escape alone rather than guessing", () => {
    expect(canonicalUrl("https://x.example/a%zzb")).toBe("x.example/a%zzb");
  });

  it("does not collapse an encoded separator with a real one", () => {
    // `?p=b%26q%3Dc` is ONE parameter whose value contains `&q=c`.
    // `?p=b&q=c` is TWO parameters. Reading the query through
    // `url.searchParams` percent-DECODES, so re-emitting the decoded pairs
    // made these two different addresses produce one url_hash — and one
    // article is then silently never shown.
    expect(canonicalUrl("https://x.example/a?p=b%26q%3Dc")).not.toBe(
      canonicalUrl("https://x.example/a?p=b&q=c"),
    );
  });

  it("does not decode an escape twice", () => {
    // `%2541` is a literal `%41`, not an `A`. Decoding through searchParams
    // and then normalising escapes decoded it twice.
    expect(canonicalUrl("https://x.example/a?p=%2541")).not.toBe(
      canonicalUrl("https://x.example/a?p=A"),
    );
  });

  it("still recognises a tracking tag whose NAME is encoded", () => {
    // The deny list matches the decoded name, so this is still deleted.
    expect(canonicalUrl("https://x.example/a?utm%5Fsource=rss")).toBe("x.example/a");
  });

  it("treats + and %20 in the query as the same space", () => {
    // In a query string `+` IS a space, so these are one request. Leaving them
    // unreconciled contradicted the module's own "two spellings agree" goal.
    expect(canonicalUrl("https://x.example/a?q=hello+world")).toBe(
      canonicalUrl("https://x.example/a?q=hello%20world"),
    );
  });

  it("does not treat + in the PATH as a space", () => {
    // A path is not form-encoded, so `+` there is a literal plus.
    expect(canonicalUrl("https://x.example/a+b")).toBe("x.example/a+b");
  });
});

describe("inputs that cannot be keyed", () => {
  it.each([null, undefined, "", "   ", "not a url", "/relative/path", "//protocol-relative/x"])(
    "returns null for %s",
    (input) => {
      expect(canonicalUrl(input as string | null | undefined)).toBeNull();
    },
  );

  it("returns null rather than throwing on anything", () => {
    for (const input of ["http://", "https://", "http://[bad", "::::"]) {
      expect(() => canonicalUrl(input)).not.toThrow();
      expect(canonicalUrl(input)).toBeNull();
    }
  });
});

describe("determinism", () => {
  it("gives the same answer every time", () => {
    // M7 reruns this on every poll. A difference between runs is a duplicate.
    const url = "https://WWW.X.example:443/A/b/?z=1&utm_source=rss&a=2#frag";
    const once = canonicalUrl(url);
    for (let i = 0; i < 50; i += 1) expect(canonicalUrl(url)).toBe(once);
  });

  it("is idempotent in the sense that matters: equal inputs, equal keys", () => {
    const variants = [
      "https://www.x.example/a/?utm_medium=feed#top",
      "http://x.example/a?fbclid=1",
      "https://X.Example:443/a/",
    ];
    expect(new Set(variants.map(canonicalUrl)).size).toBe(1);
  });
});

describe("rung 2's article key", () => {
  /*
   * `articleUrlHash` was extracted at M13 so extraction's append to
   * `article_urls` and ingestion's own lookup share ONE definition of the
   * composition — the alternative was hand-copying `canonicalUrl` then
   * `contentHash` then the byte narrowing into a second file, which is the
   * same shape as the seed computing `content_hash` its own way and
   * disagreeing with the poller on 15 of 124 articles.
   */

  it("is stable, and agrees across equivalent addresses", () => {
    const a = articleUrlHash("https://x.example/post/a/");
    const b = articleUrlHash("http://www.x.example/post/a?utm_source=rss");

    expect(a).not.toBeNull();
    // The whole point of keying on the canonical form rather than the string.
    expect(Buffer.from(a!).toString("hex")).toBe(Buffer.from(b!).toString("hex"));
  });

  it("TAKES A RAW ADDRESS, and returns null for an already-canonical key", () => {
    /*
     * THE TRAP, pinned because I walked into it. The helper canonicalises what
     * it is given, so passing it `canonicalUrl(url)` canonicalises twice — and
     * a canonical key has no scheme, so the second pass fails and returns
     * null. Inside `keysFor` that null went through a non-null assertion and
     * reached `Buffer.from`, failing 57 tests across the ladder.
     *
     * Null rather than throwing is correct: an address that cannot be keyed is
     * a real case (§6.3 — an item with no link at all), and the callers handle
     * it. What is not safe is asserting non-null over it.
     */
    const raw = "https://x.example/post/a";
    const key = canonicalUrl(raw);

    expect(key).not.toBeNull();
    expect(articleUrlHash(raw)).not.toBeNull();
    expect(articleUrlHash(key), "a canonical key is not a valid input").toBeNull();
  });

  it("is null for an address with no key, rather than inventing one", () => {
    for (const bad of ["", "   ", "not a url", null, undefined]) {
      expect(articleUrlHash(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
