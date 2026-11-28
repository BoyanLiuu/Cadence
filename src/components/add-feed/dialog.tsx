"use client";

import { useActionState, useEffect, useState, useTransition } from "react";

import { findFeeds, foldersForDialog } from "@/app/add/add-feed.action";
import { subscribeToFeed } from "@/app/add/subscribe.action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Candidate, DiscoveryResult, Folder } from "@/lib/types";

import { FolderField } from "./folder-field";
import {
  CARD_BASE,
  CandidateBody,
  CandidatePreview,
  DiscoveryFailure,
  SelectionDot,
  cardTone,
} from "./candidate";

/*
 * Adding a feed without leaving the screen you are on.
 *
 * WHY A MODAL AND NOT THE PAGE. Adding a feed is an interruption of reading,
 * not a destination: you are in the reader, you want one more feed, and you
 * want to be back where you were. `/add` took the whole window for it and
 * returned you somewhere else.
 *
 * `/add` STAYS, and that is deliberate rather than leftover. It is a real URL
 * that survives a reload and can be shared, it works with no client JavaScript
 * at all — the form posts and the server renders the candidates — and the
 * dialog needs JavaScript by construction. A reader who follows a link to
 * `/add` still gets a working screen.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT IS GENUINELY DIFFERENT
 * ---------------------------------------------------------------------------
 * SELECTION. On the page the chosen candidate is in the URL, which is why a
 * choice there is shareable and survives a reload; the server re-renders the
 * matching preview. A modal has no address, so selection is component state
 * here. Everything else — the facts on the card, the preview, the four failure
 * states — is the same code, in `candidate.tsx`, because two copies of the
 * screen a reader decides on would drift.
 *
 * SUBSCRIBING IS THE PAGE'S ACTION, unchanged. `subscribeToFeed` validates,
 * writes, names the feed in a second call and redirects to the feed's own page
 * — so there is one place a subscription is created however a reader got
 * there, and the redirect takes the dialog away with it.
 */

export function AddFeedDialog() {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [looking, startLooking] = useTransition();

  const [subscribeState, subscribeAction, subscribing] = useActionState(subscribeToFeed, null);

  /*
   * FOLDERS WHEN THE DIALOG OPENS, not on every render of the bar. The bar is
   * on six screens; only this needs them. Fetching on open is also fresher
   * than a prop would be — a folder made in another tab is there.
   */
  useEffect(() => {
    if (!open || folders.length > 0) return;
    let live = true;
    void foldersForDialog().then((f) => {
      if (live) setFolders(f);
    });
    return () => {
      live = false;
    };
  }, [open, folders.length]);

  const candidates: Candidate[] = result?.kind === "found" ? result.candidates : [];
  const selected = candidates.find((c) => c.feedUrl === chosen) ?? candidates[0];

  function look() {
    if (address.trim() === "") return;
    setLookupError(null);
    startLooking(async () => {
      try {
        const state = await findFeeds(address);
        if ("error" in state) {
          setLookupError(state.error);
          setResult(null);
          return;
        }
        setResult(state.result);
        setChosen(null);
      } catch {
        /*
         * AN ACTION CAN REJECT AS WELL AS RETURN — the POST itself fails when
         * offline or on a 5xx, and then there is no value to read. The fifth
         * place in this project that has needed this exact handler; without it
         * the promise rejects unhandled and the button just stops spinning.
         */
        setLookupError("Could not reach the server. Nothing was looked up.");
        setResult(null);
      }
    });
  }

  /** A fresh dialog each time, so yesterday's search is not waiting in it. */
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setAddress("");
      setResult(null);
      setChosen(null);
      setLookupError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">Add feed</Button>
      </DialogTrigger>

      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-[42rem]">
        <DialogHeader className="px-lg py-md border-rule border-b">
          <DialogTitle className="font-display text-ink text-xl">Add a feed</DialogTitle>
          <DialogDescription className="text-ink-2 text-sm">
            Paste a feed&rsquo;s address or the site&rsquo;s own, and Cadence finds the feed.
          </DialogDescription>
        </DialogHeader>

        <div className="px-lg py-md gap-md grid">
          {/*
           * NOT A `<form>` AROUND THE LOOKUP. A nested form inside the
           * subscribe form below is invalid HTML and the browser drops one of
           * them; Enter is handled explicitly instead, which is the behaviour
           * the markup would have given.
           */}
          <div className="gap-2xs grid">
            <label htmlFor="dialog-address" className="text-sm font-medium">
              Feed or site address
            </label>
            <div className="gap-xs flex">
              <Input
                id="dialog-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    look();
                  }
                }}
                placeholder="example.com or example.com/feed"
                className="min-w-0 flex-1"
                autoFocus
              />
              <Button type="button" variant="outline" onClick={look} disabled={looking}>
                {looking ? "Finding…" : "Find feeds"}
              </Button>
            </div>
          </div>

          {lookupError !== null && (
            <p role="alert" className="text-error text-sm">
              {lookupError}
            </p>
          )}

          {result !== null && result.kind !== "found" && <DiscoveryFailure result={result} />}

          {result?.kind === "found" && (
            <form action={subscribeAction} className="gap-md grid">
              <input type="hidden" name="feedUrl" value={selected?.feedUrl ?? ""} />

              <p className="num text-sm font-medium">
                {candidates.length} {candidates.length === 1 ? "feed" : "feeds"} at this address
              </p>

              <div className="gap-xs grid">
                {candidates.map((candidate) => {
                  const checked = candidate.feedUrl === selected?.feedUrl;
                  return (
                    <button
                      key={candidate.feedUrl}
                      type="button"
                      onClick={() => setChosen(candidate.feedUrl)}
                      aria-pressed={checked}
                      className={`${CARD_BASE} ${cardTone(checked)} text-left`}
                    >
                      <SelectionDot checked={checked} />
                      <CandidateBody candidate={candidate} />
                    </button>
                  );
                })}
              </div>

              {selected && <CandidatePreview candidate={selected} />}

              {/*
               * `content-start` ON BOTH CELLS, which is the real alignment
               * bug rather than the control heights.
               *
               * The folder cell has TWO rows (label, select) and the name cell
               * has THREE (label, input, "leave it empty…"). The outer row is
               * as tall as the taller cell, and a grid's `align-content`
               * defaults to stretching — so the shorter cell shared the
               * leftover 12px among its own rows, and the "Folder" label grew
               * from 20px to 32px, carrying the select down with it.
               *
               * Measured: labels 32 against 20, control tops 641 against 629.
               * `content-start` keeps the rows content-sized, so both labels
               * and both controls begin on the same line.
               */}
              <div className="gap-md grid sm:grid-cols-2">
                <FolderField folders={folders} id="dialog-folder" />
                <div className="gap-2xs grid content-start">
                  <label htmlFor="dialog-title" className="text-sm font-medium">
                    Name in your sidebar <span className="text-muted">(optional)</span>
                  </label>
                  <Input id="dialog-title" name="customTitle" />
                  <p className="text-muted text-sm">
                    Leave it empty to use the feed&rsquo;s own name.
                  </p>
                </div>
              </div>

              {subscribeState !== null && "error" in subscribeState && (
                <p role="alert" className="text-error text-sm">
                  {subscribeState.error}
                </p>
              )}

              <Button type="submit" disabled={subscribing || selected === undefined}>
                {subscribing ? "Following…" : "Follow this feed"}
              </Button>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
