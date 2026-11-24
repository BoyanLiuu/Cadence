import { NoDatabase, setReadState } from "@/lib/server/mutations";
import { getViewer, NotAllowedError } from "@/lib/server/viewer";

/*
 * PATCH /api/read-state — the reader's marks, made durable (§6.2, M11).
 *
 * THE FIRST WRITE ENDPOINT A PERSON CAN REACH, so the authorization shape here
 * is the one every later route copies.
 *
 * NO `auth.protect()` AND NO MATCHER ENTRY. Clerk 7 makes every route public
 * unless something says otherwise, and the something here is `getViewer()` plus
 * the service layer: an anon resolves to `{ kind: "anon" }`, `assertCan` throws
 * `NotAllowedError`, and that becomes the 401 below. The per-row question —
 * whether these articles are THIS reader's — is answered separately, by the
 * subscription relation in `read-state.db.ts`. Two checks, because passing the
 * first and forgetting the second is the hole.
 *
 * `getViewer()` RATHER THAN `requireViewer()`. A redirect is the right answer
 * for a screen and the wrong one for a client flushing marks in the background:
 * a 303 to `/sign-in` would be followed, return 200 with HTML, and look like
 * success. A 401 is something the client can act on.
 *
 * PATCH, NOT POST. The prototype's receipt names `PATCH /api/read-state` and
 * the semantics match: this modifies part of a resource the reader already has,
 * idempotently, which is exactly PATCH's contract — and the idempotency is real
 * rather than asserted, so a retried flush cannot double-count or un-read.
 */

/** The largest batch one flush may carry. */
const MAX_IDS = 500;

type Body = { ids: unknown; read: unknown };

export async function PATCH(request: Request): Promise<Response> {
  const viewer = await getViewer();

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  /*
   * `null` IS VALID JSON, and destructuring it throws outside the try above —
   * a framework 500 for what is plainly a bad request. So is `3`, and `"ids"`.
   */
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  const { ids, read } = body;

  if (!Array.isArray(ids) || typeof read !== "boolean") {
    return Response.json({ error: "Expected { ids: number[], read: boolean }" }, { status: 400 });
  }

  /*
   * A CAP, because this is reachable by anyone with a session and the work is
   * proportional to the batch. Rejecting rather than truncating: a client that
   * sends 5000 ids has a bug, and silently applying 500 of them makes it look
   * like it worked.
   */
  if (ids.length > MAX_IDS) {
    return Response.json(
      { error: `At most ${MAX_IDS} ids per request, got ${ids.length}` },
      { status: 413 },
    );
  }

  // Filtered here rather than trusted, so a string or a float cannot reach a
  // `BigInt()` call and throw a 500 for what is a bad request.
  const numeric = ids.filter((id): id is number => typeof id === "number");
  if (numeric.length !== ids.length) {
    return Response.json({ error: "Every id must be a number" }, { status: 400 });
  }

  try {
    const result = await setReadState(viewer, numeric, read);
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof NotAllowedError) {
      // 401 and not 403: the viewer is anonymous, so the answer is "sign in",
      // not "you may not". A signed-in reader is never refused here — ids they
      // cannot reach come back in `ignored`.
      return Response.json({ error: "Sign in to save your place" }, { status: 401 });
    }
    if (error instanceof NoDatabase) {
      // Fixtures mode, which cannot persist. The screen's own receipt already
      // says so; this says the same thing to a client.
      return Response.json({ error: error.message }, { status: 501 });
    }
    console.error("read-state: applying marks failed", error);
    return Response.json({ error: "Could not save your place" }, { status: 500 });
  }
}

/** Anything else, so a stray GET gets an answer rather than a 405 from nowhere. */
export async function GET(): Promise<Response> {
  return new Response("Use PATCH", { status: 405, headers: { allow: "PATCH" } });
}
