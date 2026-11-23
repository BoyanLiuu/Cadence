import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SavedEmpty, SavedFilterEmpty } from "./empty";

/*
 * What this suite is for: Saved rendering the unread list's copy.
 *
 * Every clause of "Nothing unread in any feed. Feeds are checked on their own
 * schedules. The next is Harbour Wire, at 09:52." is FALSE of an empty Saved:
 * it is not about unread, not about feeds, and not waiting for a schedule.
 */

describe("Saved's own empty state", () => {
  it("says nothing is saved, not that nothing is unread", () => {
    render(<SavedEmpty />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/nothing saved yet/i);
    // The body may mention the unread count — "out of the unread count" is the
    // point of saving. What it must not do is borrow the reader's HEADLINE,
    // which claims nothing is unread anywhere.
    expect(screen.queryByText(/nothing unread/i)).toBeNull();
    expect(screen.queryByText(/in any feed/i)).toBeNull();
  });

  it("does not mention feeds or a schedule", () => {
    // The reader's copy explains a schedule, which is the reason there is
    // nothing to read. Saved is not waiting for a schedule.
    render(<SavedEmpty />);
    expect(screen.queryByText(/checked on their own schedules/i)).toBeNull();
    expect(screen.queryByText(/The next is/)).toBeNull();
  });

  it("explains what saving is for, which is the useful thing to say", () => {
    render(<SavedEmpty />);
    expect(screen.getByText(/out of the unread count/i)).toBeTruthy();
  });

  it("offers a way back to the reader", () => {
    render(<SavedEmpty />);
    expect(screen.getByRole("link", { name: /back to the reader/i })).toHaveAttribute(
      "href",
      "/reader",
    );
  });
});

describe("the filtered-but-not-empty state is distinct", () => {
  it("says everything saved is read when the unread filter is empty", () => {
    // Different from "nothing saved": there ARE saved articles, just none
    // matching this filter. Showing the blank-Saved copy would be wrong.
    render(<SavedFilterEmpty filter="unread" total={4} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/nothing saved is unread/i);
    expect(screen.getByRole("link", { name: /show all 4/i })).toBeTruthy();
  });

  it("says none are finished when the read filter is empty", () => {
    render(<SavedFilterEmpty filter="read" total={2} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/nothing saved is read/i);
    expect(screen.getByText(/not finished any of these/i)).toBeTruthy();
  });

  it("never claims nothing is saved when something is", () => {
    render(<SavedFilterEmpty filter="unread" total={4} />);
    expect(screen.queryByText(/nothing saved yet/i)).toBeNull();
  });
});
