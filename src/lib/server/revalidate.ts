import { revalidatePath } from "next/cache";

/*
 * Revalidation that cannot report a committed write as failed.
 *
 * SHARED BECAUSE IT WAS WRITTEN THREE TIMES. Every server action needs it and
 * each copy carried the same nine-line comment, which is three places for the
 * reasoning to drift from the code.
 *
 * It is a CACHE HINT: by the time it runs, the rows are written. That one fact
 * makes both obvious placements wrong, and this project shipped each of them:
 *
 *   INSIDE the action's `try`, its failure was caught and returned as "could
 *   not do the thing" — for something already done. The reader was told it
 *   failed and tried again.
 *
 *   OUTSIDE the `try`, its failure became a rejection, which the client
 *   reported as "nothing happened" — a stronger falsehood than the first.
 *
 * So it swallows, and logs: a stale sidebar is a nuisance that can be traced
 * here, while either alternative lies about whether the write happened.
 */
export function revalidateQuietly(path: string, type?: "layout" | "page") {
  try {
    if (type === undefined) revalidatePath(path);
    else revalidatePath(path, type);
  } catch (error) {
    console.error(`revalidatePath(${path}) failed; a screen may be stale`, error);
  }
}
