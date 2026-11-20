# Cadence — milestones

_A personal feed reader that shows each article once and keeps an unread count you can trust._

Progress tracker for the build: what has actually landed, and the decisions made along the way.
The plan is `docs/project-idea/20-personal-rss-reader/IMPLEMENTATION_PLAN.md`; the design answer is
`ARCHITECTURE.md` beside it. Read Appendix C (the data access boundary) before touching the service
layer — it is what makes the static-then-data build order safe.

**Last verified:** 2026-11-20 — M0–M4 complete. `pnpm check` runs 478 unit tests; `pnpm test:e2e`
runs 1 browser test. No database, no ingestion, nobody signed in, and that is on purpose.

|     | Milestone                                        | Status  |
| --- | ------------------------------------------------ | ------- |
| M0  | The design system renders                        | ✅ done |
| M1  | Fixtures, async services, and the viewer         | ✅ done |
| M2  | The format core and the 30-feed corpus           | ✅ done |
| M3  | The identity primitives                          | ✅ done |
| M4  | The reader shell                                 | ✅ done |
| M5  | Add a feed, saved, and the health screen         | ☐ next  |
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

## M2 — The format core and the 30-feed corpus ✅

Four pure modules over bytes — `sniff`, `preclean`, `parse`, `normalize` — and a 30-body hazard
corpus in `test/fixtures/feeds/` with a `manifest.ts` recording what each body is supposed to do.
31 bodies, in fact — the review added one. Nothing calls any of it yet; M7 is the first caller.

**The corpus was written before the modules**, as the plan instructs, and it paid for itself twice on
the first run:

- **`05-bare-ampersand.xml` needed no repair at all.** fast-xml-parser tolerates a bare `&` and
  yields the correct value. The manifest said otherwise, so the _manifest_ was wrong — recorded in
  place rather than quietly deleted, because the fixture is what will catch a future swap to a
  strict parser.
- **`20-c0-control-chars.xml` exposed a real bug.** fast-xml-parser _accepts_ a `0x08` mid-title and
  carries it into the data. The repair pass only ran after a parse _failure_, so the control byte
  reached the article title — and rung 3's `content_hash`, where an invisible byte makes one article
  hash two ways. Control stripping is now unconditional: `sanitize()` before every first attempt,
  `repair()` only after a failure. That split is the corpus's doing.

**One deviation from the plan, and one deviation reversed:**

- **No `fast-xml-parser` as a direct dependency.** The plan calls for using it directly on the retry
  path. The retry instead re-parses through feedsmith after a string repair, which keeps ONE item
  mapping path rather than two — a second parser would mean a second set of field-precedence rules
  to keep in sync, which is the bug §6.3 exists to prevent.
- ~~**`xml:base` is read at feed level only.**~~ **Closed, not deviated.** The first write of this
  read only the feed-level base, on the grounds that a per-item base would mean widening `RawItem`.
  That reasoning was wrong about the stakes: `xml:base` nests, so an entry can narrow the feed's
  base, and a wrong URL is a wrong `url_hash` — rung 2's dedupe key. The cost is not a broken link,
  it is a duplicate reaching the reader, which is the one failure this whole project is organised
  against. `RawItem` gained a nullable `xmlBase`, `normalize` resolves an item's base against the
  feed's before resolving the URL against that, and
  `test/fixtures/feeds/31-entry-level-xml-base.xml` covers all three shapes (inherited, relative
  own, absolute own). Done now because `RawItem` has exactly one consumer today; after M7 the
  contract is expensive to widen.

### Review round on M2

Nine findings, all fixed, and they clustered in one place: **the repair pass, which only one corpus
body exercises.** Six were outright bugs in code the corpus barely touched.

| Fix                                                                            | Why it mattered                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closeUnclosedTags` now checks tag balance first and refuses self-closing tags | It closed `<description>A teaser with <em>markup</em></description>` at the `<em`, orphaning the rest — so a feed whose only defect was an unclosed `<language>` came back with **every description empty**. And `[^>]*` ate the trailing slash of `<link href="…"/>`, rewriting it to `…/></link>` and making a failing Atom feed _less_ parseable |
| `escapeBareAmpersands` and `closeUnclosedTags` skip CDATA                      | `Smith & Sons` inside CDATA is already valid; "repairing" it writes a literal `&amp;` into the article body and into the content hash                                                                                                                                                                                                               |
| RSS `isPermaLink` now tested as `!== false`                                    | **It defaults to `true` in RSS 2.0** and feedsmith leaves it undefined when absent. Testing `=== true` meant the commonest form in the wild — `<guid>https://…</guid>` with no `<link>` — produced **no URL at all**, leaving rung 2 nothing to key on                                                                                              |
| Atom URL no longer falls back to `links[0]`                                    | A podcast entry carrying only `rel="enclosure"` handed back the `.mp3` as the article URL, and therefore as rung 2's dedupe key                                                                                                                                                                                                                     |
| `resolveUrl` enforces an http/https allowlist                                  | Feed content is remote user input and this value lands in an `href`. `new URL()` resolves `javascript:` and `data:` perfectly happily — it is a parser, not a filter                                                                                                                                                                                |
| JSON sniffing falls back to a structural check                                 | The JSON branch did a full `JSON.parse`, so sniffing the first 1 KB of a 50 KB JSON Feed always threw and reported `unsupported`. Every JSON fixture was under 1 KB, so the corpus could not catch it                                                                                                                                               |
| Every `TextDecoder` construction is guarded                                    | Two branches built one unguarded, which on the Edge runtime throws straight out of `parse` — against its "nothing here throws" contract                                                                                                                                                                                                             |
| `precleaned` renamed `repaired`                                                | It meant "a repair was attempted", not "only parsed after a repair"                                                                                                                                                                                                                                                                                 |
| Dropped the unused `fast-xml-parser` dep                                       | Declared but never imported                                                                                                                                                                                                                                                                                                                         |

Each fix has a regression test in `repair.test.ts`, and each was verified by reverting the fix and
watching the test fail — including restoring the original `closeUnclosedTags` wholesale, which fails
three.

## M3 — The identity primitives ✅

`canonicalUrl()` (rung 2) and `contentHash()` (rung 3), plus the replay-and-merge planner. Appendix F
calls these the only files where a bug is silent and permanent, so they carry the heaviest coverage
in the project: 142 new tests for three functions.

Both failure directions are fatal and neither is reportable, which is why the negative cases get as
much weight as the positive ones:

- **too loose** — two articles collapse into one row, and the second is simply never shown. Nobody
  reports an article they never saw.
- **too strict** — one article becomes two rows, one read and one unread, and the sidebar starts
  lying. §6.1 names that as the thing that actually loses readers.

**The rule most easily got wrong**, per §6.1, is handled: the scheme is **dropped** from the key
rather than rewritten `http`→`https`, so a publisher's TLS migration does not re-publish their
archive. The architecture's six-variant worked example is reproduced verbatim as a test and collapses
to exactly two keys.

**The version guard works as the demo specifies.** Adding a tracking parameter without bumping
`NORM_VERSION` fails the build — verified by doing it. Both rungs are fingerprinted: the fingerprint
is derived from the exported rule data, so a hardcoded one fails too.

`db/merge.ts` is split at the line where the database starts, which is the same seam Appendix C draws
everywhere else. The **planner is pure and tested now** — grouping and the per-user state union are
the dangerous parts, and they are what §6.1 means by "write that merge function alongside the
normaliser, not when you first need it". The **executor throws `NotImplementedInStaticPhase`** and
lands at M6, with its five-step contract documented. It is the same operation M12's manual merge
needs, for a group of two.

### Review round on M3

Nine findings, all fixed. Four were silent data-corrupting bugs in exactly the code this milestone
exists to be careful about — which is the argument for reviewing even heavily-tested pure functions.

| Fix                                                                                       | Why it mattered                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripTags` only strips things that look like tags                                        | `/<[^>]*>/` ate everything between a `<` and the next `>`, so **"5 < 6 and the vote was 7 > 8" and "…was 9 > 8" hashed identically** — two different articles merged. Post-parse text is where it bites: XML decoding has already turned the author's `&lt;` into a real `<` |
| The query is read from the raw string, not `url.searchParams`                             | `searchParams` percent-DECODES, so re-emitting the pairs collapsed `?p=b%26q%3Dc` (one parameter containing `&q=c`) with `?p=b&q=c` (two parameters). Two addresses, one `url_hash`. `%2541` was also decoded twice                                                          |
| C0 controls are stripped AFTER entity decoding                                            | `&#0;` is an entity, so it survives M2's `sanitize` and decoded to a literal NUL — **forging the separator**, so `("a&#0;b","c")` and `("a","b&#0;c")` shared a digest. The comment claimed this was impossible                                                              |
| Unkeyable rows are bucketed under their existing hash                                     | They still occupy that `url_hash`. Setting them aside meant a plan could target the same hash and violate the UNIQUE index **mid-migration**, after earlier groups had already merged                                                                                        |
| Group `urlHashes` includes every member's current hash                                    | A loser's `url_hash` is the address a feed is publishing _now_. Without it the next poll resolves it to nothing and re-inserts — a migration meant to remove duplicates manufacturing them                                                                                   |
| `earliest()` compares instants, not strings                                               | `+02:00` sorts after `Z` as text while being the earlier instant, so a non-UTC offset picked the **later** read time and moved a read forward — breaking the only guarantee the merge has                                                                                    |
| Rung 3 gained `CONTENT_HASH_VERSION` and a fingerprint                                    | It had no version at all. Changing the entity table or the tag stripping invalidates every stored `content_hash`, with nothing failing and no record of which ruleset produced which row                                                                                     |
| Two tests compared a call with itself                                                     | Deleting the surrogate guard left them green                                                                                                                                                                                                                                 |
| The fingerprint-derivation test asserted only that a string substitution changed a string | True of any string, so a fully hardcoded fingerprint passed the whole suite                                                                                                                                                                                                  |

Every fix was verified by reverting it and watching a test fail.

### Second review round on M3

The nine fixes above were themselves unreviewed, so a second pass ran over them. Eight more findings,
all fixed. The first is the worst bug M3 had.

| Fix                                                                              | Why it mattered                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The fragment is KEPT when nothing else carries identity                          | §6.1 says strip the fragment, and taken literally that keyed **every item of a client-routed feed as `site.example`** — `#!/2026/11/one` and `/two` and the home page all alike. With `UNIQUE(url_hash)` as rung 2, only the first item of such a feed is ever stored and the rest is discarded forever. A deliberate narrowing of the rule: the fragment survives only when there is no path and no query |
| `knownUrls` holds ADDRESSES, not hashes, and is replayed through the new ruleset | A v1 digest cannot be re-derived, so carrying old hashes forward left them dead — after a bump, ingestion looks up v2 hashes and never matches a v1 one, the alternate address resolves to nothing, and the next poll re-inserts it. **Schema consequence for M6:** Appendix D's `article_urls` has no URL column and needs one, or a bump can never replay the alternates it owns                         |
| Named entities decode CASE-SENSITIVELY                                           | `&Eacute;` is É and `&eacute;` is é. The lookup lower-cased, so `CAF&Eacute;` hashed as `CAFé` — a different word                                                                                                                                                                                                                                                                                          |
| `CONTENT_HASH_FINGERPRINT` covers key=VALUE pairs                                | It fingerprinted only the entity NAMES, so changing a mapping passed the guard, the pinned fingerprint and the entity-free golden digest while changing every digest the function produces                                                                                                                                                                                                                 |
| `+` and `%20` in a query are reconciled                                          | In a query string `+` IS a space, so `?q=hello+world` and `?q=hello%20world` are one request. Left unreconciled, it contradicted the module's own goal                                                                                                                                                                                                                                                     |
| A trailing-dot FQDN is normalised                                                | `x.example.` and `x.example` are the same server to every resolver                                                                                                                                                                                                                                                                                                                                         |
| `&#X41;` decodes                                                                 | The regex accepted only a lowercase `x`, which also made a branch dead                                                                                                                                                                                                                                                                                                                                     |
| `UNRESERVED` is derived into the fingerprint                                     | It is rule data like the deny list; editing it changed keys without tripping the guard                                                                                                                                                                                                                                                                                                                     |

**Both fingerprints moved and neither version was bumped.** Not laziness — bumping would be worse.
A version number that was never used is a false history: someone tracing a duplicate in a year's
time who finds `norm_version` starting at 2 goes looking for the v1 rows and the v1→v2 merge that
produced them, and there are none. So version 1 means "the rules the first stored row was hashed
with", which is the only meaning that helps anybody. The reasoning is in
`norm-version.test.ts` beside the pinned value, where it will actually be read.

These rules changed three times during M3's own review, with no database in existence. **The moment
M6 creates the schema this exemption is gone** — every change to either ruleset then needs a version
bump and a migration, and that is the first thing to check when M6 starts.

## M4 — The reader shell ✅

The three panes, rendering from fixtures, and the first consumer of M1's service layer. `/` and
`/feed/[id]` share one `ReaderView`, because the prototype draws them identically and splitting them
would mean two places to keep the sidebar, the toggle and the pagination in step. The specimen sheet
moved to `/design`.

**The cursor lives in the URL** as `?before=<publishedAt>,<id>`, as the plan requires. The fixture is
a static array and component state would work just as well today — which is exactly why it was worth
doing now: M9 makes paging real, and if the cursor were React state the shape would change then, and
every deep link, reload and back-button press would behave differently before and after.

**`no-offset.test.ts` scans `src/lib/server` and `src/lib/db` for the word.** Its first run failed on
the _comments_ explaining why offsets are banned, so it strips comments before scanning — a guard
that forbids documenting its own rule gets the documentation deleted. It keeps string literals,
which is where real SQL lives, and has three tests proving the stripping did not defeat the check.

**The arrivals proof is computed, not written.** `url-redline.ts` derives the struck runs and the
"Set aside:" copy from the same rules `canonicalUrl` applies, so the design's signature panel cannot
drift from the function it illustrates. The one screen a reader consults when they doubt the unread
count is the worst place to be confidently wrong. `canonicalUrl` remains the authority on the key
itself; if the parts and the key ever disagree, the parts are wrong.

All five list states are designed rather than blank, and the ordering between them is load-bearing:
a `not_a_feed` feed with no articles says "this address stopped being a feed", not "nothing here
yet" — the first tells the reader something is broken, the second reads like a quiet week.

### Review round on M4

Seven findings, all fixed. **Three shared one root cause**, and it is the kind of bug a screenshot
cannot show: a bare `href="?article=12"` replaces the WHOLE query string, so every reader link
silently reset the view.

| Fix                                                                           | Why it mattered                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/view-params.ts` merges into the current params instead of replacing them | Opening a row from "All articles" landed in "All unread" where that article is not listed, so **the row the reader clicked appeared to vanish**. The Older link was worse: it applied a cursor taken from one result set to a different one, making every read article older than the cursor unreachable. The toggle and the search form navigated out of a folder |
| `hrefForNewResultSet` drops the cursor and the open article                   | A keyset cursor is only meaningful for the rows it came from; carried across a scope or search change it points at rows that may not exist                                                                                                                                                                                                                         |
| `not-a-feed` formats its own ISO instants                                     | `/feed/4` rendered "as of 2026-11-09T11:02:00Z". The unit test passed `"9 Nov"`, so it stayed green while the real caller was wrong — the test now passes ISO and asserts the formatting                                                                                                                                                                           |
| An unsubscribed feed or unknown folder is a 404                               | `/feed/9999` fell through to the global empty state and showed the **account-wide** unread total under a feed heading. Not an empty view, a wrong one — and indistinguishable from an unsubscribe having emptied a real feed                                                                                                                                       |
| The redline separator is positional                                           | Consecutive struck parameters each got a `?`, rendering `…?utm_source=lowland?utm_medium=rss` on the arrivals panel                                                                                                                                                                                                                                                |
| Sidebar links carry scope and search, not the page                            | The mirror of the first bug, on the other pane                                                                                                                                                                                                                                                                                                                     |
| Dropped an unused date helper                                                 | The only lint warning, and the formatter the `not-a-feed` state was missing                                                                                                                                                                                                                                                                                        |

Every link fix is asserted in `view-params.test.ts` and was confirmed against a running server, not
just in unit tests — the bugs were in the composition of real hrefs, which is where unit tests on a
component's props do not reach.

### Second review round on M4

Nine more findings, all fixed. **Two were consequences of the first round's own fixes**: the 404
guard did not cover the empty page a cursor produces, and the separator fix handled only one of the
two directions.

| Fix                                                                  | Why it mattered                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An empty page reached through a cursor is `past-end`, not `all-read` | `/?before=<old cursor>` rendered "Nothing unread in any feed" under a heading reading "All unread / **81 unread**" — the same wrong-view failure the route 404s for, reached by a different path                                                                                                                                                                            |
| The next-check line is drawn from the SCOPED feeds                   | The Essays view announced "The next is Harbour Wire", a feed in News                                                                                                                                                                                                                                                                                                        |
| `strictId` replaces `Number.parseInt` for every id in a URL          | `parseInt` stops at the first non-digit, so `/feed/12abc`, `/feed/0012` and `/feed/12.9` all returned 200 and rendered feed 12. **One feed with unlimited URLs is one article with unlimited addresses** — the problem this project is organised against. `?article=101abc` also opened 101 while no row was marked current, because the strings differ while the ids match |
| Folders get `aria-current`, and "All unread" resets the scope        | On `/?folder=2` nothing in the sidebar was marked current at all. And from "All articles" the link labelled "All unread" led to `/?scope=all` — a page headed "All articles" — while still being marked as the current view                                                                                                                                                 |
| The redline separator is computed per run, in both directions        | A struck run keeps its positional separator so a run of tracking tags reads as the `?a=1&b=2` the publisher sent; a surviving parameter owns `?` only if it is the first survivor. The previous fix got the first case right and left `…?ref=x&id=5` rendering as `x.example/a&id=5`                                                                                        |
| "Also in N feeds" counts DISTINCT feeds                              | It counted arrivals. Latent today — the fixture's arrivals all use distinct feeds — and wrong the moment M7 generates them                                                                                                                                                                                                                                                  |
| The arrivals-proof key falls back to the address                     | `canonicalUrl` can return null, and the panel rendered it unguarded beneath "The same key N times"                                                                                                                                                                                                                                                                          |

**The state-selection logic moved out of the route component** into
`src/app/(reader)/choose-list-state.ts`. Two of these nine bugs lived there and neither was
reachable from a component test, because the choosing happened inside an async Server Component —
so every branch rendered a page that looked finished. As a pure function it is a table of cases with
17 tests, and reverting either fix now fails three of them.

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
