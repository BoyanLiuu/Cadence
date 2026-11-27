"use client";

import * as React from "react";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";

/*
 * A select whose OPEN STATE belongs to this design system.
 *
 * WHY A NATIVE `<select>` WAS NOT ENOUGH. Its closed state styles fine, and
 * its popup does not style at all — the operating system draws that, so on
 * macOS the folder list opened as a blue-highlighted system menu with rounded
 * corners, overlapping its own field, in the middle of a square, paper-and-ink
 * page. It read as a different application borrowing the window. No amount of
 * CSS reaches it; the only fix is not to use the native popup.
 *
 * IT STILL SUBMITS WITH THE FORM. `SelectPrimitive.Root` takes a `name`, and
 * Radix renders a hidden native select beside the trigger — so `<form
 * action={…}>` and the server action behind it are unchanged, and the control
 * keeps working for a keyboard and a screen reader. That mattered here: the
 * add-feed form posts to a server action, and a hand-rolled dropdown writing
 * to component state would have needed its own hidden input and its own
 * keyboard handling, which is how a custom select becomes a bug.
 *
 * STYLED FROM THE PROJECT'S TOKENS, not shadcn's defaults: square corners
 * (`rounded-[2px]`), `--color-rule` for borders, `--color-paper-hi` for the
 * surface, and `--color-paper-2` for the highlighted row, so the open list
 * looks like the rest of the app rather than like a component library.
 */

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        /*
         * `h-9`, THE PROJECT'S CONTROL HEIGHT. Measured across this dialog:
         * both inputs and both buttons are 36px, and this trigger was the only
         * 40px thing on it — so a select beside a text field read as a
         * different size of control.
         *
         * It was `h-10` because the native `<select>` this replaces was
         * `h-10`, which means `/add` has had the same 40-against-36 mismatch
         * since M5. Taking `h-9` fixes both screens rather than matching the
         * bug for consistency's sake.
         */
        "border-rule bg-paper-hi text-ink px-sm gap-sm flex h-9 w-full items-center justify-between rounded-[2px] border text-sm",
        "focus-visible:outline-focus data-[placeholder]:text-muted focus-visible:outline-2 focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        {/* The chevron is the affordance, so it is not announced twice. */}
        <ChevronDownIcon aria-hidden="true" className="text-muted size-4 shrink-0" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        /*
         * ABOVE THE DIALOG IT OPENS INSIDE. Portalled content leaves the
         * dialog's stacking context, so a list rendering BEHIND the modal that
         * opened it is the same class of bug in a new place.
         *
         * `z-[60]` and not `--z-modal`, because `ui/dialog.tsx` is shadcn's and
         * uses a literal `z-50` rather than this project's z tokens — so the
         * number that has to be beaten is 50, and naming a token that resolves
         * to 400 would look principled while being unrelated to the thing it
         * must sit on top of.
         */
        className={cn(
          "border-rule bg-paper-hi text-ink z-[60] max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-y-auto rounded-[2px] border shadow-[0_8px_24px_-8px_rgba(0,0,0,0.25)]",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-3xs">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "px-sm py-xs gap-sm text-ink relative flex cursor-pointer items-center rounded-[2px] text-sm outline-none select-none",
        "data-[highlighted]:bg-paper-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator asChild>
        <CheckIcon aria-hidden="true" className="text-ink size-3.5 shrink-0" />
      </SelectPrimitive.ItemIndicator>
      {/* Reserves the tick's width on every row, so choosing one does not
          shift the text of the others. */}
      <SelectPrimitive.ItemText asChild>
        <span className="data-[state=unchecked]:ml-0">{children}</span>
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
