import { describe, expect, it } from "vitest";

import { isBlockedAddress, guardUrl } from "./guard";

/*
 * What this suite is for: using our own server as a proxy into a network the
 * caller cannot reach.
 *
 * M9 is the first code here that fetches a URL a user typed. The server sits
 * somewhere the user does not, so "fetch this for me" is an invitation. The
 * targets are not exotic — `http://127.0.0.1:5432` is the database, and
 * `http://169.254.169.254/` is the cloud metadata endpoint that hands out
 * credentials on an unprotected instance.
 *
 * Every case here is a real bypass technique rather than a variation on
 * `localhost`, because blocking the obvious spelling is what a first attempt
 * does and it stops nothing.
 */

describe("addresses that must never be fetched", () => {
  it("blocks IPv4 loopback, including spellings that are not 127.0.0.1", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    // The whole /8 is loopback, not just .0.1.
    expect(isBlockedAddress("127.1.2.3")).toBe(true);
    expect(isBlockedAddress("127.255.255.254")).toBe(true);
  });

  it("blocks the cloud metadata endpoint and the rest of link-local", () => {
    // The single most valuable target: on an unprotected instance this returns
    // IAM credentials.
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("169.254.0.1")).toBe(true);
  });

  it("blocks every private IPv4 range", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
    expect(isBlockedAddress("172.31.255.255")).toBe(true);
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
    // Carrier-grade NAT, which is private space a home connection may sit in.
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
  });

  it("blocks the two reserved /24s in 192.0.0.0/16 and NOT the rest of it", () => {
    /*
     * FOUND BY M14'S ETIQUETTE AUDIT, against a real publisher, which is the
     * only way this could have surfaced.
     *
     * The rule was `a === 192 && b === 0` — the whole `/16`, 65 536 addresses,
     * where RFC 6890 reserves exactly two `/24`s. The comment beside it
     * already said "192.0.0/24 and 192.0.2/24", so the code and its own
     * documentation disagreed by a factor of 128.
     *
     * The cost was silent: legitimate public feeds refused as
     * `private_address`, a message no reader could act on. `github.blog`
     * resolves to `192.0.66.2` — Automattic's range — and was unfetchable.
     *
     * Every other address in this file is one somebody thought to write down,
     * which is exactly why none of them covered this. The audit went and asked
     * the internet instead.
     */
    // Still blocked: the two genuinely reserved ranges.
    expect(isBlockedAddress("192.0.0.1")).toBe(true);
    expect(isBlockedAddress("192.0.0.171")).toBe(true);
    expect(isBlockedAddress("192.0.2.1")).toBe(true);
    expect(isBlockedAddress("192.0.2.255")).toBe(true);
    // And 6to4 relay anycast, which lives elsewhere in 192.
    expect(isBlockedAddress("192.88.99.1")).toBe(true);

    /*
     * THE SAME BUG LIVED TWO LINES BELOW, in `198.51/16` and `203.0/16`, and
     * the first fix missed both — the audit hit `192.0.66.2` and nothing
     * pointed at the neighbours. RFC 5737 reserves one `/24` from each.
     */
    expect(isBlockedAddress("198.51.100.1")).toBe(true);
    expect(isBlockedAddress("203.0.113.1")).toBe(true);
    expect(isBlockedAddress("198.51.99.1"), "live public space").toBe(false);
    expect(isBlockedAddress("203.0.100.5"), "live public space").toBe(false);
    // RFC 2544 benchmarking genuinely IS a /15, so this one stays wide.
    expect(isBlockedAddress("198.18.0.1")).toBe(true);
    expect(isBlockedAddress("198.19.255.254")).toBe(true);

    // NOT blocked: ordinary public space that happens to share two octets.
    expect(isBlockedAddress("192.0.66.2"), "github.blog is a real public feed").toBe(false);
    expect(isBlockedAddress("192.0.1.1")).toBe(false);
    expect(isBlockedAddress("192.0.78.9")).toBe(false);
    // The private range next door is untouched by the narrowing.
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
  });

  it("blocks 0.0.0.0, which many stacks treat as 'this host'", () => {
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
    expect(isBlockedAddress("0.1.2.3")).toBe(true);
  });

  it("blocks IPv6 loopback and the unspecified address", () => {
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("::")).toBe(true);
  });

  it("blocks an IPv4 address wearing an IPv6 costume", () => {
    /*
     * The bypass a v4-only check misses entirely. `::ffff:127.0.0.1` reaches
     * loopback, and the hex form is the same address written so it does not
     * look like one.
     */
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("blocks IPv6 link-local and unique-local", () => {
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fd00::1")).toBe(true);
    expect(isBlockedAddress("fc00::1")).toBe(true);
  });

  it("blocks the IPv6 transition ranges that embed an IPv4 address", () => {
    // 6to4 and NAT64 both carry a v4 address inside a v6 one, so a v6 range
    // check that stops at fe80/fc00 lets them through.
    expect(isBlockedAddress("2002:7f00:0001::")).toBe(true);
    expect(isBlockedAddress("64:ff9b::7f00:1")).toBe(true);
  });

  it("blocks NON-CANONICAL spellings of the same blocked addresses", () => {
    /*
     * The bypass that string matching cannot close, and the reason the check
     * parses to bytes instead.
     *
     * Every one of these is valid IPv6 for an address already blocked above,
     * written a different way — and every one was ALLOWED by the first version,
     * which matched on text prefixes like `startsWith("::1")`.
     */
    // ::1 written out in full.
    expect(isBlockedAddress("0:0:0:0:0:0:0:1")).toBe(true);
    // IPv4-mapped 127.0.0.1, uncompressed.
    expect(isBlockedAddress("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    // NAT64 with a leading zero in the first group.
    expect(isBlockedAddress("0064:ff9b::1")).toBe(true);
    // Link-local across the whole /10, not just the fe80 spelling.
    expect(isBlockedAddress("feb0::1")).toBe(true);
    // A zone index is not part of the address.
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
    // Mapped metadata endpoint, uncompressed.
    expect(isBlockedAddress("0:0:0:0:0:ffff:a9fe:a9fe")).toBe(true);
  });

  it("blocks multicast and anything unparseable", () => {
    expect(isBlockedAddress("224.0.0.1")).toBe(true);
    expect(isBlockedAddress("255.255.255.255")).toBe(true);
    expect(isBlockedAddress("ff02::1")).toBe(true);
    // Not an address at all. The function answers "is this safe", and something
    // we cannot read is not.
    expect(isBlockedAddress("not-an-address")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });

  it("ALLOWS ordinary public addresses, so the guard is not simply closed", () => {
    // The negative case. A guard that blocked everything would pass every
    // assertion above and break the product.
    expect(isBlockedAddress("1.1.1.1")).toBe(false);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("guarding a URL before fetching it", () => {
  it("refuses a scheme that is not http or https", async () => {
    // `new URL()` resolves these perfectly happily — it is a parser, not a
    // filter. `file:` would read the server's disk.
    for (const url of [
      "file:///etc/passwd",
      "gopher://example.com/",
      "data:text/plain,hello",
      "ftp://example.com/feed.xml",
      "javascript:alert(1)",
    ]) {
      const result = await guardUrl(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.reason).toBe("scheme_not_allowed");
    }
  });

  it("refuses a literal private address without needing DNS", async () => {
    for (const url of [
      "http://127.0.0.1/feed.xml",
      "http://127.0.0.1:5432/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/feed.xml",
      "http://10.0.0.5/feed",
      "http://[::ffff:127.0.0.1]/feed",
    ]) {
      const result = await guardUrl(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.reason).toBe("private_address");
    }
  });

  it("refuses credentials embedded in the URL", async () => {
    // Two reasons: it would forward a reader's pasted password to the host, and
    // `https://trusted.example@evil.example/` reads as one host and resolves
    // another.
    const result = await guardUrl("https://user:pass@example.com/feed.xml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("credentials_in_url");
  });

  it("refuses a port that is not a plausible feed port", async () => {
    // Not the primary control — the address check is — but it stops the
    // fetcher being used to scan ports on hosts that ARE public.
    const result = await guardUrl("http://example.com:22/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("port_not_allowed");
  });

  it("refuses a URL that does not parse", async () => {
    const result = await guardUrl("not a url at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_url");
  });

  it("refuses a hostname that does not resolve", async () => {
    // `.invalid` is reserved by RFC 2606 precisely so it never resolves, which
    // makes this deterministic without a network.
    const result = await guardUrl("https://nothing-here.invalid/feed.xml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("dns_failed");
  });

  it("ALLOWS a public https URL on a default port", async () => {
    // The negative case again, and it does hit DNS — so it is the one case here
    // that needs the network. `example.com` is reserved for this (RFC 2606).
    const result = await guardUrl("https://example.com/feed.xml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.addresses.length).toBeGreaterThan(0);
      expect(result.addresses.every((a) => !isBlockedAddress(a))).toBe(true);
    }
  });
});
