import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { feeds, subscriptions } from "@/lib/fixtures";
import type { Folder, SubscriptionWithUnread } from "@/lib/types";

import { HealthTable } from "./health-table";

/*
 * What this suite is for: a table that cannot render the interesting rows.
 *
 * The boring row — an active feed with checks and items — is what you build
 * against. The interesting ones are a feed that was never checked, a dead one,
 * and a brand-new one, and each of them has a cell with NO NUMBER IN IT.
 *
 * The trap is filling those with `0%`. It is not a blank, it is a LIE: "0%
 * collapsed" means items arrived and none were duplicates, while the truth is
 * that nothing arrived at all. On the one screen that exists to prove the
 * dedup works, a plausible wrong number is worse than an honest dash.
 */

const sub = (feedId: number): SubscriptionWithUnread => {
  const base = subscriptions.find((s) => s.feedId === feedId)!;
  const feed = feeds.find((f) => f.id === feedId)!;
  return { ...base, feed, unread: 0 };
};

const FOLDERS: Folder[] = [
  { id: 1, userId: "u", name: "News", position: 0 },
  { id: 2, userId: "u", name: "Essays", position: 1 },
  { id: 3, userId: "u", name: "Making", position: 2 },
];

const rowFor = (title: string) => screen.getByRole("row", { name: new RegExp(title) });

describe("the interesting rows render without a crash or an empty cell", () => {
  it("renders every fixture feed, including all four states", () => {
    render(<HealthTable subs={subscriptions.map((s) => sub(s.feedId))} folders={FOLDERS} />);
    // 12 feeds plus the header row.
    expect(screen.getAllByRole("row")).toHaveLength(13);
  });

  it("a not_a_feed feed says so, and does not claim a schedule", () => {
    render(<HealthTable subs={[sub(4)]} folders={FOLDERS} />);
    const row = rowFor("Brightwater Gazette");
    expect(within(row).getByText("Not a feed")).toBeTruthy();
    expect(within(row).getByText("A web page")).toBeTruthy();
    // It has stopped being checked, so an interval would be a fiction.
    expect(within(row).getByText("Not checked")).toBeTruthy();
    // TWO cells legitimately read "None" here: no 304 ratio (no checks) and no
    // next check (it has stopped). Both are the honest answer.
    expect(within(row).getAllByText("None")).toHaveLength(2);
  });

  it("a dead feed says Stopped and names the code", () => {
    render(<HealthTable subs={[sub(8)]} folders={FOLDERS} />);
    const row = rowFor("Hollow Pine Notes");
    expect(within(row).getByText("Stopped")).toBeTruthy();
    expect(within(row).getByText("404 not found")).toBeTruthy();
    expect(within(row).getByText("Not checked")).toBeTruthy();
  });

  it("a brand-new feed says New, which is cleanPolls made visible", () => {
    // §6.1's "trusted slowly", and the promise the add screen made. A reader
    // told their feed is matched by address first should be able to see it.
    render(<HealthTable subs={[sub(11)]} folders={FOLDERS} />);
    const row = rowFor("Kestrel Field Notes");
    expect(within(row).getByText("New")).toBeTruthy();
    expect(within(row).getByText("Matching by address first")).toBeTruthy();
  });

  it("a feed in backoff says Retrying rather than Stopped", () => {
    // Still a feed, still being retried: calling it stopped would be wrong.
    render(<HealthTable subs={[sub(12)]} folders={FOLDERS} />);
    const row = rowFor("Saltmarsh Almanac");
    expect(within(row).getByText("Retrying")).toBeTruthy();
    expect(within(row).getByText("Timed out")).toBeTruthy();
    expect(within(row).queryByText("Stopped")).toBeNull();
  });

  it("leaves no cell blank in any row", () => {
    render(<HealthTable subs={subscriptions.map((s) => sub(s.feedId))} folders={FOLDERS} />);
    const rows = screen.getAllByRole("row").slice(1);
    for (const row of rows) {
      for (const cell of within(row).getAllByRole("cell")) {
        expect(cell.textContent?.trim(), `empty cell in ${row.textContent?.slice(0, 30)}`).not.toBe(
          "",
        );
      }
    }
  });
});

describe("a missing number is said honestly, never as a zero", () => {
  it("says None, not 0%, when a feed had no checks today", () => {
    // 0% not-modified means "checked, and nothing was a 304". A feed with no
    // checks at all has no ratio to report.
    render(<HealthTable subs={[sub(4)]} folders={FOLDERS} />);
    const row = rowFor("Brightwater Gazette");
    expect(within(row).getAllByText("None").length).toBeGreaterThan(0);
    expect(within(row).queryByText("0%")).toBeNull();
  });

  it("says None read, not 0%, when no items were read", () => {
    render(<HealthTable subs={[sub(6)]} folders={FOLDERS} />);
    expect(within(rowFor("Marginalia Weekly")).getByText("None read")).toBeTruthy();
  });

  it("says 0% when items WERE read and none collapsed", () => {
    // The real and different fact. Feed 5 read 10 items, all new.
    render(<HealthTable subs={[sub(5)]} folders={FOLDERS} />);
    expect(within(rowFor("The Fenwick Review")).getByText("0%")).toBeTruthy();
  });

  it("names the rung when a feed collapses mostly by address", () => {
    // §6.1: a feed collapsing by ADDRESS is a feed whose GUIDs cannot be
    // trusted, which is the single most useful thing this table reports.
    render(<HealthTable subs={[sub(9)]} folders={FOLDERS} />);
    expect(within(rowFor("Ledger & Lathe")).getByText(/% by address/)).toBeTruthy();
  });

  it("says WHY a feed collapsed by address, which the percentage cannot", () => {
    /*
     * The distinction this screen exists for. "92 % by address" has two
     * completely different causes — a new feed whose rung 1 is not routing
     * yet, and a publisher who regenerates its guids on every build — and
     * through the collapse rate alone they read identically.
     *
     * A feed churning but NOT yet flagged, which is the case where this line
     * is the only warning available. Feed 9 is already flagged, so its row
     * suppresses this to avoid repeating the State column.
     */
    const churning = sub(1);
    const row = {
      ...churning,
      feed: { ...churning.feed, today: { ...churning.feed.today, guidAgreed: 0, guidChurned: 11 } },
    };
    render(<HealthTable subs={[row]} folders={FOLDERS} />);
    expect(within(rowFor("Harbour Wire")).getByText("ids all changed")).toBeTruthy();
  });

  it("says the ids HELD for a feed collapsing on its own guids", () => {
    // The negative case. Feed 1 matches everything at rung 1, so its ids are
    // holding still and the line must say so rather than being absent.
    render(<HealthTable subs={[sub(1)]} folders={FOLDERS} />);
    expect(within(rowFor("Harbour Wire")).getByText("ids held")).toBeTruthy();
  });

  it("reports a PARTIAL churn rate rather than rounding it to a verdict", () => {
    // A feed with a little churn — a few moved articles — is neither
    // "held" nor "all changed", and flattening it to either would hide a feed
    // drifting toward demotion.
    const partial = sub(1);
    const row = {
      ...partial,
      feed: { ...partial.feed, today: { ...partial.feed.today, guidAgreed: 8, guidChurned: 2 } },
    };
    render(<HealthTable subs={[row]} folders={FOLDERS} />);
    expect(within(rowFor("Harbour Wire")).getByText("20% of ids changed")).toBeTruthy();
  });

  it("says NOTHING about ids when the poll had nothing to judge", () => {
    /*
     * The same rule as the 304 ratio's empty cell: a poll with no matches is
     * no evidence, and §6.4's own detector ignores those polls. Rendering
     * "0 % of ids changed" from zero samples invents a fact — and on the one
     * screen built to let a reader VERIFY the deduplication, a plausible
     * fabricated number is worse than a blank.
     */
    const quiet = sub(1);
    const row = {
      ...quiet,
      feed: { ...quiet.feed, today: { ...quiet.feed.today, guidAgreed: 0, guidChurned: 0 } },
    };
    render(<HealthTable subs={[row]} folders={FOLDERS} />);
    const cells = within(rowFor("Harbour Wire"));
    expect(cells.queryByText(/ids/)).toBeNull();
    expect(cells.queryByText(/of ids changed/)).toBeNull();
  });

  it("refuses a verdict from TOO FEW judged items", () => {
    /*
     * §6.1's detector ignores polls under five items, and this line must not
     * state a conclusion the detector would refuse to draw. Two items both
     * churning is not evidence — and "ids all changed" from a sample of two is
     * the same fabrication as rendering an unchecked feed's 304 ratio as 0 %.
     *
     * The docstring promised this floor before the code had it.
     */
    const tiny = sub(1);
    const row = {
      ...tiny,
      feed: { ...tiny.feed, today: { ...tiny.feed.today, guidAgreed: 0, guidChurned: 2 } },
    };
    render(<HealthTable subs={[row]} folders={FOLDERS} />);
    expect(within(rowFor("Harbour Wire")).queryByText(/ids/)).toBeNull();
  });

  it("does NOT round a real churn event away to 'ids held'", () => {
    /*
     * One churned item in four hundred is 0.25 %, which rounds to zero — so
     * deciding the absolute verdicts from the ROUNDED percentage printed "ids
     * held" over a genuine churn event, on the screen built to surface it.
     * The verdicts are decided on the counters now.
     */
    const mostly = sub(1);
    const row = {
      ...mostly,
      feed: { ...mostly.feed, today: { ...mostly.feed.today, guidAgreed: 400, guidChurned: 1 } },
    };
    render(<HealthTable subs={[row]} folders={FOLDERS} />);
    const cells = within(rowFor("Harbour Wire"));
    expect(cells.queryByText("ids held")).toBeNull();
    expect(cells.getByText("1% of ids changed")).toBeTruthy();
  });

  it("does not round a single agreement away to 'ids all changed' either", () => {
    // The mirror case: 1 of 301 agreeing is 99.7 % churn, which rounds to 100.
    const mostly = sub(1);
    const row = {
      ...mostly,
      feed: { ...mostly.feed, today: { ...mostly.feed.today, guidAgreed: 1, guidChurned: 300 } },
    };
    render(<HealthTable subs={[row]} folders={FOLDERS} />);
    const cells = within(rowFor("Harbour Wire"));
    expect(cells.queryByText("ids all changed")).toBeNull();
    expect(cells.getByText("99% of ids changed")).toBeTruthy();
  });

  it("does not say the same thing twice on a demoted feed's row", () => {
    /*
     * The State column already says "Its ids changed on every build" —
     * permanently, which is the stronger claim. Adding "ids all changed" beside
     * it makes the row repeat itself, which is the duplication an earlier fix
     * in this file removed once already.
     */
    render(<HealthTable subs={[sub(9)]} folders={FOLDERS} />);
    const cells = within(rowFor("Ledger & Lathe"));
    expect(cells.getByText("Its ids changed on every build")).toBeTruthy();
    expect(cells.queryByText("ids all changed")).toBeNull();
  });

  it("says a demoted feed's ids changed, rather than calling it New", () => {
    /*
     * `guid_unstable` is permanent (§6.1), and `recordTrust` zeroes
     * `clean_polls` when it demotes — so a flagged feed satisfies the "New"
     * branch TOO, and the branch order is what decides which one shows.
     * Reporting it as New would say it is being treated cautiously while it
     * proves itself, when it has already failed to.
     *
     * `clean_polls: 0` is the state that actually collides, and it has to be
     * constructed: fixture feed 9 carries `cleanPolls: null`, so the "New"
     * branch could never fire for it and the assertion below would pass
     * whatever the branch order was.
     *
     * Not a warning: the feed works, it just cannot be believed about its own
     * ids. That is a fact rather than a fault.
     */
    const demoted = sub(9);
    const row = {
      ...demoted,
      feed: { ...demoted.feed, guidUnstable: true, cleanPolls: 0 },
    };
    render(<HealthTable subs={[row]} folders={FOLDERS} />);
    const cells = within(rowFor("Ledger & Lathe"));
    expect(cells.getByText("Its ids changed on every build")).toBeTruthy();
    expect(cells.queryByText("New")).toBeNull();
    expect(cells.queryByText("Matching by address first")).toBeNull();
  });
});

describe("ordering and the empty state", () => {
  it("puts the feeds needing attention first", () => {
    // This screen is opened because something is wrong.
    render(<HealthTable subs={subscriptions.map((s) => sub(s.feedId))} folders={FOLDERS} />);
    const first = screen.getAllByRole("row")[1];
    expect(first.textContent).toContain("Brightwater Gazette");
  });

  it("renders its own copy when there are no feeds at all", () => {
    render(<HealthTable subs={[]} folders={FOLDERS} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/no feeds to report on/i);
    expect(screen.getByRole("link", { name: /add a feed/i })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("names the folder a feed is filed in, or says Unfiled", () => {
    render(<HealthTable subs={[{ ...sub(1), folderId: null }]} folders={FOLDERS} />);
    expect(screen.getByText(/Unfiled/)).toBeTruthy();
  });
});
