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
    expect(within(rowFor("Ledger & Lathe")).getByText(/by address/)).toBeTruthy();
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
