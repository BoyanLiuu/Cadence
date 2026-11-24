import { describe, expect, it, vi } from "vitest";

const REDIRECTED = vi.hoisted(() => ({ to: null as string | null }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    REDIRECTED.to = to;
    // The real one signals by throwing, which this function relies on to stop.
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${to}` });
  },
}));

const { messageForActionError } = await import("./action-error");
const { NotAllowedError, StaleSession } = await import("./viewer");

/*
 * What this suite is for: the two session failures that must not be shown as
 * text, and the ones that must.
 *
 * Both redirects were written without tests, and review pointed out that
 * deleting either line left every unit and browser test green — while a reader
 * saw an internal diagnostic and no way out. The failure is invisible because
 * returning a string is a perfectly reasonable thing for this function to do;
 * it is only wrong for these two cases.
 */

const run = (error: unknown) => {
  REDIRECTED.to = null;
  try {
    return { returned: messageForActionError(error, "fallback") };
  } catch {
    return { redirectedTo: REDIRECTED.to };
  }
};

describe("what an action tells the reader", () => {
  it("sends a STALE session to /session-ended, the only page that can clear it", () => {
    /*
     * Clerk still considers the token valid, so `/sign-in` would bounce them
     * back into a loop. `/session-ended` carries the sign-out form, and only an
     * action may write a cookie — so this is the one exit.
     */
    expect(run(new StaleSession("user_gone"))).toEqual({ redirectedTo: "/session-ended" });
  });

  it("does NOT leak the Clerk user id into the UI", () => {
    // What the reader used to see: the message, which names the id.
    const result = run(new StaleSession("user_2abcSECRET"));

    expect(JSON.stringify(result)).not.toContain("user_2abcSECRET");
  });

  it("sends NO session to /sign-in, which cannot bounce", () => {
    /*
     * `assertCan` refuses an anon with the capability's own name, so the reader
     * was shown "Not allowed: set-read-state" after their session expired.
     * There is no stale token here, so the sign-in card has nothing to bounce
     * on.
     */
    expect(run(new NotAllowedError("set-read-state"))).toEqual({ redirectedTo: "/sign-in" });
  });

  it("returns the message for a failure the reader CAN act on", () => {
    // The ordinary case, which must keep working: a bad address, a folder that
    // is not theirs. These belong on the form, not behind a redirect.
    expect(run(new Error("That is not a feed address."))).toEqual({
      returned: "That is not a feed address.",
    });
  });

  it("falls back for something that is not an Error at all", () => {
    expect(run("a string somehow")).toEqual({ returned: "fallback" });
  });
});
