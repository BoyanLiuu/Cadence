import { afterAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import { sampleUser } from "@/lib/fixtures";

/*
 * `revalidatePath` needs a request context that no unit test has, and it is a
 * cache hint rather than behaviour under test here. Mocked so the action's own
 * logic is what runs — and the action is written so that a failure in it could
 * not be reported as a failed subscribe anyway.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { subscribeToFeed } from "./subscribe.action";

/*
 * What this suite is for: the form's own translation layer.
 *
 * `subscriptions.test.ts` covers what subscribing DOES. This covers the part
 * between a browser form and that function, which is where a different class of
 * bug lives: a `<select>` whose "No folder" option has an empty value, a
 * checkbox that posts nothing when unticked, a number that arrives as a string.
 * None of it is visible from either side alone.
 *
 * `redirect()` THROWS, which is how Next implements it — so a successful call
 * here rejects with Next's own redirect error, and that rejection IS the
 * success assertion. Getting a returned `{ error }` instead means the action
 * failed.
 *
 * WRITES, so `CADENCE_DB_WRITE_TESTS=1`. It subscribes the FIXTURE reader,
 * because that is who `getViewer()` resolves to in tests, and removes the feeds
 * it creates. It never touches a seeded feed.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Next's `redirect` signals by throwing; this recognises that throw. */
const isRedirect = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  String((error as { digest?: unknown }).digest ?? "").startsWith("NEXT_REDIRECT");

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
};

describeDb("the /add form's subscribe action", () => {
  const urls: string[] = [];
  const address = (label: string) => {
    const url = `https://action-${label}-${RUN}.example/feed`;
    urls.push(url);
    return url;
  };

  afterAll(async () => {
    const feeds = await prisma.feed.findMany({
      where: { feedUrl: { in: urls } },
      select: { id: true },
    });
    const ids = feeds.map((f) => f.id);
    await prisma.subscription.deleteMany({ where: { feedId: { in: ids } } });
    await prisma.folder.deleteMany({ where: { name: { startsWith: `Action ${RUN}` } } });
    await prisma.feed.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("follows the feed and redirects, rather than returning an error", async () => {
    const url = address("happy");

    await expect(subscribeToFeed(null, formOf({ feedUrl: url, folderId: "" }))).rejects.toSatisfy(
      isRedirect,
    );

    const feed = await prisma.feed.findFirstOrThrow({ where: { feedUrl: url } });
    expect(
      await prisma.subscription.count({
        where: { userId: sampleUser.id, feedId: feed.id },
      }),
    ).toBe(1);
  });

  it('reads "No folder" as no folder, not as folder zero', async () => {
    /*
     * The `<select>`'s own option value is `""`. `Number("")` is 0, so the
     * obvious conversion files the feed into folder zero — a folder id that
     * does not exist, and a foreign key error on what the reader meant as
     * "leave it loose".
     */
    const url = address("no-folder");
    await expect(subscribeToFeed(null, formOf({ feedUrl: url, folderId: "" }))).rejects.toSatisfy(
      isRedirect,
    );

    const feed = await prisma.feed.findFirstOrThrow({ where: { feedUrl: url } });
    const row = await prisma.subscription.findUniqueOrThrow({
      where: { userId_feedId: { userId: sampleUser.id, feedId: feed.id } },
    });
    expect(row.folderId).toBeNull();
  });

  it("applies the custom title, which subscribing itself does not take", async () => {
    // Documented arguments to subscribing are `{ feedUrl, folderId? }`, so the
    // sidebar name is a second call. If that call were dropped the field would
    // silently do nothing.
    const url = address("titled");
    await expect(
      subscribeToFeed(null, formOf({ feedUrl: url, folderId: "", customTitle: "My name for it" })),
    ).rejects.toSatisfy(isRedirect);

    const feed = await prisma.feed.findFirstOrThrow({ where: { feedUrl: url } });
    const row = await prisma.subscription.findUniqueOrThrow({
      where: { userId_feedId: { userId: sampleUser.id, feedId: feed.id } },
    });
    expect(row.customTitle).toBe("My name for it");
  });

  it("RETURNS the message for an address that is not one", async () => {
    // Returned rather than thrown: a thrown action error reaches the client as
    // an opaque digest, and this is a thing the reader can fix in the field.
    const result = await subscribeToFeed(null, formOf({ feedUrl: "my favourite blog" }));

    expect(result).toEqual({ error: "That is not a feed address." });
    // And nothing was created for it.
    expect(await prisma.feed.count({ where: { feedUrl: "my favourite blog" } })).toBe(0);
  });

  it("RETURNS the message for a folder that is not the reader's", async () => {
    const theirs = await prisma.folder.create({
      data: { userId: "user_2someoneElse", name: `Action ${RUN} theirs`, position: 9 },
    });

    const result = await subscribeToFeed(
      null,
      formOf({ feedUrl: address("foreign"), folderId: String(theirs.id) }),
    );

    expect(result).toEqual({ error: "That folder does not exist." });
  });
});
