/*
 * The one definition of how long a folder's name may be.
 *
 * SHARED BECAUSE IT IS ASSERTED TWICE. The field sets `maxLength` so a reader
 * cannot type past it, and the write checks it because a `maxLength` attribute
 * is a convenience and not a constraint — `/add`'s form posts without
 * JavaScript, and anything can post to a server action. Two copies of the
 * number is how the input and the error message come to disagree.
 *
 * In its own module rather than in `subscriptions.db.ts`, so the client
 * component can import it without pulling Prisma into the browser bundle.
 *
 * Long enough for a real folder name, short enough that the sidebar's column
 * never has to lay out a paragraph.
 */
export const FOLDER_NAME_MAX = 60;
