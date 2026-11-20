import { describe, expect, it } from "vitest";

import { getViewer } from "@/lib/server/viewer";
import { discoverFeeds } from "@/lib/server/mutations";

import { discoveryKey, looksLikeAddress, resolveSample, sampleAddresses } from "./discover";

/*
 * What this suite is for: the four failure branches going generic.
 *
 * "Something went wrong" is the easy answer and it is useless. A reader who
 * pasted a site with no feed, a site that timed out, a feed they already
 * follow, and a typo need FOUR different next actions:
 *
 *   none        -> this site has no feed; try the site's own address
 *   unreachable -> it may be briefly down; try again
 *   following   -> nothing to do; here is the feed you already have
 *   invalid     -> you did not paste an address at all
 *
 * Collapsing them sends readers looking for a feed that was never the problem.
 */

describe("every sample address lands on its own branch", () => {
  it("offers one address per branch", () => {
    expect(sampleAddresses).toHaveLength(5);
    expect(new Set(sampleAddresses.map((s) => s.address)).size).toBe(5);
  });

  it.each([
    ["tidewaterletters.example", "found"],
    ["quarrylane.example/feed.json", "found"],
    ["harbourwire.example", "following"],
    ["plainpage.example", "none"],
    ["slowhost.example", "unreachable"],
  ])("%s resolves as %s", (address, kind) => {
    expect(resolveSample(address).kind).toBe(kind);
  });

  it("gives each of the five sample addresses a resolvable branch", () => {
    // A sample that fell through to the catch-all would be advertised on the
    // add screen as demonstrating a branch it does not reach.
    for (const { address } of sampleAddresses) {
      const result = resolveSample(address);
      expect(["found", "following", "none", "unreachable"]).toContain(result.kind);
    }
  });
});

describe("the four failures are distinguishable", () => {
  it("gives each failure its own kind, not one shared error", () => {
    const kinds = [
      resolveSample("plainpage.example").kind,
      resolveSample("slowhost.example").kind,
      resolveSample("harbourwire.example").kind,
      resolveSample("not an address").kind,
    ];
    expect(new Set(kinds).size).toBe(4);
  });

  it("carries a reason on every failure that has one to give", () => {
    for (const address of ["plainpage.example", "slowhost.example", "nonsense"]) {
      const result = resolveSample(address);
      if (result.kind === "found" || result.kind === "following")
        throw new Error("expected failure");
      expect(result.reason.length).toBeGreaterThan(10);
    }
  });

  it("points `following` at the feed the reader already has", () => {
    // The only failure with a useful destination, so it must carry the id.
    const result = resolveSample("harbourwire.example");
    expect(result.kind).toBe("following");
    if (result.kind !== "following") return;
    expect(result.feedId).toBe(1);
  });

  it("calls a typo invalid rather than 'no feed found'", () => {
    // "No feed found there" would send the reader hunting for a feed when the
    // real problem is that they did not paste an address.
    expect(resolveSample("hello world").kind).toBe("invalid");
    expect(resolveSample("just-a-word").kind).toBe("invalid");
    expect(resolveSample("").kind).toBe("invalid");
  });

  it("reports an unknown but well-formed address as none, not invalid", () => {
    // It IS an address; there is simply no feed there. That distinction is the
    // difference between "fix your typing" and "this site has no feed".
    expect(resolveSample("some-real-site.example").kind).toBe("none");
  });
});

describe("looksLikeAddress", () => {
  it.each(["example.com", "example.com/feed", "sub.example.co.uk", "https://x.example/a"])(
    "accepts %s",
    (input) => {
      expect(looksLikeAddress(input)).toBe(true);
    },
  );

  it.each(["", "   ", "hello world", "nodot", "-bad.example", "bad-.example", "a b.example"])(
    "rejects %o",
    (input) => {
      expect(looksLikeAddress(input)).toBe(false);
    },
  );
});

describe("discoveryKey", () => {
  it.each([
    ["https://www.Example.com/", "example.com"],
    ["http://example.com/feed/", "example.com/feed"],
    ["  Example.com  ", "example.com"],
    ["example.com", "example.com"],
  ])("maps %o to %o", (input, expected) => {
    expect(discoveryKey(input)).toBe(expected);
  });

  it("returns empty for a non-string, because the value comes from a body", () => {
    for (const bad of [1, null, undefined, {}, []]) {
      expect(discoveryKey(bad)).toBe("");
    }
  });
});

describe("through the service layer", () => {
  it("resolves rather than throwing, because discovery is pure from M5", async () => {
    const viewer = await getViewer();
    const result = await discoverFeeds(viewer, "tidewaterletters.example");
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    // The validated detail is what lets the screen describe a feed before
    // anyone subscribes (§6.3).
    expect(result.candidates[0].format).toBe("atom");
    expect(result.candidates[0].items).toBeGreaterThan(0);
    expect(result.candidates[0].preview).toHaveLength(3);
  });

  it("refuses an anon, because the route needs a session (§3)", async () => {
    await expect(discoverFeeds({ kind: "anon" }, "x.example")).rejects.toThrow();
  });
});
