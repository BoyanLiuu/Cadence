import { createHash } from "node:crypto";

import { prisma } from "@/lib/db/client";
import { canonicalUrl } from "@/lib/ingest/canonical-url";
import type { Candidate, DiscoveryResult, Subscription } from "@/lib/types";

/*
 * Subscribing, filing and unsubscribing (§6.1, Appendix D).
 *
 * THE ONE DECISION THIS FILE EXISTS TO ENFORCE: a feed is SHARED and a
 * following is PRIVATE. Ten readers of one feed are ten `subscriptions` rows
 * over ONE `feeds` row, which is what makes a single fetch and a single dedup
 * run serve all of them (§6.1). Appendix D says the alternative — a feed row
 * per subscriber — is "not migratable after M6", so getting this wrong is not
 * a thing to fix later.
 *
 * The join is `url_hash`, not the address as typed. `https://x.example/feed`
 * and `http://www.x.example/feed/` are the same feed, and two readers who type
 * them differently must still land on one row — so the key is M3's
 * `canonicalUrl`, the same function rung 2 uses for articles.
 *
 * SUBSCRIBING WRITES NO `user_articles` ROWS. Unread is the absence of a row
 * (§6.2), so following a feed with 500 articles costs one insert rather than
 * 501. `lazy-user-articles` asserts it, because the eager version is the
 * obvious implementation and the table it produces grows as readers × articles.
 */

const sha256 = (value: string): Uint8Array<ArrayBuffer> => {
  // Annotated, because a bare `new Uint8Array(...)` is
  // `Uint8Array<ArrayBufferLike>` and Prisma's `Bytes` column wants
  // `ArrayBuffer`. `prisma/seed.ts` carries the same narrowing.
  const digest = createHash("sha256").update(value).digest();
  return new Uint8Array(digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.length));
};

/**
 * Rung 2's key for a feed address.
 *
 * NOT exported, and that is the point of `markFollowed` living in this file:
 * "already followed" asks the same question `addSubscription` answers, with no
 * second caller able to ask it differently. Both compare on this hash rather
 * than on the string, so a reader who pastes `http://www.x.example/feed/` is
 * told they already follow `https://x.example/feed` — which they do.
 */
function urlHashOf(feedUrl: string): Uint8Array<ArrayBuffer> {
  const key = canonicalUrl(feedUrl);
  // `canonicalUrl` refuses an address it cannot key. Hashing the raw string
  // keeps such a feed insertable and still unique, rather than dropping it.
  return sha256(key ?? feedUrl);
}

const toSubscription = (row: {
  userId: string;
  feedId: bigint;
  folderId: bigint | null;
  customTitle: string | null;
  fullTextMode: Subscription["fullTextMode"];
  resurfaceOnRevision: boolean;
  createdAt: Date;
}): Subscription => ({
  userId: row.userId,
  feedId: Number(row.feedId),
  folderId: row.folderId === null ? null : Number(row.folderId),
  customTitle: row.customTitle,
  fullTextMode: row.fullTextMode,
  resurfaceOnRevision: row.resurfaceOnRevision,
  subscribedAt: row.createdAt.toISOString(),
});

export class NoSuchFolder extends Error {
  constructor(readonly folderId: number) {
    super("That folder does not exist.");
    this.name = "NoSuchFolder";
  }
}

export class NotSubscribed extends Error {
  constructor(readonly feedId: number) {
    super("You do not follow this feed.");
    this.name = "NotSubscribed";
  }
}

/** Confirms a folder belongs to this reader, or refuses. `null` files nowhere. */
async function checkFolder(userId: string, folderId: number | null | undefined) {
  if (folderId === null || folderId === undefined) return;

  /*
   * SCOPED BY OWNER, and this is the per-row check for folders. `folder_id` is
   * a foreign key, so the database would accept SOMEBODY ELSE'S folder id
   * happily — the row would be valid and the reader's feed would vanish into a
   * folder they cannot see. Appendix D puts `user_id` on `folders` so this
   * question has an answer.
   */
  const folder = await prisma.folder.findFirst({
    where: { id: BigInt(folderId), userId },
    select: { id: true },
  });
  if (folder === null) throw new NoSuchFolder(folderId);
}

/*
 * Hashes compare as hex, not as bytes: two `Uint8Array`s with the same contents
 * are never `===`, so a `Map` keyed on the arrays matches nothing and every
 * candidate would read as unfollowed.
 */
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Marks which discovered candidates this reader already follows (§6.3).
 *
 * THE ONLY PART OF A DISCOVERY THAT DEPENDS ON WHO IS ASKING — everything else
 * is a fact about the address — which is why it lives here and not in
 * `discoverAt`. Matched on `url_hash`, the key `addSubscription` upserts on, so
 * "already followed" means exactly "the row you would get already exists": a
 * reader who pastes `http://www.x.example/feed/` is told they already follow
 * `https://x.example/feed`, which they do.
 *
 * PER CANDIDATE, AND THE WHOLE RESULT ONLY WHEN EVERY ONE IS FOLLOWED. This
 * was a `findFirst`, which answered `following` as soon as ANY candidate
 * matched — so a site advertising a main feed and a comments feed became "you
 * already follow this feed · Open it" the moment the main one was followed,
 * with no way left to add the comments feed. The dead end was invisible on a
 * single-feed address, which is the only shape it was tried on.
 */
export async function markFollowed(
  userId: string,
  candidates: Candidate[],
): Promise<DiscoveryResult> {
  if (candidates.length === 0) return { kind: "found", candidates };

  const hashes = candidates.map((candidate) => urlHashOf(candidate.feedUrl));
  const hashOf = new Map(candidates.map((candidate, i) => [candidate.feedUrl, hex(hashes[i]!)]));

  const mine = await prisma.subscription.findMany({
    where: { userId, feed: { urlHash: { in: hashes } } },
    select: { feedId: true, feed: { select: { urlHash: true } } },
  });
  if (mine.length === 0) return { kind: "found", candidates };

  const followed = new Map(mine.map((row) => [hex(row.feed.urlHash), Number(row.feedId)]));
  const feedIdOf = (candidate: Candidate) => followed.get(hashOf.get(candidate.feedUrl)!);

  const marked = candidates.map((candidate) =>
    feedIdOf(candidate) === undefined ? candidate : { ...candidate, following: true },
  );

  // Every candidate followed is §6.3's case: one address, one feed, already in
  // the reader. The id is the one to open.
  if (marked.every((candidate) => candidate.following === true)) {
    return { kind: "following", feedId: feedIdOf(candidates[0]!)! };
  }

  return { kind: "found", candidates: marked };
}

/**
 * Follows a feed, creating the shared `feeds` row only if nobody has it yet.
 *
 * `next_fetch_at` IS SET TO NOW, and leaving it out was a bug that made the
 * whole feature inert: the column is nullable with no default, and
 * `claimDueFeeds` selects `next_fetch_at <= now()` — NULL matches nothing, so a
 * newly followed feed would never be claimed, never polled and never deliver an
 * article. Subscribing would appear to work and nothing would ever arrive.
 *
 * The title is the ADDRESS as a placeholder, because `feeds.title` is NOT NULL
 * and M11 has no validating fetch to ask the publisher (that is M12's
 * `discoverFeeds`). The first poll replaces it. Showing the reader their own
 * URL until then is honest; inventing a name from the domain would not be.
 */
export async function addSubscription(
  userId: string,
  feedUrl: string,
  folderId: number | null = null,
): Promise<Subscription> {
  await checkFolder(userId, folderId);

  const urlHash = urlHashOf(feedUrl);

  /*
   * UPSERT ON `url_hash`, which IS the sharing. `create` would fail the second
   * reader with a unique violation; `upsert` gives both the same row.
   *
   * `update: {}` on purpose: the existing row belongs to everyone who follows
   * it, and a new subscriber has no business rewriting its title, interval or
   * failure state. The poller owns those.
   *
   * The `catch` is for the race `upsert` does not close — two readers adding
   * the same new feed at once, where one loses on `feeds_url_hash_key`. Reading
   * the row back is the correct answer: it exists, which is all this needed.
   */
  const feed = await prisma.feed
    .upsert({
      where: { urlHash },
      update: {},
      create: {
        feedUrl,
        urlHash,
        title: feedUrl,
        format: "unknown",
        nextFetchAt: new Date(),
      },
    })
    .catch(async (error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
      return prisma.feed.findUniqueOrThrow({ where: { urlHash } });
    });

  /*
   * IDEMPOTENT, as ARCHITECTURE's Writes table specifies: "a duplicate
   * subscription returns the existing one". An earlier version threw instead,
   * which diverged from the design and would have made the add screen 500 on
   * its commonest outcome — someone adding a feed they already follow. The
   * "already followed" state belongs to DISCOVERY, which reports it before
   * anyone presses the button (§6.3).
   *
   * `upsert` rather than find-then-create, so a double-click cannot produce a
   * raw P2002 from the gap between the two.
   */
  const row = await prisma.subscription
    .upsert({
      where: { userId_feedId: { userId, feedId: feed.id } },
      // NOT re-filed. Returning the existing following means returning it as it
      // is; moving it to another folder is `editSubscription`'s job and a
      // different thing to ask for.
      update: {},
      create: {
        userId,
        feedId: feed.id,
        folderId: folderId === null ? null : BigInt(folderId),
      },
    })
    .catch(async (error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
      return prisma.subscription.findUniqueOrThrow({
        where: { userId_feedId: { userId, feedId: feed.id } },
      });
    });

  return toSubscription(row);
}

/** A Prisma unique violation, whatever it names. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/** Changes one reader's own view of a feed. Touches nothing shared. */
export async function editSubscription(
  userId: string,
  feedId: number,
  input: {
    folderId?: number | null;
    customTitle?: string | null;
    fullTextMode?: Subscription["fullTextMode"];
    resurfaceOnRevision?: boolean;
  },
): Promise<Subscription> {
  await checkFolder(userId, input.folderId);

  /*
   * `updateMany` WITH THE OWNER IN THE `where`, not `update` by id.
   *
   * `update({ where: { userId_feedId } })` would also be scoped, but the
   * pattern matters: every write here names the owner, so there is no shape in
   * this file where a feed id alone reaches a row. A count of 0 is "not yours
   * or not there", and the two are deliberately indistinguishable to the
   * caller — telling someone which feeds exist but are not theirs is a
   * disclosure nobody needs.
   */
  const data = {
    ...(input.folderId !== undefined
      ? { folderId: input.folderId === null ? null : BigInt(input.folderId) }
      : {}),
    ...(input.customTitle !== undefined ? { customTitle: input.customTitle } : {}),
    ...(input.fullTextMode !== undefined ? { fullTextMode: input.fullTextMode } : {}),
    ...(input.resurfaceOnRevision !== undefined
      ? { resurfaceOnRevision: input.resurfaceOnRevision }
      : {}),
  };

  /*
   * AN EMPTY `data` IS FINE, and this was checked rather than assumed. A PATCH
   * whose only field is one this layer drops — `guidTrustOverride` — leaves
   * nothing to set, and the worry was that `updateMany` would then report zero
   * rows and make this answer "you do not follow this feed" to someone who
   * does. It does not: Prisma reports the rows MATCHED, so ownership still
   * reads correctly. Measured by removing a guard written for it and watching
   * the test that would have caught it stay green.
   */
  const { count } = await prisma.subscription.updateMany({
    where: { userId, feedId: BigInt(feedId) },
    data,
  });
  if (count === 0) throw new NotSubscribed(feedId);

  const row = await prisma.subscription.findUniqueOrThrow({
    where: { userId_feedId: { userId, feedId: BigInt(feedId) } },
  });
  return toSubscription(row);
}

/**
 * Stops following a feed.
 *
 * THE FEED ROW SURVIVES, and so do the articles. Other readers may follow it,
 * and even if nobody does, the articles are global rows owned by the feed
 * (Appendix B) — deleting it would cascade away history that a re-subscribe
 * would then re-fetch. Reaping genuinely orphaned feeds is a separate job
 * nobody has asked for.
 *
 * The reader's own `user_articles` rows are left alone too: re-subscribing
 * should not resurrect everything they had already read.
 */
export async function removeSubscription(userId: string, feedId: number): Promise<void> {
  const { count } = await prisma.subscription.deleteMany({
    where: { userId, feedId: BigInt(feedId) },
  });
  if (count === 0) throw new NotSubscribed(feedId);
}
