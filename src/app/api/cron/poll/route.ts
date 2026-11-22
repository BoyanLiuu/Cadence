import { createHash, timingSafeEqual } from "node:crypto";

import { runSweep } from "@/lib/schedule/sweep";

/*
 * The tick. ARCHITECTURE §6.4.
 *
 * `maxDuration` is 300 because that is the function cap the sweep's 240-second
 * budget sits inside. Node runtime, not Edge: the sweep uses `node:crypto`, the
 * `pg` driver and a streaming body reader.
 *
 * WHY AN EXTERNAL PINGER AND NOT VERCEL CRON (Appendix G question 4, settled):
 * Vercel Cron on the Hobby plan fires once a DAY and rejects a minute
 * expression at deploy time. A frequent cadence is what makes §6.4's budget and
 * lease meaningful, so the schedule lives in `.github/workflows/ping.yml` and
 * this route is what it calls — every FIVE minutes, because GitHub coalesces
 * runs more frequent than that and the adaptive interval's floor is 15 minutes
 * anyway. Nothing here depends on punctuality: the sweep claims what is DUE. The architecture is candid that one small
 * always-on VM with `node-cron` would delete this whole problem — and would
 * also delete one of the project's three stated learning goals, which is why
 * Vercel stays.
 *
 * ---------------------------------------------------------------------------
 * AUTHENTICATION
 * ---------------------------------------------------------------------------
 * This is a WRITE endpoint reachable by anyone who knows the path. Unauthorized,
 * it lets a stranger make this server fetch every subscribed feed as often as
 * they like — a free amplifier pointed at publishers who would see our
 * `User-Agent`, not theirs.
 *
 * The caller is a machine, so the mechanism is a shared secret in a header,
 * which is the pattern native to this target context: it is what Vercel's own
 * cron documentation prescribes (`CRON_SECRET`), and GitHub Actions supplies it
 * from a repository secret. This is a public repository, so the code names no
 * internal system and nothing here is specific to any employer's paved path.
 *
 * FAIL CLOSED. With `CRON_SECRET` unset, every request is refused — including
 * in development. An endpoint that is open "until the secret is configured" is
 * open on the first deploy, which is exactly when nobody is looking. The only
 * way past the gate is the real secret; there is no `NODE_ENV` escape hatch,
 * because an ambient variable is not a decision anyone made.
 */

export const runtime = "nodejs";
export const maxDuration = 300;
/** A tick must never be served from a cache. */
export const dynamic = "force-dynamic";

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `a === b` on strings returns as soon as two bytes differ, so the time it
 * takes reveals how long a correct prefix was — enough to recover a secret one
 * byte at a time over many requests. `timingSafeEqual` needs equal lengths, so
 * both sides are hashed to a fixed width first; comparing lengths directly
 * would leak the length.
 */
function secretMatches(provided: string, expected: string): boolean {
  /*
   * HASHED TO A FIXED WIDTH FIRST, which the previous version only claimed.
   *
   * It compared `a.length !== b.length` and returned early — the length oracle
   * the comment said it was avoiding. `timingSafeEqual` requires equal lengths,
   * so the fix is not to compare them but to remove the difference: both sides
   * go through sha256, which always yields 32 bytes whatever came in.
   *
   * The comparison is then genuinely constant-time over the whole input, and
   * nothing about the secret's length is observable.
   */
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** The gate. Returns a `Response` when the request must be refused. */
function refuse(request: Request): Response | null {
  const expected = process.env.CRON_SECRET;
  if (expected === undefined || expected.trim() === "") {
    // Fail closed, and say which variable is missing — to the OPERATOR in the
    // logs, not to the caller in the body.
    console.error("CRON_SECRET is not set; refusing every /api/cron/poll request.");
    return new Response("Not configured", { status: 503 });
  }

  /*
   * `Authorization: Bearer <secret>` is what Vercel Cron sends and what the
   * pinger workflow is written to send. The `x-cron-secret` header is accepted
   * too so the endpoint can be exercised by hand without a bearer prefix.
   */
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") === true ? header.slice(7) : null;
  const provided = bearer ?? request.headers.get("x-cron-secret");

  if (provided === null || !secretMatches(provided, expected)) {
    // No detail: a 401 that explains itself is a 401 that helps a guesser.
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const refused = refuse(request);
  if (refused !== null) return refused;

  try {
    const outcome = await runSweep();
    return Response.json(outcome, { status: 200 });
  } catch (error) {
    // The tick failing must not look like success to the pinger, or a broken
    // sweep is invisible until someone notices feeds going stale.
    console.error("sweep failed", error);
    return Response.json({ error: "sweep failed" }, { status: 500 });
  }
}

/**
 * GET is refused outright, even with a valid secret.
 *
 * A tick WRITES. Anything reachable by a browser prefetch, a link checker or a
 * crawler following a URL out of a log must not poll every feed as a side
 * effect — and `GET` is the method all three use.
 */
export function GET(): Response {
  return new Response("Use POST", { status: 405, headers: { allow: "POST" } });
}
