"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/*
 * Cadence is a light-only design — the prototype declares `color-scheme: light`
 * and ships no dark palette — so the theme is pinned rather than read from
 * next-themes. Restore the hook if a dark palette is ever designed.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      /*
       * Cadence tokens, not shadcn's `--popover` / `--border`. Those are the
       * raw custom properties shadcn's own globals.css declares and this
       * project does not have — the bridge declares `--color-*` entries inside
       * `@theme`, which is a different name. A `var()` at a name nothing
       * defines resolves to nothing, and because this is an inline style it
       * beats sonner's own default: the toast would render transparent, which
       * is only visible when a toast actually fires.
       */
      style={
        {
          "--normal-bg": "var(--color-paper-hi)",
          "--normal-text": "var(--color-ink)",
          "--normal-border": "var(--color-rule)",
          "--border-radius": "var(--radius-card)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
