import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkReadOnScroll } from "./mark-read-on-scroll";

/*
 * What this suite is for: the marking logic, which no other test can reach.
 *
 * The browser suite runs signed OUT, so it never sees a list with rows. A
 * signed-in Playwright fixture needs `@clerk/testing` and a test user, which
 * does not exist yet. That leaves the logic here untested at exactly the place
 * it is easy to get wrong — so jsdom supplies a CONTROLLABLE
 * IntersectionObserver and the cases below drive it directly.
 *
 * The stub is honest about what it stands in for: it records what was observed
 * and lets a test deliver entries with a chosen `boundingClientRect`, which is
 * the one input the "has it scrolled past" decision reads. It does not simulate
 * scrolling, and it does not need to.
 */

type Entry = { target: Element; isIntersecting: boolean; boundingClientRect: { bottom: number } };

const OBSERVERS: {
  callback: (entries: Entry[]) => void;
  observed: Element[];
  unobserved: Element[];
  disconnected: boolean;
}[] = [];

class StubObserver {
  readonly observed: Element[] = [];
  readonly unobserved: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: (entries: Entry[]) => void) {
    OBSERVERS.push(this as unknown as (typeof OBSERVERS)[number]);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve(element: Element) {
    this.unobserved.push(element);
  }
  disconnect() {
    this.disconnected = true;
  }
  /** Delivers entries as the real observer would. */
  fire(entries: Entry[]) {
    this.callback(entries);
  }
}

/**
 * A row as the server renders it, with the attributes the contract needs.
 *
 * `getBoundingClientRect` IS STUBBED, because jsdom has no layout engine and
 * returns all zeros — which the component correctly reads as "already above the
 * viewport" and skips, so without this nothing is ever observed. `bottom`
 * defaults to on-screen; pass a negative one for a row the browser restored
 * above the fold.
 */
function addRow(id: number, options: { read?: boolean; bottom?: number } = {}): HTMLElement {
  const li = document.createElement("li");
  li.dataset.articleId = String(id);
  li.dataset.dimmed = options.read ? "true" : "false";
  li.dataset.open = "false";
  li.getBoundingClientRect = () => ({ bottom: options.bottom ?? 500 }) as DOMRect;
  document.body.append(li);
  return li;
}

const scrolledPast = (target: Element): Entry => ({
  target,
  isIntersecting: false,
  boundingClientRect: { bottom: -10 },
});

const stillOnScreen = (target: Element): Entry => ({
  target,
  isIntersecting: true,
  boundingClientRect: { bottom: 400 },
});

/** Left the viewport at the BOTTOM — scrolled up past, not read. */
const belowTheFold = (target: Element): Entry => ({
  target,
  isIntersecting: false,
  boundingClientRect: { bottom: 900 },
});

describe("marking rows read as they scroll past", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    OBSERVERS.length = 0;
    document.body.innerHTML = "";
    fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", StubObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const mount = () => {
    const rendered = render(<MarkReadOnScroll enabled />);
    return { rendered, observer: OBSERVERS[0]! as unknown as StubObserver };
  };

  it("observes the unread rows and leaves the read ones alone", () => {
    const unread = addRow(1);
    addRow(2, { read: true });

    const { observer } = mount();

    // Observing an already-read row would mark it again on every scroll — a
    // write per row per session for state that has not changed.
    expect(observer.observed).toEqual([unread]);
  });

  it("dims a row that has scrolled PAST and queues it", () => {
    const row = addRow(1);
    const { observer } = mount();

    observer.fire([scrolledPast(row)]);

    // The optimistic dim, which is the whole reason this is a client component.
    expect(row.dataset.dimmed).toBe("true");
    // And it stops watching: the decision has been made.
    expect(observer.unobserved).toEqual([row]);
  });

  it("does NOT mark a row that is still on screen", () => {
    const row = addRow(1);
    const { observer } = mount();

    observer.fire([stillOnScreen(row)]);

    expect(row.dataset.dimmed).toBe("false");
    vi.advanceTimersByTime(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT mark a row that left at the BOTTOM of the viewport", () => {
    /*
     * The case a naive `!isIntersecting` gets wrong, and it is not exotic: it
     * is every row below the fold on first paint. Marking those would mark a
     * whole list read the moment it rendered.
     */
    const row = addRow(1);
    const { observer } = mount();

    observer.fire([belowTheFold(row)]);

    expect(row.dataset.dimmed).toBe("false");
  });

  it("BATCHES a window of rows into one request", () => {
    const rows = [addRow(1), addRow(2), addRow(3)];
    const { observer } = mount();

    for (const row of rows) observer.fire([scrolledPast(row)]);
    expect(fetchMock).not.toHaveBeenCalled(); // Still inside the window.

    vi.advanceTimersByTime(2_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      ids: [1, 2, 3],
      read: true,
    });
  });

  it("PUTS THE IDS BACK when a flush fails, so the next one retries", async () => {
    /*
     * The write is idempotent precisely so this is safe (§6.2). Swallowing the
     * failure instead would lose a screenful of marks on one dropped request,
     * silently — the reader would scroll back later and find everything unread.
     */
    // 503: transient, so worth repeating — unlike a 401 or a 501.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    const row = addRow(1);
    const { observer } = mount();

    observer.fire([scrolledPast(row)]);
    vi.advanceTimersByTime(2_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    /*
     * IT RESCHEDULES ITSELF. The first version put the ids back and set no new
     * timer, so they left only if another row happened to scroll past — which,
     * at the end of a reading session, nothing does.
     */
    vi.advanceTimersByTime(2_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((init as RequestInit).body as string).ids).toEqual([1]);
  });

  it("flushes what it has on unmount rather than dropping it", () => {
    // Navigating away mid-window is the common case, not an edge one.
    const row = addRow(1);
    const { rendered, observer } = mount();

    observer.fire([scrolledPast(row)]);
    rendered.unmount();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observer.disconnected).toBe(true);
  });

  it("does NOT observe a row the browser restored above the viewport", () => {
    /*
     * Reload or back-navigation restores scroll position, and the observer's
     * first callback then reports everything above the fold as scrolled past —
     * a screenful marked read that this session never touched. So a row already
     * above the viewport when we first see it is not observed at all.
     */
    const above = addRow(1, { bottom: -200 });
    const below = addRow(2);

    const { observer } = mount();

    expect(observer.observed).toEqual([below]);
    expect(above.dataset.dimmed).toBe("false");
  });

  it("observes rows that arrive LATER, so paging does not stop the marking", () => {
    /*
     * This component is not remounted by a navigation within /reader, so
     * "Older", a scope switch or a search replaces the rows under it. Querying
     * once at mount meant marking silently stopped for the rest of the session
     * — every row still rendered and nothing threw.
     */
    const { observer } = mount();
    expect(observer.observed).toEqual([]);

    const later = addRow(7);

    return vi.waitFor(() => expect(observer.observed).toEqual([later]));
  });

  it("GIVES UP on a refusal that repeating cannot fix, and undims", async () => {
    /*
     * 401 (session expired) and 501 (fixtures mode, no database) fail
     * identically forever. Retrying grew `pending` without bound and every
     * later flush re-sent the whole accumulated set — and the rows stayed
     * dimmed, claiming marks the server never recorded.
     */
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    const row = addRow(1);
    const { observer } = mount();

    observer.fire([scrolledPast(row)]);
    vi.advanceTimersByTime(2_000);
    await vi.waitFor(() => expect(row.dataset.dimmed).toBe("false"));

    // And it stops: a later row is not sent either.
    const second = addRow(2);
    observer.fire([scrolledPast(second)]);
    vi.advanceTimersByTime(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when there is nothing to mark", () => {
    addRow(1, { read: true });
    render(<MarkReadOnScroll enabled={false} />);

    expect(OBSERVERS).toHaveLength(0);
  });
});
