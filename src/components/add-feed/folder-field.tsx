"use client";

import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FOLDER_NAME_MAX } from "@/lib/folder-name";
import type { Folder } from "@/lib/types";

/*
 * Choosing a folder, or making one.
 *
 * WHY IT EXISTS: THERE WAS NO WAY TO CREATE A FOLDER AT ALL. `listFolders` had
 * been read by three screens since M1 and nothing in the app ever wrote a row —
 * only the test suite did, straight through Prisma. A reader with no folders
 * saw a select containing one option, "No folder", and no hint that folders
 * were a thing they could have.
 *
 * IN THE SELECT, because that is where the question comes up. Filing is the
 * only thing a folder does, and the two places one is chosen are this dialog
 * and `/add` — both mid-subscribe. A separate "manage folders" screen would be
 * a second surface to navigate to and come back from, to answer a question the
 * reader is already being asked.
 *
 * ONE COMPONENT FOR BOTH FORMS. `/add` and the dialog post to the same server
 * action, so the field they post has to be the same shape in both; two copies
 * of a control with a hidden input is how one of them silently stops sending
 * it.
 *
 * `newFolder` IS A SEPARATE FORM FIELD from `folderId`, not a magic value in
 * it. The action can then tell "file under folder 3" from "make one called
 * Essays" without parsing, and an empty `newFolder` is unambiguous — see
 * `subscribe.action.ts`, which prefers the name only when there is one.
 *
 * ---------------------------------------------------------------------------
 * THE COST IT CARRIES, moved here from `/add` along with the control itself
 * ---------------------------------------------------------------------------
 * `/add` works with no client JavaScript — the form posts and the server
 * renders the candidates — and a Radix select does not. With JavaScript off
 * the trigger renders and will not open, where a native `<select>` would have
 * worked. So that page keeps its no-JS FORM and loses its no-JS FOLDER: "No
 * folder" stays the default and the subscription still succeeds, which is the
 * part that matters.
 *
 * Creating a folder is in the same boat and one step worse — it needs the
 * reveal, so it is JavaScript-only outright. Worth stating rather than
 * discovering: before this control existed there was no way to create a folder
 * with JavaScript ON either, so nothing regressed; a no-JS reader is where
 * they were.
 */

/**
 * "No folder" needs a non-empty value, because Radix treats `value=""` as a
 * cleared selection and refuses it as an item value. The action maps anything
 * unparseable to `null`, and this string is spelled out so the mapping is
 * visible from both ends rather than hiding in a falsy check.
 */
export const NO_FOLDER = "none";

/** The sentinel that reveals the name field. Never sent as a `folderId`. */
const NEW_FOLDER = "new";

export function FolderField({ folders, id }: { folders: Folder[]; id: string }) {
  const [choice, setChoice] = useState(NO_FOLDER);
  const making = choice === NEW_FOLDER;
  const nameField = useRef<HTMLInputElement>(null);
  /* The value chosen, readable during the close — state has not committed yet. */
  const chosen = useRef(NO_FOLDER);

  /*
   * FOCUSING THE NAME FIELD TAKES TWO PARTS, and the first one is why.
   *
   * `autoFocus` was tried first and measured as doing nothing: Radix returns
   * focus to the select's TRIGGER when its list closes, and that happens after
   * this input mounts, so the attribute won a frame and then lost it. A
   * `requestAnimationFrame` focus lost the same race. The reader who had just
   * asked to type a folder name was left on the control they had finished with.
   *
   * So the hand-back is declined at source (`onCloseAutoFocus` below) and the
   * focus is taken here once the field exists. `preventScroll` because the
   * field is already in view, and scrolling a dialog to something visible is a
   * jump for no reason.
   */
  useEffect(() => {
    if (!making) return;
    nameField.current?.focus({ preventScroll: true });
  }, [making]);

  return (
    <div className="gap-2xs grid content-start">
      <label htmlFor={id} className="text-sm font-medium">
        Folder
      </label>

      {/*
       * `name` only when a real folder is chosen. With the sentinel selected
       * the select posts nothing, so the action never has to know `"new"`
       * exists — the presence of `newFolder` is the whole signal.
       */}
      <Select
        name={making ? undefined : "folderId"}
        value={choice}
        onValueChange={(next) => {
          chosen.current = next;
          setChoice(next);
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          /*
           * DECLINE THE FOCUS HAND-BACK when a name is about to be typed.
           * Radix's default is correct for every other option — you choose a
           * folder and you are done with the control — and wrong for this one,
           * where choosing it is a request to type into the field that appears.
           */
          onCloseAutoFocus={(event) => {
            if (chosen.current === NEW_FOLDER) event.preventDefault();
          }}
        >
          {/* FIRST, so it is the default — the page learned this the hard way:
              last made the reader's first folder the default and filed feeds
              somewhere nobody chose. */}
          <SelectItem value={NO_FOLDER}>No folder</SelectItem>
          {folders.map((folder) => (
            <SelectItem key={folder.id} value={String(folder.id)}>
              {folder.name}
            </SelectItem>
          ))}
          <SelectItem value={NEW_FOLDER}>New folder…</SelectItem>
        </SelectContent>
      </Select>

      {making && (
        <>
          {/*
           * NOT `required`: the action treats a blank name as "no folder"
           * rather than refusing the whole subscription, so a reader who
           * changes their mind and submits still gets the feed they asked for.
           */}
          <Input
            ref={nameField}
            name="newFolder"
            maxLength={FOLDER_NAME_MAX}
            placeholder="Essays"
            aria-label="New folder name"
          />
          <p className="text-muted text-sm">
            A folder you already have by this name is used rather than repeated.
          </p>
        </>
      )}
    </div>
  );
}
