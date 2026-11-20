# Cadence — milestones

_A personal feed reader that shows each article once and keeps an unread count you can trust._

Progress tracker for the build: what has actually landed, and the decisions made along the way.
The plan is `docs/project-idea/20-personal-rss-reader/IMPLEMENTATION_PLAN.md`; the design answer is
`ARCHITECTURE.md` beside it. Read Appendix C (the data access boundary) before touching the service
layer — it is what makes the static-then-data build order safe.

**Last verified:** 2026-11-19 — M0 and M1 complete. `pnpm check` runs 53 unit tests; `pnpm test:e2e`
runs 1 browser test. No database, no ingestion, nobody signed in, and that is on purpose.

|     | Milestone                                        | Status  |
| --- | ------------------------------------------------ | ------- |
| M0  | The design system renders                        | ✅ done |
| M1  | Fixtures, async services, and the viewer         | ✅ done |
| M2  | The format core and the 30-feed corpus           | ☐ next  |
| M3  | The identity primitives                          | ☐       |
| M4  | The reader shell                                 | ☐       |
| M5  | Add a feed, saved, and the health screen         | ☐       |
| M6  | Schema and the constraints that enforce identity | ☐       |
| M7  | The ladder                                       | ☐       |
| M8  | Revisions and learning that a feed lies          | ☐       |
| M9  | The resumable sweep                              | ☐       |
| M10 | Adaptive intervals, backoff, real health         | ☐       |
| M11 | Accounts, subscriptions, per-user read state     | ☐       |
| M12 | Discover, save, and the manual merge             | ☐       |
| M13 | Full-text extraction and the image proxy         | ☐       |
| M14 | Budgets, etiquette, and accessibility            | ☐       |
| M15 | Deploy                                           | ☐       |

---

## M0 — The design system renders ✅

Scaffolded Next.js 16 + React 19 + Tailwind v4 (CSS-first, no `tailwind.config.js`) + shadcn/ui, and
ported the prototype's tokens from `hallmark/tokens.css`, `base.css` and the app layer of `app.css`.
The three faces are self-hosted through `next/font` — no CDN request at runtime.

`src/app/page.tsx` is a specimen sheet, not a product screen. It exists so the port can be checked
against `hallmark/index.html` by eye. M4 replaces it with the three-pane reader.

**Two bugs the screenshot caught, that the build did not:**

- **Tailwind v4 tree-shakes unused theme variables.** `--spacing-3xs` and `--spacing-3xl` were never
  referenced by a utility, so they were not emitted, so `width: var(--spacing-3xs)` resolved to
  nothing and the swatch rendered full-width. Fixed with `@theme static`, which is the right setting
  for a design-system file generally: the prototype's CSS references tokens by `var()` throughout,
  and a token that silently disappears when the last utility stops using it is a trap.
- **shadcn's `accent` collides with Cadence's.** shadcn means "subtle interactive surface" (ghost
  hover, skeleton fill); Cadence means the orange signal used for selection, the caret and redlines.
  Bridging them painted every hover state and every skeleton orange. Cadence has no accent
  _surface_ — it has `paper-2` — so the four shadcn components that wanted `bg-accent` were rewritten.
  **Re-adding one of those components with the shadcn CLI will reintroduce `bg-accent`; grep for it
  after any `shadcn add`.**

## M1 — Fixtures, async services, and the viewer ✅

The step that decides whether phase 1 is a head start or a rewrite. Three things landed in their
final shape even though nothing they talk to exists yet: the types, the service signatures, and the
viewer argument.

- `src/lib/types.ts` — the vocabulary, named after Appendix D rather than after the prototype.
- `src/lib/fixtures/` — a read-only typed module ported from `hallmark/data.js`, deep-frozen so a
  pane that tries to mutate it fails loudly instead of appearing to work and losing the write.
- `src/lib/server/article-service.ts` — `listSubscriptions`, `listArticles`, `getArticle`,
  `getFeedHealth`, `listFolders`. Every one `async`, every one viewer-first.
- `src/lib/server/viewer.ts` — `getViewer()` and `assertCan()` against a near-empty denial table.
- `src/lib/server/mutations.ts` — every write declared, throwing `NotImplementedInStaticPhase` with
  the endpoint it will use, which is what the prototype's "nothing was sent" receipts display.

**Three decisions worth recording:**

- **`folderId` and `subscribedAt` moved from the feed to the subscription.** The prototype hung both
  off the feed. Appendix D puts them on `subscriptions`, because a feed row is shared by every reader
  and a following is private. Leaving them would have encoded one reader's filing into a shared row —
  the exact mistake the data model exists to prevent.
- **`discoverFeeds` takes the viewer**, unlike Appendix C's sketch of `discoverFeeds(url)`. §3
  requires a session and a rate limit on that route, and both need to know who is asking. One rule
  for every function in the layer beats one exception.
- **`listFolders` was added** — Appendix C does not name it, but the sidebar needs the folder tree
  and inventing a second data path for it later would break the seam.

### Review round on M0 + M1

Eight findings, all fixed. Four were invisible to `pnpm build`, `typecheck`, `lint` and the tests —
they were found by grepping the **emitted** stylesheet and by looking at a screenshot, which is why
both are worth doing before calling a design-system milestone done.

| Fix                                                                                      | Why it mattered                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scroll-padding-top: --spacing(3xl)` → `var(--spacing-3xl)`                              | Tailwind's `--spacing()` takes a multiplier, so this compiled to `calc(var(--spacing) * 3xl)` — invalid, silently dropped, and every anchor target would have landed under the sticky bar                                                                     |
| Sonner's `var(--popover)`, `var(--popover-foreground)`, `var(--border)` → Cadence tokens | Those are shadcn's raw properties, which this project never declares. The bridge declares `--color-*`, a different name. An inline style at an undefined `var()` beats sonner's own default, so toasts rendered transparent — visible only when a toast fires |
| `bg-muted` → `bg-paper-2` in `tabs.tsx` and `table.tsx`                                  | The **same collision as `accent`**, missed the first time: shadcn's `muted` is a light surface, Cadence's `--color-muted` is the mid-dark _text_ ink. A default TabsList came out near-black with ~1.9:1 labels, and table row hover was a dark band          |
| `listFolders` and the folder scope now filter on `userId`                                | Folders are per-user (Appendix D). Both read every row, which is correct while one reader exists and leaks another reader's filing the moment M11 adds a second                                                                                               |
| `Folder` gained `userId` and `position`                                                  | It was missing two of Appendix D's four columns, which is what let the unscoped read typecheck                                                                                                                                                                |
| The unread-count test asserts equality, paging through every page                        | It used `toBeGreaterThanOrEqual`, so **any over-count passed** — exactly the drift the sidebar count must not have                                                                                                                                            |
| A foreign folder was added to the corpus                                                 | Without a row belonging to someone else, the new scoping test passes even when unscoped. Verified by reverting the fix: 2 tests fail, as they should                                                                                                          |
| Dropped `"use client"` from `table.tsx`                                                  | No hooks, no handlers, no client behaviour                                                                                                                                                                                                                    |

**Ballast vs designed fixtures.** Articles 101–134 each exist because a screen or a state needs them
(the duplicate pair at 123/124, the revision redline at 116, the gated teaser at 118, `blocked` at
133, `failed` at 134). Articles 200+ are generated ballast so the list exceeds one 50-row page.
Do not tidy the designed rows; a screen loses its only sample.

`blocked` and `failed` are **new** — the prototype boarded only `none`, `ok` and `thin`, but
Appendix D's enum has five values and §6.5 gives those two their own copy, so each needed a row or
its screen would render nothing.

---

## Settled, so it is not re-litigated

| Question                                                | Settled as                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Where does data come from in phase 1?                   | A read-only frozen module. **Never** a local store that pretends to persist.       |
| Are service functions async before there is a database? | Yes, all of them, from M1. Otherwise every call site changes in phase 2.           |
| Does a read need the viewer?                            | Yes. §2: there is no public reading surface, because every list is someone's list. |
| Is the unread count stored?                             | No, derived, until P2 — and the P2 counter ships with its reconciliation job.      |

## Open, and blocking M6

Appendix G questions 1 and 7 must be settled **before** the schema lands, because neither is
migratable afterwards: the global-articles shape, and whether a Google Reader-compatible sync API is
ever offered (it permanently constrains the article id format).
