import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * What this suite is for: the gate and the bad requests.
 *
 * This is the FIRST write endpoint a person can reach, so its shape is the one
 * every later route copies — and the parts worth testing are the ones no screen
 * exercises. The reader's own flush sends well-formed batches with a session;
 * what arrives here in the wild is a signed-out tab whose cookie expired, a
 * client bug sending a float, and whatever anyone curling the path tries.
 *
 * Review flagged this file's absence while the sibling route (`api/cron/poll`)
 * had a dedicated suite built around exactly the same question. Behaviour of
 * the write itself is covered against Postgres in
 * `src/lib/server/read-state.test.ts`; this covers only the HTTP edge, so it
 * mocks the mutation and needs no database.
 */

const VIEWER = vi.hoisted(() => ({ kind: "user" as "user" | "anon" }));
const CALLS = vi.hoisted(() => ({ ids: [] as number[][], read: [] as boolean[] }));

vi.mock("@/lib/server/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/viewer")>();
  return {
    ...actual,
    getViewer: () =>
      Promise.resolve(
        VIEWER.kind === "anon"
          ? { kind: "anon" }
          : {
              kind: "user",
              user: {
                id: "user_route_test",
                email: "r@example.invalid",
                name: "R",
                initials: "R",
                tz: "UTC",
                aiEnabled: false,
              },
            },
      ),
  };
});

vi.mock("@/lib/server/mutations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/mutations")>();
  return {
    ...actual,
    setReadState: (
      viewer: { kind: string },
      ids: number[],
      read: boolean,
    ): Promise<{ applied: number; ignored: number }> => {
      /*
       * DELEGATES THE GATE to the real function rather than imitating it. The
       * first version threw a different error for an anon, so the 401 test
       * passed on a code path the route maps to 501 — green, and asserting
       * nothing about the gate it was named for. `assertCan` throws before
       * anything touches a database, so this needs none.
       */
      if (viewer.kind === "anon") {
        return actual.setReadState(viewer as Parameters<typeof actual.setReadState>[0], ids, read);
      }
      CALLS.ids.push(ids);
      CALLS.read.push(read);
      return Promise.resolve({ applied: ids.length, ignored: 0 });
    },
  };
});

const patch = async (body: unknown, raw?: string) => {
  const { PATCH } = await import("./route");
  return PATCH(
    new Request("https://cadence.test/api/read-state", {
      method: "PATCH",
      body: raw ?? JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
};

describe("PATCH /api/read-state", () => {
  beforeEach(() => {
    VIEWER.kind = "user";
    CALLS.ids = [];
    CALLS.read = [];
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("refuses a signed-out caller with 401, not a redirect", async () => {
    /*
     * The gate, and the status matters as much as the refusal. A 303 to
     * `/sign-in` would be FOLLOWED by a background flush, return 200 with HTML,
     * and look like success — the reader's marks would silently stop
     * persisting. That is why this route calls `getViewer()` rather than
     * `requireViewer()`.
     */
    VIEWER.kind = "anon";

    const response = await patch({ ids: [1], read: true });

    expect(response.status).toBe(401);
    expect(CALLS.ids).toEqual([]);
  });

  it("answers 400 for a body of literal null rather than crashing", async () => {
    // `null` is valid JSON, so it parses — and destructuring it threw OUTSIDE
    // the try, which the framework turned into a 500 for a plainly bad request.
    const response = await patch(null);
    expect(response.status).toBe(400);
  });

  it("answers 400 for a body that is not JSON at all", async () => {
    const response = await patch(undefined, "not json");
    expect(response.status).toBe(400);
  });

  it.each([
    ["ids missing", { read: true }],
    ["read missing", { ids: [1] }],
    ["ids not an array", { ids: 1, read: true }],
    ["read not a boolean", { ids: [1], read: "yes" }],
    ["an id that is not a number", { ids: ["1"], read: true }],
  ])("answers 400 when %s", async (_label, body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(CALLS.ids).toEqual([]);
  });

  it("answers 413 for an oversized batch rather than truncating it", async () => {
    // Truncating would apply 500 of 5000 and report success, which is a client
    // bug made invisible.
    const response = await patch({ ids: Array.from({ length: 501 }, (_, i) => i + 1), read: true });

    expect(response.status).toBe(413);
    expect(CALLS.ids).toEqual([]);
  });

  it("passes a well-formed batch through and reports what happened", async () => {
    const response = await patch({ ids: [7, 8], read: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: 2, ignored: 0 });
    expect(CALLS.ids).toEqual([[7, 8]]);
    expect(CALLS.read).toEqual([true]);
  });

  it("carries read: false through, so unmarking is not silently a mark", async () => {
    await patch({ ids: [7], read: false });
    expect(CALLS.read).toEqual([false]);
  });

  it("answers 405 with an Allow header for a GET", async () => {
    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("PATCH");
  });
});
