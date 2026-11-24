import { redirect } from "next/navigation";

import { NotAllowedError, StaleSession } from "./viewer";

/*
 * What a Server Action tells the reader when a write fails.
 *
 * `StaleSession` HAS A THIRD CALLER, which the error's own docstring missed. It
 * was typed so a SCREEN could go to `/session-ended` and a ROUTE HANDLER could
 * answer a status code — and the actions are neither. All three of them
 * returned `error.message`, so a reader whose account had been deleted saw an
 * internal diagnostic containing their raw Clerk user id, and no way out.
 *
 * An action CAN redirect, so it does: `/session-ended` carries the sign-out
 * form, which is the only thing that can clear the cookie. `redirect` signals
 * by throwing, so this function does not return in that case — which is why it
 * belongs in the `catch` rather than beside it.
 */
export function messageForActionError(error: unknown, fallback: string): string {
  if (error instanceof StaleSession) redirect("/session-ended");

  /*
   * `NotAllowedError` MEANS NO SESSION, and it reached the UI verbatim: a
   * reader whose session had expired pressed "Mark all read" and was shown
   * "Not allowed: set-read-state", or on `/add`, "Not allowed: subscribe". The
   * capability name is a diagnostic, not an answer.
   *
   * `/sign-in` and not `/session-ended`: there is no stale token to clear here
   * — `assertCan` refused because the viewer is anonymous — so the sign-in card
   * is the way back and cannot bounce, having no session to bounce on. The
   * PATCH route already answers this case with "Sign in to save your place";
   * before this, the two transports disagreed about the commonest session
   * failure there is.
   */
  if (error instanceof NotAllowedError) redirect("/sign-in");

  return error instanceof Error ? error.message : fallback;
}
