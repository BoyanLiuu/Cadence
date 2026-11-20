import { describe, expect, it } from "vitest";

/*
 * M0 has no behaviour, so it has no behavioural tests — a test asserting that a
 * stylesheet loaded catches no bug anyone will have. This suite exists so the
 * runner is wired and the first real test (M2's parser) has somewhere to go.
 */
describe("the test runner", () => {
  it("runs", () => {
    expect(true).toBe(true);
  });
});
