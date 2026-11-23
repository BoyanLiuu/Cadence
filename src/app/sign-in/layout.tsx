import { ClerkProvider } from "@clerk/nextjs";

/*
 * The provider lives here, not in the root layout.
 *
 * `ClerkProvider` loads `clerk.browser.js` and `ui.browser.js` from the Clerk
 * instance's own origin, so wherever it renders, that origin is fetched. At the
 * root it rendered on every route — including the reader, which displays text
 * fetched from arbitrary publishers (§6.5). Scoping it to the two routes that
 * render Clerk's own components keeps every other page on our origin alone.
 *
 * Nothing else misses it. `auth()` and `currentUser()` from
 * `@clerk/nextjs/server` need no provider, so `getViewer()` resolves the
 * session server-side and the app bar prints the reader's name as text.
 *
 * Duplicated in `sign-up/layout.tsx` rather than hoisted to a shared parent:
 * the only common ancestor of `/sign-in` and `/sign-up` is the root layout,
 * which is the placement this exists to avoid. A route group could hold both,
 * and six lines twice is cheaper than a directory whose purpose needs
 * explaining.
 */
export default function ClerkUiLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>;
}
