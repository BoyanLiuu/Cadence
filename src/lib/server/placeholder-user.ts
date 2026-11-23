/*
 * The marker that says "this `users` row has not met its Clerk session yet".
 *
 * `prisma/seed.ts` creates a row so a real signed-in account has subscriptions
 * to read, but it cannot know the name or address: only Clerk does, and writing
 * a personal address into a seed would put it in a public repository. So it
 * writes this marker and `viewer.ts` replaces it on the first authenticated
 * request.
 *
 * SHARED RATHER THAN SPELLED TWICE. It was spelled twice — in the seed and in
 * the viewer — and review pointed out that the same diff had just extracted
 * `CURRENT_PATH_HEADER` for exactly this reason. A string that two files must
 * agree on, where disagreement means a row that says "Signed-in reader" for the
 * life of the database and nothing failing to say so, is not a string to type
 * in two places.
 *
 * `.invalid` is reserved by RFC 2606, so the address cannot route and cannot
 * collide with a real one. It still has to satisfy `users.email`, which is NOT
 * NULL and UNIQUE — hence deriving it from the id rather than using a constant.
 */

const PLACEHOLDER_DOMAIN = "@placeholder.invalid";

/** The address to seed for a Clerk id whose session has not been seen yet. */
export const placeholderEmailFor = (userId: string) => `${userId}${PLACEHOLDER_DOMAIN}`;

/** Whether a row still carries the marker, and so needs resolving from Clerk. */
export const isPlaceholderEmail = (email: string) => email.endsWith(PLACEHOLDER_DOMAIN);
