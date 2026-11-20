import { describe, expect, it } from "vitest";

import { canonicalUrl } from "./canonical-url";
import { joinSetAside, redlineUrl } from "./url-redline";

/*
 * What this suite is for: the arrivals proof disagreeing with the rules it
 * illustrates.
 *
 * This panel is the design's signature AND the screen a reader opens when they
 * doubt the unread count. If the redlines describe rules the canonicaliser no
 * longer has, the one place the product explains itself is confidently wrong —
 * which is worse than not explaining at all.
 *
 * So the binding property, asserted below, is that reading only the KEPT runs
 * yields the same key `canonicalUrl` produces.
 */

/** The address as it reads with the struck runs removed. */
const keptText = (url: string) =>
  redlineUrl(url)
    .parts.filter((p) => p.kept)
    .map((p) => p.text)
    .join("");

describe("the redline agrees with canonicalUrl", () => {
  it.each([
    "https://harbourwire.example/2026/11/12/tidal-barrier-vote",
    "http://www.harbourwire.example/2026/11/12/tidal-barrier-vote/?utm_source=lowland&utm_medium=rss",
    "https://harbourwire.example/2026/11/12/tidal-barrier-vote?ref=northgate#top",
    "https://x.example/a?id=42",
    "https://x.example/a?utm_source=rss&id=42&fbclid=zz",
    "https://x.example./a/",
    "https://user:pw@x.example:8443/a",
  ])("reading only the kept runs of %s gives the key", (url) => {
    expect(keptText(url)).toBe(canonicalUrl(url));
  });

  it("reports the same key canonicalUrl does", () => {
    const url = "http://www.x.example/a/?utm_source=rss#top";
    expect(redlineUrl(url).key).toBe(canonicalUrl(url));
  });
});

describe("query separators read as a URL in both directions", () => {
  it("keeps the positional separator across a run of struck tags", () => {
    // The prototype's own case: all tracking, so the struck run must read as
    // the `?a=1&b=2` the publisher actually sent, not `?a=1?b=2`.
    const { parts } = redlineUrl("https://x.example/a?utm_source=lowland&utm_medium=rss");
    const struck = parts.filter((p) => !p.kept).map((p) => p.text);
    expect(struck).toContain("?utm_source=lowland");
    expect(struck).toContain("&utm_medium=rss");
  });

  it("gives the first SURVIVING parameter the question mark", () => {
    // The mirror case, and the bug the first fix missed: when the first
    // parameter is tracking, the `?` was struck with it and the kept remainder
    // rendered as `x.example/a&id=5` — not a URL anyone has seen.
    expect(keptText("https://x.example/a?ref=northgate&id=5")).toBe("x.example/a?id=5");
  });

  it("handles tracking interleaved with survivors", () => {
    expect(keptText("https://x.example/a?utm_source=rss&id=42&fbclid=z&page=2")).toBe(
      "x.example/a?id=42&page=2",
    );
  });
});

describe("what it tells the reader was set aside", () => {
  it("names the scheme, www., the trailing slash and each tag", () => {
    const { setAside } = redlineUrl(
      "http://www.harbourwire.example/a/?utm_source=lowland&utm_medium=rss",
    );
    expect(setAside).toEqual([
      "the scheme",
      "www.",
      "the trailing slash",
      "utm_source",
      "utm_medium",
    ]);
  });

  it("names the fragment when it is dropped", () => {
    expect(redlineUrl("https://x.example/a#top").setAside).toContain("the fragment");
  });

  it("does NOT claim the fragment was set aside when it is the key", () => {
    // A client-routed address keeps its fragment (see canonical-url.ts), so
    // saying it was dropped would contradict the key printed beside it.
    const { setAside, key } = redlineUrl("https://site.example/#!/2026/11/one");
    expect(key).toBe("site.example#!/2026/11/one");
    expect(setAside).not.toContain("the fragment");
  });

  it("names the root dot and the sign-in", () => {
    expect(redlineUrl("https://x.example./a").setAside).toContain("the root dot");
    expect(redlineUrl("https://user:pw@x.example/a").setAside).toContain("the sign-in");
  });

  it("returns an unkeyable address whole rather than half-struck", () => {
    const { parts, key } = redlineUrl("not a url");
    expect(key).toBeNull();
    expect(parts).toEqual([{ text: "not a url", kept: true }]);
  });
});

describe("joinSetAside", () => {
  it.each([
    [[], ""],
    [["the scheme"], "the scheme"],
    [["the scheme", "www."], "the scheme and www."],
    [["the scheme", "www.", "ref"], "the scheme, www. and ref"],
  ])("joins %o as %o", (items, expected) => {
    expect(joinSetAside(items)).toBe(expected);
  });
});
