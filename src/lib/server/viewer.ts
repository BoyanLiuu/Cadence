import { sampleUser } from "@/lib/fixtures";
import type { Capability, Viewer } from "@/lib/types";

/*
 * Who is acting, and what they may do.
 *
 * ARCHITECTURE §3: the acting user comes from the session, NEVER from a request
 * argument. No service function takes a user id; they take a `Viewer` that only
 * this module produces. That is the rule M11 has to keep, and it is cheap to
 * keep now and expensive to retrofit.
 */

/**
 * Resolves the session to a user, once per request.
 *
 * M1 returns the single fixture reader. M11 replaces the body with the Clerk
 * session and an upsert of the `users` row — the signature does not change, so
 * no caller does either.
 */
export async function getViewer(): Promise<Viewer> {
  return { kind: "user", user: sampleUser };
}

/** Thrown by `assertCan`. A denial is a 403, never a silent empty result. */
export class NotAllowedError extends Error {
  constructor(readonly capability: Capability) {
    super(`Not allowed: ${capability}`);
    this.name = "NotAllowedError";
  }
}

/**
 * The denial table, written against fixtures so the rules exist before there is
 * a real session to test them with.
 *
 * It is deliberately almost empty: through phase 1 there is one reader and
 * nothing to deny them. The one rule that IS here is the one the architecture
 * states outright — there is no public reading surface, because every article
 * list is somebody's subscription list (§2). M11 adds per-row ownership on top;
 * this is the coarse gate, not the fine one.
 */
export function assertCan(viewer: Viewer, capability: Capability): void {
  if (viewer.kind === "anon") throw new NotAllowedError(capability);
}

/** Narrowing helper, so callers do not re-implement the check. */
export function requireUser(viewer: Viewer) {
  if (viewer.kind === "anon") throw new NotAllowedError("read");
  return viewer.user;
}
