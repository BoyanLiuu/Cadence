"use server";

import { messageForActionError } from "@/lib/server/action-error";
import { listFolders } from "@/lib/server/article-service";
import { discoverFeeds } from "@/lib/server/mutations";
import { getViewer } from "@/lib/server/viewer";
import type { DiscoveryResult, Folder } from "@/lib/types";

/*
 * What the add-feed DIALOG needs that the page got from its URL.
 *
 * The `/add` page drives discovery with a search param: `?address=…` re-renders
 * the route and the server does the work. A modal has no address of its own, so
 * it asks for the same two things directly.
 *
 * AN ACTION AND NOT A ROUTE, by the rule this project settled at M11: a route
 * is for a machine caller, and this is a person pressing "Find feeds". It also
 * means the dialog needs no API client, no fetch wrapper and no second error
 * shape — the same `messageForActionError` that turns a stale session into a
 * redirect serves it.
 *
 * NEITHER OF THESE WRITES. Discovery is explicitly a read that fetches (§6.3,
 * "writes nothing"), and the folder list is a read. `subscribeToFeed` in
 * `subscribe.action.ts` is the write, and it is unchanged — the dialog submits
 * to exactly the action the page does, so there is one place a subscription is
 * created however a reader got there.
 */

export type FindFeedsState = { error: string } | { result: DiscoveryResult };

/** Resolves an address to validated candidates, for the dialog. */
export async function findFeeds(address: string): Promise<FindFeedsState> {
  try {
    const viewer = await getViewer();
    return { result: await discoverFeeds(viewer, address) };
  } catch (error) {
    /*
     * `discoverFeeds` answers its FOUR failure states as values rather than
     * throwing, so this catch is for the ones outside discovery: a stale
     * session, a viewer with no permission, a database that has gone away.
     * `messageForActionError` redirects the first two and returns a sentence
     * for the rest.
     */
    return { error: messageForActionError(error, "Could not look that address up.") };
  }
}

/**
 * This reader's folders, for the dialog's select.
 *
 * FETCHED WHEN THE DIALOG OPENS rather than threaded through `AppBar`. The bar
 * is rendered on six screens and none of the other five needs a folder list —
 * adding a required prop would have meant touching all six and their tests to
 * serve one of them. Fetching on open is also fresher: a folder created in
 * another tab is there.
 */
export async function foldersForDialog(): Promise<Folder[]> {
  try {
    const viewer = await getViewer();
    return await listFolders(viewer);
  } catch {
    /*
     * An empty list, not an error. The folder select is optional — "No folder"
     * is the default and a valid answer — so a reader who cannot be shown
     * their folders can still add a feed, which is the thing they came to do.
     */
    return [];
  }
}
