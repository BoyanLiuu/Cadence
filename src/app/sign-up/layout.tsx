import { ClerkProvider } from "@clerk/nextjs";

/*
 * The provider lives here, not in the root layout. See
 * `sign-in/layout.tsx` for why — it is the same reason, and the two routes
 * have no common ancestor other than the root.
 */
export default function ClerkUiLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>;
}
