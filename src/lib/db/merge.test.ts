import { describe, expect, it } from "vitest";

import { canonicalUrl } from "@/lib/ingest/canonical-url";
import { NotImplementedInStaticPhase } from "@/lib/server/mutations";

import { applyMergePlan, planMerges, type MergeCandidate } from "./merge";

/*
 * What this suite is for: the migration that makes duplicates while removing
 * them.
 *
 * A `NORM_VERSION` bump turns previously-distinct rows into equal ones, so it
 * cannot be a plain re-hash — the UNIQUE index on `url_hash` rejects the
 * second row. The dangerous part is not the SQL, it is the GROUPING and the
 * STATE UNION, and both are pure. Testing them now means the logic is already
 * proven when the bump happens, rather than being written against a live table
 * during an incident (§6.1).
 */

const row = (
  id: number,
  url: string,
  currentUrlHash: string,
  userState: MergeCandidate["userState"] = [],
  knownUrls: string[] = [],
) => ({
  candidate: { id, url, knownUrls, userState },
  currentUrlHash,
});

/** The real v2 rule, for the realistic cases: a new tracking tag is added. */
const v2 = (url: string) => {
  const key = canonicalUrl(url);
  return key === null ? null : key.replace(/[?&]si=[^&]*/, "");
};

describe("grouping", () => {
  it("collapses rows the new ruleset makes equal", () => {
    // The worked example from merge.ts's header: `?si=` becomes a tracking tag
    // in v2, so these two rows are one article under the new rules.
    const plan = planMerges(
      [
        row(412, "https://site.example/post/a", "v1-a"),
        row(907, "https://site.example/post/a?si=xyz", "v1-b"),
      ],
      v2,
    );

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].keepId).toBe(412);
    expect(plan.groups[0].dropIds).toEqual([907]);
  });

  it("keeps the OLDEST id, whatever order the rows arrive in", () => {
    // The oldest row is the one readers have already read and saved, and whose
    // id is already in their history — so it is the choice that breaks the
    // fewest things outside this table.
    const rows = [
      row(907, "https://site.example/post/a?si=1", "h1"),
      row(412, "https://site.example/post/a", "h2"),
      row(655, "https://site.example/post/a?si=2", "h3"),
    ];
    expect(planMerges(rows, v2).groups[0].keepId).toBe(412);
    expect(planMerges([...rows].reverse(), v2).groups[0].keepId).toBe(412);
    expect(planMerges(rows, v2).groups[0].dropIds.sort()).toEqual([655, 907]);
  });

  it("does not group rows that stay distinct", () => {
    const plan = planMerges(
      [row(1, "https://site.example/post/a", "ha"), row(2, "https://site.example/post/b", "hb")],
      v2,
    );
    expect(plan.groups).toHaveLength(0);
  });

  it("separates a row whose hash merely changed from one that collides", () => {
    // A changed key with no collision is a plain UPDATE, not a merge. Treating
    // it as a merge would delete a row for no reason.
    const plan = planMerges(
      [
        row(1, "https://site.example/post/a?si=1", "old-hash"),
        row(2, "https://site.example/post/b", "site.example/post/b"),
      ],
      v2,
    );
    expect(plan.groups).toHaveLength(0);
    expect(plan.rehashOnly).toEqual([{ id: 1, urlHash: "site.example/post/a" }]);
    expect(plan.unchanged).toBe(1);
  });

  it("leaves a row the new ruleset cannot key at all", () => {
    // Dropping it would lose an article a reader may have saved.
    const plan = planMerges([row(1, "not a url", "stale")], () => null);
    expect(plan.groups).toHaveLength(0);
    expect(plan.rehashOnly).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it("detects a collision with a row the new ruleset cannot key", () => {
    // An unkeyable row still OCCUPIES its url_hash in the table. Setting it
    // aside instead of bucketing it meant a plan could target that same hash
    // and violate the UNIQUE index mid-migration, after earlier groups had
    // already been merged. Bucketing makes it a group at planning time.
    const plan = planMerges(
      [
        row(1, "cannot be keyed", "site.example/a"),
        row(2, "https://site.example/a", "something-else"),
      ],
      (url) => (url === "cannot be keyed" ? null : "site.example/a"),
    );
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].urlHash).toBe("site.example/a");
    expect(plan.groups[0].keepId).toBe(1);
    expect(plan.groups[0].dropIds).toEqual([2]);
  });

  it("handles a three-way collapse", () => {
    const plan = planMerges(
      [
        row(10, "https://site.example/a", "h1"),
        row(11, "https://site.example/a?si=x", "h2"),
        row(12, "https://site.example/a?si=y", "h3"),
      ],
      v2,
    );
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].dropIds).toEqual([11, 12]);
  });

  it("is deterministic in its output order", () => {
    // A plan is reviewed by a human before it runs, and diffed between runs.
    const rows = [
      row(5, "https://site.example/b?si=1", "h"),
      row(4, "https://site.example/b", "h"),
      row(2, "https://site.example/a?si=1", "h"),
      row(1, "https://site.example/a", "h"),
    ];
    expect(planMerges(rows, v2)).toEqual(planMerges([...rows].reverse(), v2));
    expect(planMerges(rows, v2).groups.map((g) => g.keepId)).toEqual([1, 4]);
  });
});

describe("the per-user state union", () => {
  it("carries read state from a losing row onto the winner", () => {
    // THE failure this exists to prevent: an article the reader finished comes
    // back unread because the row carrying their read state was deleted.
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", []),
        row(2, "https://site.example/a?si=x", "h2", [
          { userId: "u1", readAt: "2026-11-01T00:00:00Z", savedAt: null },
        ]),
      ],
      v2,
    );
    expect(plan.groups[0].userState).toEqual([
      { userId: "u1", readAt: "2026-11-01T00:00:00Z", savedAt: null },
    ]);
  });

  it("unions two different readers across two rows", () => {
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", [
          { userId: "u1", readAt: "2026-11-01T00:00:00Z", savedAt: null },
        ]),
        row(2, "https://site.example/a?si=x", "h2", [
          { userId: "u2", readAt: null, savedAt: "2026-11-02T00:00:00Z" },
        ]),
      ],
      v2,
    );
    expect(plan.groups[0].userState).toEqual([
      { userId: "u1", readAt: "2026-11-01T00:00:00Z", savedAt: null },
      { userId: "u2", readAt: null, savedAt: "2026-11-02T00:00:00Z" },
    ]);
  });

  it("takes the EARLIEST timestamp when one reader has state on both rows", () => {
    // Earliest, not latest: the merge may only ever ADD read state. Taking the
    // later value would move a read forward in time; taking null would un-read
    // it, and an unread count that lies is what §6.1 says loses readers.
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", [
          { userId: "u1", readAt: "2026-11-05T00:00:00Z", savedAt: null },
        ]),
        row(2, "https://site.example/a?si=x", "h2", [
          { userId: "u1", readAt: "2026-11-01T00:00:00Z", savedAt: "2026-11-03T00:00:00Z" },
        ]),
      ],
      v2,
    );
    expect(plan.groups[0].userState).toEqual([
      { userId: "u1", readAt: "2026-11-01T00:00:00Z", savedAt: "2026-11-03T00:00:00Z" },
    ]);
  });

  it("compares timestamps as instants, not as strings", () => {
    // `+02:00` sorts after `Z` as text while being the EARLIER instant. A
    // lexicographic compare picks the later read time, which moves a read
    // forward and breaks the only guarantee here: a merge may only add read
    // state, never move or remove it.
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", [
          { userId: "u1", readAt: "2026-11-01T01:00:00Z", savedAt: null },
        ]),
        row(2, "https://site.example/a?si=x", "h2", [
          { userId: "u1", readAt: "2026-11-01T02:00:00+02:00", savedAt: null },
        ]),
      ],
      v2,
    );
    // 02:00+02:00 is 00:00Z — an hour BEFORE 01:00Z.
    expect(plan.groups[0].userState[0].readAt).toBe("2026-11-01T02:00:00+02:00");
  });

  it("never turns a read row back into an unread one", () => {
    // A null on one side must not win over a timestamp on the other.
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", [{ userId: "u1", readAt: null, savedAt: null }]),
        row(2, "https://site.example/a?si=x", "h2", [
          { userId: "u1", readAt: "2026-11-01T00:00:00Z", savedAt: null },
        ]),
      ],
      v2,
    );
    expect(plan.groups[0].userState[0].readAt).toBe("2026-11-01T00:00:00Z");
  });

  it("keeps a saved flag from either side", () => {
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", [
          { userId: "u1", readAt: "2026-11-01T00:00:00Z", savedAt: null },
        ]),
        row(2, "https://site.example/a?si=x", "h2", [
          { userId: "u1", readAt: null, savedAt: "2026-11-04T00:00:00Z" },
        ]),
      ],
      v2,
    );
    expect(plan.groups[0].userState[0]).toEqual({
      userId: "u1",
      readAt: "2026-11-01T00:00:00Z",
      savedAt: "2026-11-04T00:00:00Z",
    });
  });
});

describe("address carry-over", () => {
  it("moves every known address onto the winner", () => {
    // This is why `article_urls` is one-to-many. Without it the loser's
    // address resolves to nothing and the next poll re-inserts it as new — so
    // a migration meant to REMOVE duplicates would manufacture them.
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", [], ["https://site.example/old-a"]),
        row(2, "https://site.example/a?si=x", "h2", [], ["https://site.example/a?si=x"]),
      ],
      v2,
    );
    expect(plan.groups[0].urlHashes).toEqual([
      // both members' current hashes...
      "h1",
      "h2",
      // ...the new key...
      "site.example/a",
      // ...and each alternate address REPLAYED under the new ruleset, which
      // is why `?si=x` is gone from the second one.
      "site.example/old-a",
    ]);
  });

  it("REPLAYS alternate addresses through the new ruleset", () => {
    // `knownUrls` holds addresses, not hashes, and that distinction is
    // load-bearing: a v1 digest cannot be re-derived, so carrying old hashes
    // forward leaves them dead — ingestion looks up v2 hashes after the bump
    // and never matches a v1 one. The alternate address then resolves to
    // nothing and the next poll re-inserts it, which is exactly what
    // `article_urls` exists to prevent.
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", [], ["https://site.example/older-slug?si=1"]),
        row(2, "https://site.example/a?si=x", "h2", []),
      ],
      v2,
    );
    // Replayed under v2, the alternate's key loses its `si` tag.
    expect(plan.groups[0].urlHashes).toContain("site.example/older-slug");
    expect(plan.groups[0].urlHashes).not.toContain("https://site.example/older-slug?si=1");
  });

  it("skips an alternate the new ruleset cannot key, without failing", () => {
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", [], ["not a url"]),
        row(2, "https://site.example/a?si=x", "h2", []),
      ],
      v2,
    );
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].urlHashes).not.toContain(null);
  });

  it("carries each loser's CURRENT hash onto the winner", () => {
    // This was missing, and it lost addresses. A loser's `url_hash` is the
    // address a feed is still publishing right now; if it does not move, the
    // next poll resolves it to nothing and inserts a new article — so a
    // migration meant to remove duplicates would manufacture them.
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "old-hash-of-1"),
        row(2, "https://site.example/a?si=x", "old-hash-of-2"),
      ],
      v2,
    );
    expect(plan.groups[0].urlHashes).toContain("old-hash-of-1");
    expect(plan.groups[0].urlHashes).toContain("old-hash-of-2");
  });

  it("includes the new key itself", () => {
    const plan = planMerges(
      [row(1, "https://site.example/a", "h1"), row(2, "https://site.example/a?si=x", "h2")],
      v2,
    );
    expect(plan.groups[0].urlHashes).toContain("site.example/a");
  });

  it("deduplicates addresses shared between rows", () => {
    const plan = planMerges(
      [
        row(1, "https://site.example/a", "h1", [], ["https://site.example/shared"]),
        row(2, "https://site.example/a?si=x", "h2", [], ["https://site.example/shared"]),
      ],
      v2,
    );
    expect(plan.groups[0].urlHashes.filter((h) => h === "site.example/shared")).toHaveLength(1);
  });
});

describe("the executor", () => {
  it("is declared but not implemented until there are tables", async () => {
    await expect(
      applyMergePlan({ groups: [], rehashOnly: [], unchanged: 0 }),
    ).rejects.toBeInstanceOf(NotImplementedInStaticPhase);
  });
});
