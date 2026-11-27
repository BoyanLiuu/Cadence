import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * What this suite is for: an endpoint that polls every feed on request.
 *
 * `/api/cron/poll` is a WRITE route reachable by anyone who knows the path.
 * Unauthorized it is a free amplifier: a stranger makes this server fetch every
 * subscribed feed as fast as they can call it, and the publishers see OUR
 * `User-Agent`, not theirs. So the gate is the feature, and what has to be
 * tested is DENIAL rather than success — an endpoint that works for the pinger
 * tells you nothing about who else it works for.
 *
 * `runSweep` is mocked throughout. This suite is about the gate; the sweep has
 * its own tests, and letting a 401 test accidentally poll the internet would be
 * its own bug.
 */

const runSweep = vi.hoisted(() => vi.fn());
vi.mock("@/lib/schedule/sweep", () => ({ runSweep }));

const SECRET = "a-test-secret-value-32-bytes-long";

let route: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  runSweep.mockReset();
  runSweep.mockResolvedValue({
    claimed: 0,
    changed: 0,
    unchanged: 0,
    failed: 0,
    itemsNew: 0,
    budgetSpent: false,
  });
  // Silenced: the fail-closed path logs to the operator on purpose, and a test
  // run should not look like a broken deployment.
  vi.spyOn(console, "error").mockImplementation(() => {});
  route = await import("./route");
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

const post = (headers: Record<string, string> = {}) =>
  route.POST(new Request("https://cadence.test/api/cron/poll", { method: "POST", headers }));

describe("the gate", () => {
  it("REFUSES every request when CRON_SECRET is unset", async () => {
    /*
     * Fail closed, and the case that matters most: an endpoint that is open
     * "until the secret is configured" is open on the first deploy, which is
     * exactly when nobody is looking at it.
     */
    delete process.env.CRON_SECRET;
    const response = await post({ authorization: "Bearer anything" });
    expect(response.status).toBe(503);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("refuses when CRON_SECRET is set but empty", async () => {
    // An empty env var is a misconfiguration, not a secret. Treating `""` as
    // valid would let `Bearer ` past the gate.
    process.env.CRON_SECRET = "   ";
    const response = await post({ authorization: "Bearer    " });
    expect(response.status).toBe(503);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("refuses a request with no credential at all", async () => {
    process.env.CRON_SECRET = SECRET;
    const response = await post();
    expect(response.status).toBe(401);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("refuses a WRONG secret", async () => {
    process.env.CRON_SECRET = SECRET;
    const response = await post({ authorization: "Bearer not-the-secret" });
    expect(response.status).toBe(401);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("refuses a secret that is merely a PREFIX of the real one", async () => {
    /*
     * The shape a length-tolerant comparison lets through, and the reason the
     * gate hashes to a fixed width before comparing. A check that returned true
     * for any prefix would be defeated one byte at a time.
     */
    process.env.CRON_SECRET = SECRET;
    const response = await post({ authorization: `Bearer ${SECRET.slice(0, -1)}` });
    expect(response.status).toBe(401);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("refuses a secret with the right length but wrong bytes", async () => {
    process.env.CRON_SECRET = SECRET;
    const wrong = "b".repeat(SECRET.length);
    const response = await post({ authorization: `Bearer ${wrong}` });
    expect(response.status).toBe(401);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("does NOT accept a bare header value as a bearer token", async () => {
    // `Authorization: <secret>` without the scheme is not what the pinger
    // sends, and accepting it widens the gate for no reason.
    process.env.CRON_SECRET = SECRET;
    const response = await post({ authorization: SECRET });
    expect(response.status).toBe(401);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("says nothing useful in the refusal body", async () => {
    // A 401 that explains itself is a 401 that helps a guesser. The operator
    // gets the detail in the logs instead.
    process.env.CRON_SECRET = SECRET;
    const response = await post({ authorization: "Bearer wrong" });
    const body = await response.text();
    expect(body).toBe("Unauthorized");
    expect(body).not.toContain(SECRET);
  });

  it("ADMITS the correct secret as a bearer token, so the gate is not simply shut", async () => {
    // The negative case for the whole suite: a gate that refused everything
    // would satisfy every assertion above and break the product.
    process.env.CRON_SECRET = SECRET;
    const response = await post({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    expect(runSweep).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({ claimed: 0, budgetSpent: false });
  });

  it("admits the correct secret in x-cron-secret, for running a tick by hand", async () => {
    process.env.CRON_SECRET = SECRET;
    const response = await post({ "x-cron-secret": SECRET });
    expect(response.status).toBe(200);
    expect(runSweep).toHaveBeenCalledTimes(1);
  });
});

describe("the method", () => {
  it("refuses GET even with a valid secret", async () => {
    /*
     * A tick WRITES. Anything reachable by a browser prefetch, a link checker,
     * or someone pasting a URL out of a log must not poll every feed as a side
     * effect — and GET is the method all three use.
     */
    process.env.CRON_SECRET = SECRET;
    const response = route.GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(runSweep).not.toHaveBeenCalled();
  });
});

describe("when the sweep itself fails", () => {
  it("answers 500 rather than letting the pinger see success", async () => {
    // A broken sweep that returns 200 is invisible until someone notices feeds
    // going stale, which could be weeks.
    process.env.CRON_SECRET = SECRET;
    runSweep.mockRejectedValue(new Error("database is on fire"));
    const response = await post({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(500);
  });

  it("does not leak the error's text to the caller", async () => {
    process.env.CRON_SECRET = SECRET;
    runSweep.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const response = await post({ authorization: `Bearer ${SECRET}` });
    const body = await response.text();
    expect(body).not.toContain("10.0.0.5");
    expect(body).toContain("sweep failed");
  });
});
