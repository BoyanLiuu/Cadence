import { ClerkProvider } from "@clerk/nextjs";
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
      <body>
        <ClerkProvider>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster position="bottom-center" closeButton />
        </ClerkProvider>
      </body>
    </html>
  );
}
