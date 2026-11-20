import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Scope } from "@/lib/types";

import { ArticleList, type ListState } from "./index";

/*
 * What this suite is for: the states that only appear in production.
 *
 * A list with rows is what you develop against. The four states below are what
 * a real reader hits on a quiet Tuesday, and each one has a DESIGNED answer in
 * the prototype rather than a blank pane — because a blank pane means the same
 * thing as a bug, and the reader cannot tell which they are looking at.
 *
 * The sharpest of them is `not-a-feed`: §6.3 calls it the architecture's most
 * common user-reported failure. If it rendered "nothing here yet" it would read
 * as a quiet week rather than as a broken address.
 */

const noop = (id: number) => `Feed ${id}`;
const SCOPE: Scope = { kind: "unread" };

function renderList(state: ListState, overrides: Partial<Parameters<typeof ArticleList>[0]> = {}) {
  return render(
    <ArticleList
      title="All unread"
      unreadCount={0}
      state={state}
      scope={SCOPE}
      query=""
      openArticleId={null}
      feedTitleOf={noop}
      params={{}}
      {...overrides}
    />,
  );
}

describe("every empty state renders its designed copy", () => {
  it("all read: says why there is nothing, and when the next check is", () => {
    renderList({
      kind: "all-read",
      nextFetch: { title: "Harbour Wire", at: "2026-11-12T09:52:00.000Z" },
    });

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/nothing unread/i);
    // The schedule is the point: it tells the reader the app is working.
    expect(screen.getByText(/Harbour Wire, at 09:52/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /show all articles/i })).toBeTruthy();
  });

  it("all read with no scheduled check: omits the schedule rather than inventing one", () => {
    renderList({ kind: "all-read", nextFetch: null });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/nothing unread/i);
    expect(screen.queryByText(/The next is/)).toBeNull();
  });

  it("no title matches: names the term and says search looks at titles only", () => {
    renderList({ kind: "no-matches", query: "lathe" }, { query: "lathe" });

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/no titles match/i);
    expect(screen.getByText("lathe")).toBeTruthy();
    // Without this the reader concludes the body search is broken.
    expect(screen.getByText(/titles only/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /clear the search/i })).toBeTruthy();
  });

  it("a feed with zero articles: says it has been checked", () => {
    renderList({ kind: "feed-empty", feedTitle: "Kestrel Field Notes" });

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/nothing here yet/i);
    // "has been checked" is what distinguishes this from a broken feed.
    expect(screen.getByText(/Kestrel Field Notes has been checked/)).toBeTruthy();
  });

  it("not a feed: says the address serves a web page, and when it last worked", () => {
    renderList({
      kind: "not-a-feed",
      feedTitle: "Brightwater Gazette",
      // ISO, as the real caller passes. The previous version passed "9 Nov",
      // so the test stayed green while `/feed/4` rendered a raw timestamp.
      since: "2026-11-09T11:02:00Z",
      lastGood: "2026-11-09T05:02:00Z",
    });

    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent(/stopped being a feed/i);
    expect(screen.getByText(/answers with a web page instead of a feed/)).toBeTruthy();
    expect(screen.getByText(/as of 9 Nov/)).toBeTruthy();
    expect(screen.getByText(/last good check was 9 Nov/)).toBeTruthy();
    expect(screen.queryByText(/2026-11-09T/)).toBeNull();

    // The distinction that matters: this must NOT read like a quiet feed.
    expect(heading).not.toHaveTextContent(/nothing here yet/i);
    expect(screen.queryByText(/has been checked, and it has published nothing/)).toBeNull();
  });

  it("past end: says nothing is OLDER, not that everything is read", () => {
    // Reached by paging past the last row. It used to fall through to
    // `all-read`, which rendered "Nothing unread in any feed" under a heading
    // reading "All unread / 81 unread" — a wrong view, not an empty one.
    renderList({ kind: "past-end" }, { unreadCount: 81 });

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/nothing older/i);
    expect(screen.queryByText(/Nothing unread in any feed/)).toBeNull();
    expect(screen.getByRole("link", { name: /back to the newest/i })).toBeTruthy();
  });

  it("past end offers a link that clears the cursor", () => {
    renderList(
      { kind: "past-end" },
      { params: { scope: "all", before: "2026-01-01T00:00:00Z,9" } },
    );
    const back = screen.getByRole("link", { name: /back to the newest/i });
    expect(back.getAttribute("href")).toBe("?scope=all");
  });

  it("failed: reassures that read state was not lost", () => {
    renderList({ kind: "failed" });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/did not load/i);
    expect(screen.getByText(/Nothing was lost/)).toBeTruthy();
  });
});

describe("the chrome is present in every state", () => {
  const states: ListState[] = [
    { kind: "all-read", nextFetch: null },
    { kind: "past-end" },
    { kind: "no-matches", query: "x" },
    { kind: "feed-empty", feedTitle: "A feed" },
    { kind: "not-a-feed", feedTitle: "A feed", since: null, lastGood: null },
    { kind: "failed" },
  ];

  it.each(states.map((s) => [s.kind, s] as const))(
    "%s keeps the Unread/All toggle and the search box",
    (_kind, state) => {
      // An empty list that also loses its controls traps the reader: they
      // cannot switch to All to find the older articles that do exist.
      renderList(state);
      expect(screen.getByRole("link", { name: "Unread" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "All" })).toBeTruthy();
      expect(screen.getByLabelText("Search titles")).toBeTruthy();
    },
  );

  it.each(states.map((s) => [s.kind, s] as const))(
    "%s disables Mark all read when there is nothing to mark",
    (_kind, state) => {
      renderList(state, { unreadCount: 0 });
      expect(screen.getByRole("button", { name: /mark all read/i })).toBeDisabled();
    },
  );

  it("shows the nothing-was-sent receipt, which is designed rather than a stub", () => {
    renderList({ kind: "all-read", nextFetch: null });
    expect(screen.getByText(/Nothing was sent/)).toBeTruthy();
    expect(screen.getByText(/PATCH \/api\/read-state/)).toBeTruthy();
  });
});

describe("the toggle reflects the scope it was given", () => {
  it("marks Unread current in the unread scope", () => {
    renderList({ kind: "all-read", nextFetch: null }, { scope: { kind: "unread" } });
    expect(screen.getByRole("link", { name: "Unread" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current");
  });

  it("marks All current in the all scope", () => {
    renderList({ kind: "feed-empty", feedTitle: "x" }, { scope: { kind: "all" } });
    expect(screen.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "true");
  });

  it("reads unreadOnly on a feed scope rather than assuming unread", () => {
    // A feed view has its own copy of the toggle, so `{kind:'feed'}` alone
    // must not be treated as unread.
    renderList({ kind: "feed-empty", feedTitle: "x" }, { scope: { kind: "feed", feedId: 1 } });
    expect(screen.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "true");

    renderList(
      { kind: "feed-empty", feedTitle: "x" },
      { scope: { kind: "feed", feedId: 1, unreadOnly: true } },
    );
    expect(screen.getAllByRole("link", { name: "Unread" })[1]).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});
