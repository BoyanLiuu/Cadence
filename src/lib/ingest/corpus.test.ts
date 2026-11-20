import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { corpus, type Fixture } from "../../../test/fixtures/feeds/manifest";
import { parse } from "./parse";

/*
 * What this suite is for: the parse failure that would take a whole poll down.
 *
 * Every one of the 30 bodies either parses to `RawItem[]` or returns a TYPED
 * rejection, and none throws. That property is what lets `POST /api/cron/poll`
 * claim 25 feeds in a batch — one publisher's bad deploy must cost its own feed
 * and nothing else (§4).
 */

const DIR = join(__dirname, "../../../test/fixtures/feeds");
export const read = (f: Fixture) => new Uint8Array(readFileSync(join(DIR, f.file)));

describe("the hazard corpus", () => {
  it("has a fixture for every hazard, and no duplicates", () => {
    // The plan calls for 30. The corpus grows when a review finds a hazard
    // nothing covered — 31 is the entry-level `xml:base` case. A floor rather
    // than an exact count, so adding a hazard does not fail the suite, while
    // losing one still does.
    expect(corpus.length).toBeGreaterThanOrEqual(30);
    expect(new Set(corpus.map((f) => f.file)).size).toBe(corpus.length);
  });

  it.each(corpus)("$file never throws — $hazard", (fixture) => {
    expect(() => parse(read(fixture), fixture.contentType)).not.toThrow();
  });

  it.each(corpus)("$file matches its recorded expectation", (fixture) => {
    const result = parse(read(fixture), fixture.contentType);

    if (fixture.expect.outcome === "ok") {
      // A failure here prints the reason, which is what makes the diff legible
      // when a library upgrade changes behaviour.
      expect(result.ok ? "ok" : `${result.reason}: ${result.detail}`).toBe("ok");
      if (!result.ok) return;
      expect(result.dialect).toBe(fixture.expect.dialect);
      expect(result.items).toHaveLength(fixture.expect.items);
    } else if (fixture.expect.outcome === "not_a_feed") {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("not_a_feed");
    } else {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(fixture.expect.reason);
    }
  });

  it("repairs exactly the bodies recorded as needing it", () => {
    // Catches a pre-clean that has quietly become load-bearing for a body that
    // used to parse cleanly — which would mean the parser regressed.
    for (const fixture of corpus) {
      const result = parse(read(fixture), fixture.contentType);
      if (!result.ok) continue;
      expect(result.repaired, `${fixture.file} repaired`).toBe(Boolean(fixture.needsRepair));
    }
  });

  it("parses a 500-item feed without special-casing it", () => {
    // The insert cap (N7) is applied downstream at M7. Parsing must not be
    // where the limit lives, or the cap could never be measured.
    const big = corpus.find((f) => f.file === "14-five-hundred-items.xml")!;
    const result = parse(read(big));
    expect(result.ok && result.items).toHaveLength(500);
  });

  it("treats a feed with zero items as a success, not an error", () => {
    const empty = corpus.find((f) => f.file === "15-zero-items.xml")!;
    const result = parse(read(empty));
    expect(result.ok).toBe(true);
    expect(result.ok && result.items).toEqual([]);
  });
});
