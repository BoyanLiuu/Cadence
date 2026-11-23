import type { Metadata, Viewport } from "next";
import { Geist, Hedvig_Letters_Serif, Sofia_Sans_Extra_Condensed } from "next/font/google";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

/*
 * next/font downloads and serves these from our own origin at build time, so
 * there is no request to a font CDN at runtime. The three faces are the
 * prototype's: a serif for display, Geist for body, and a condensed face for
 * the outlier numerals in the health table.
 */
const geist = Geist({
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  variable: "--font-geist",
});

const hedvig = Hedvig_Letters_Serif({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--font-hedvig",
});

const sofia = Sofia_Sans_Extra_Condensed({
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  variable: "--font-sofia",
});

export const metadata: Metadata = {
  title: { default: "Cadence", template: "%s · Cadence" },
  description:
    "Cadence is a personal feed reader that shows each article once and keeps an unread count you can trust.",
};

export const viewport: Viewport = {
  themeColor: "oklch(97.2% 0.006 215)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${hedvig.variable} ${sofia.variable}`}>
      {/*
       * NO ClerkProvider HERE, deliberately.
       *
       * `clerk init` put one in this layout, which wraps every route. Measured
       * on the running server, that made the reader request EIGHT scripts from
       * a remote `*.clerk.accounts.dev` origin plus two calls to Clerk's API —
       * on the surface that renders titles, summaries and extracted bodies
       * fetched from arbitrary publishers. §6.5's whole argument is that this
       * page gets the smallest attack surface in the product, and a
       * third-party script on it is the opposite of that.
       *
       * It buys nothing either: the provider exists to serve Clerk's own
       * CLIENT components, and no reading surface renders one. `auth()` and
       * `currentUser()` from `@clerk/nextjs/server` work with no provider at
       * all, which is how `getViewer()` will resolve the session — so the
       * account slot in the app bar stays server-rendered text.
       *
       * Scoped instead to `sign-in/layout.tsx` and `sign-up/layout.tsx`, the
       * only two routes that render `<SignIn />` and `<SignUp />`.
       */}
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="bottom-center" closeButton />
      </body>
    </html>
  );
}
