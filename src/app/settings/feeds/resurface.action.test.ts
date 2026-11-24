import { afterAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import { sampleUser } from "@/lib/fixtures";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { setResurfaceOnRevision } from "./resurface.action";

/*
 * What this suite is for: the inversion, and the reason it is an inversion.
 *
 * A checkbox posts NOTHING when unticked, so a form carrying "the value I want"
 * cannot express "off" — the field would be missing and the obvious reading of
 * that is "leave it alone", which makes the control one-way. So the form submits
 * what the reader was LOOKING AT and the action flips it. That is one line of
 * logic and two ways to get it backwards: invert nothing, or invert the wrong
 * field.
 *
 * It also pins the setting to the SUBSCRIPTION. `resurface_on_revision` lives
 * there rather than on `feeds` because two readers can want different answers
 * about one feed, and the feed row is shared — so this asserts the other
 * reader's row does not move.
 *
 * WRITES, so `CADENCE_DB_WRITE_TESTS=1`. It acts as the fixture reader, because
 * that is who `getViewer()` resolves to in tests, and restores the flag.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OTHER = `user_test_resurface_${RUN}`;

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
};

describeDb("the resurface-on-revision toggle", () => {
  /** A feed the fixture reader follows, whose flag is restored afterwards. */
  const feedId = 1;
  let wasOn = false;

  afterAll(async () => {
    await prisma.subscription.updateMany({
      where: { userId: sampleUser.id, feedId: BigInt(feedId) },
      data: { resurfaceOnRevision: wasOn },
    });
    await prisma.subscription.deleteMany({ where: { userId: OTHER } });
    await prisma.user.deleteMany({ where: { id: OTHER } });
    await prisma.$disconnect();
  });

  const read = async (userId: string) =>
    (
      await prisma.subscription.findUniqueOrThrow({
        where: { userId_feedId: { userId, feedId: BigInt(feedId) } },
      })
    ).resurfaceOnRevision;

  it("turns the setting ON when the reader was looking at OFF", async () => {
    wasOn = await read(sampleUser.id);

    const result = await setResurfaceOnRevision(
      null,
      formOf({ feedId: String(feedId), current: "false" }),
    );

    expect(result).toBeNull();
    expect(await read(sampleUser.id)).toBe(true);
  });

  it("turns it OFF again when the reader was looking at ON", async () => {
    // The direction a one-way control gets wrong, and the reason the current
    // value is submitted rather than the wanted one.
    const result = await setResurfaceOnRevision(
      null,
      formOf({ feedId: String(feedId), current: "true" }),
    );

    expect(result).toBeNull();
    expect(await read(sampleUser.id)).toBe(false);
  });

  it("changes nothing for ANOTHER reader of the same feed", async () => {
    /*
     * The property that makes this setting safe to wire at all: it is per
     * SUBSCRIPTION. `guidTrustOverride` next to it writes the shared `feeds`
     * row and is deliberately not forwarded, because one reader cannot change
     * how a feed behaves for everyone.
     */
    await prisma.user.create({
      data: { id: OTHER, email: `${OTHER}@example.invalid`, name: "Other" },
    });
    /*
     * OTHER STARTS AT `false` AND THE ACTION WRITES `true`, which is the only
     * arrangement that can fail. The first version had OTHER at `true` and the
     * action writing `true` — so dropping `userId` from `editSubscription`'s
     * `where`, the exact leak this is named for, still left OTHER at `true` and
     * the assertion passed. A test whose expected value equals what the bug
     * would write proves nothing.
     */
    await prisma.subscription.create({
      data: { userId: OTHER, feedId: BigInt(feedId), resurfaceOnRevision: false },
    });

    await setResurfaceOnRevision(null, formOf({ feedId: String(feedId), current: "false" }));

    expect(await read(sampleUser.id), "the acting reader's row should change").toBe(true);
    expect(await read(OTHER), "another reader's row must not").toBe(false);
  });

  it("RETURNS a message for a feed the reader does not follow", async () => {
    const result = await setResurfaceOnRevision(
      null,
      formOf({ feedId: "999999", current: "false" }),
    );

    expect(result).toEqual({ error: "You do not follow this feed." });
  });
});
