# Cadence — milestones

_A personal feed reader that shows each article once and keeps an unread count you can trust._

Progress tracker for the build: what has actually landed, and the decisions made along the way.
The plan is `docs/project-idea/20-personal-rss-reader/IMPLEMENTATION_PLAN.md`; the design answer is
`ARCHITECTURE.md` beside it. Read Appendix C (the data access boundary) before touching the service
layer — it is what makes the static-then-data build order safe.

**Last verified:** 2026-11-21 — **M0–M6 complete, verified against real Postgres.** `pnpm check` runs
614 tests read-only; `pnpm test:db` runs all 622 including the 8 that WRITE. `pnpm test:e2e` runs 1
browser test. The app serves from the database, and `pnpm db:reset-cadence-schema && pnpm db:migrate
&& pnpm db:seed` rebuilds it from nothing. No ingestion and nobody signed in — that is still M7 and M11.

**Database:** the workspace's shared Supabase project, one schema per app. Cadence owns `cadence`
and touches nothing in `paste`, `hacker_news_clone` or `public`. `.env` is not committed; copy
`.env.example` and take both URLs from another app in the workspace, changing only `?schema=`.

|     | Milestone                                        | Status  |
| --- | ------------------------------------------------ | ------- |
| M0  | The design system renders                        | ✅ done |
| M1  | Fixtures, async services, and the viewer         | ✅ done |
| M2  | The format core and the 30-feed corpus           | ✅ done |
| M3  | The identity primitives                          | ✅ done |
| M4  | The reader shell                                 | ✅ done |
| M5  | Add a feed, saved, and the health screen         | ✅ done |
| M6  | Schema and the constraints that enforce identity | ✅ done |
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

## Gate decisions, settled before M6

The plan requires Appendix G questions 1 and 7 answered before the schema lands, because neither is
migratable afterwards.

**Q1 — global articles with per-user state, or per-user copies?** **Global.** Recorded rather than
reopened: §2 calls it "the single most important decision", and M1's fixtures, the service layer and
M3's global rung 2 are all built on it. Reversing it means rewriting ingestion and the reader
together. The accepted cost is that per-user customisation cannot alter a shared row, so filter
rules and scraper overrides apply at read time.

**Q7 — should other clients ever sync against this?** **No compatibility layer, and integer article
ids.** The architecture's own assumption, taken for a reason worth writing down: the constraint it
warns about — that third-party clients memorise ids and break when the format changes — only binds
once a client has actually synced, and none can before the API exists. So this stays free to change
right up until the day such an API ships, at which point the format in use is frozen. Choosing
opaque ids now would cost a column and care on every query to insure against something that may
never be built. If a Google Reader-compatible API is ever wanted, the id format is decided then.

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

## M5 — Add a feed, saved, and the health screen ✅ — Phase 1 complete

The last three surfaces. Every screen now exists on fixtures, and nothing touches a database.

**`discoverFeeds` became real**, as Appendix C specifies ("M5 pure, M12 networked"). Two deviations
from its one-line sketch, both forced: it takes the viewer, because §3 requires a session and a rate
limit; and it returns `DiscoveryResult` rather than `Candidate[]`, because an array cannot say
"already followed", "did not answer" or "that is not an address" — three of the four failure states
the screen is built around. A fourth branch, `invalid`, was added for a typo, so a reader who pasted
a sentence is told that rather than being sent hunting for a feed that was never the problem.

**The add-feed right rail is a requirement, not decoration** (Appendix E). "Trusted slowly" is
§6.1's `cleanPolls < 3` stated to the reader, and the health table's `New` state is the same fact
shown back — so a promise made on one screen is verifiable on another.

**Saved is its own surface, not a filter.** No sidebar, no three panes, ordered by when you saved
rather than when it was published. Building it as `?scope=saved` on the reader would have been less
code and the wrong product: the reader's whole frame is about what is NEW, and nothing in Saved is.

**The health table's hard part is the empty cells.** A feed never checked has no 304 ratio; a feed
whose items were all new has no collapse rate. Filling those with `0%` is not a blank but a LIE —
"0% collapsed" means items arrived and none were duplicates, while the truth is that nothing
arrived. On the one screen that exists to prove the dedup works, a plausible wrong number is worse
than an honest "None read".

### Review round on M5

Six findings, all fixed. Three mattered.

| Fix                                                             | Why it mattered                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firstParam` / `trimmedParam` normalise every query value       | `?q=a&q=b` is a URL anyone can send and Next delivers an **array** for it, so `.trim()` answered **500** on `/add`, `/`, and `/saved`. `/add` was the sharp case: its own input validation had just been hardened for exactly this, and the caller bypassed it by trimming first                                |
| The AppBar's "Add feed" button points at `/add`                 | It pointed at `/feeds/new`, which does not exist — **the only entry point to the screen this milestone built was a 404**                                                                                                                                                                                        |
| Saved pages through every saved article                         | The headline count, all three tab counts and the list came from one 50-row page, with `page.next` discarded and no pagination control. Latent at four fixture saves; a count that silently caps is the same class of lie as a stale unread count                                                                |
| `listTicks` moved behind the service boundary                   | The health page was the first route to import `lib/fixtures` directly, past Appendix C. M10 has to replace that read with a `fetch_log` query, and a page that imports fixtures cannot be swapped. The contract test now lists both reads added beyond Appendix C, so a third is a decision rather than a drift |
| The nav marks the screen you are on                             | It hardcoded "Reader" as current, which was wrong on the two new screens                                                                                                                                                                                                                                        |
| Dropped a stray `sr-only` span from inside each candidate label | It was being read as part of every radio's accessible name                                                                                                                                                                                                                                                      |

### Second review round on M5

Six findings, all fixed, and **the first was caused by the first round's own fix**.

| Fix                                                                           | Why it mattered                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normaliseParams` carries all six keys, and the query is trimmed in one place | The repeated-param fix rebuilt `ReaderParams` from five of its six keys and omitted `shortcuts`, so **every link on the page silently dropped it** — the exact failure `view-params.ts` was written to prevent, reintroduced by a fix for something else. And trimming the query only into a local meant `/?q=%20%20` rendered no search while emitting `q=++` into all 140 links             |
| The chosen candidate lives in the URL as `?feed=`                             | The preview was pinned to `candidates[0]` while the radio group was uncontrolled, so on the headline sample — which has two feeds — picking "Tidewater Letters: comments" still previewed the main feed **under a heading naming it**. A preview describing something other than what is selected is worse than none, on a screen whose whole job is showing you what you are about to follow |
| `AppBar`'s `current` defaults to `"none"`, not `"reader"`                     | Defaulting to reader reproduced the bug the prop was added to fix on any screen that forgot it — `/design` did. Marking nothing is unhelpful; marking the wrong thing is a lie about where you are                                                                                                                                                                                            |
| `/add` keeps its direct `sampleAddresses` import                              | **Not** taken. The reviewer flagged it as the same past-Appendix-C reach as `listTicks`, and the two differ: `listTicks` returns data M10 replaces with a real query, while the sample list is phase-1 scaffolding M12 **deletes**. Putting it behind the data boundary would imply a successor it does not have                                                                              |
| Corrected the test count and a finding count in this file                     | Both were wrong — recorded because a tracker nobody can trust is worse than none                                                                                                                                                                                                                                                                                                              |

**The normalisation moved into `normalise-params.ts`** for the same reason the state chooser did: a
pure function that has now been wrong twice, both times made untestable by living in an async Server
Component. Reverting either fix fails four tests. `app-bar.test.tsx` covers the nav, which had none.

## M6 — Schema and the constraints that enforce identity ✅

Applied, seeded and **verified against real Postgres**: 621 tests, zero skips. The app serves from
the database.

### What only showed up by connecting

Five problems, every one invisible to `typecheck`, `lint` and 588 passing tests. They share a cause
worth stating once: **`?schema=` is a Prisma concept the `pg` driver ignores**, so what a connection
can actually see and what Prisma thinks it can see are two different things.

| Problem                                                     | What it taught                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?schema=cadence` on **DATABASE_URL** made every query fail | With it, Prisma treats cadence as the connection's default and emits **unqualified** SQL, which then resolves against the driver's real `search_path` — `public, extensions` — and dies on `relation "feeds" does not exist`. Removed from the runtime URL, kept on `DIRECT_URL` for the migrate CLI. Exactly `paste`'s shape, which is why `paste` works |
| Every raw query needed `cadence.`                           | Prisma's **generated** queries know about `schemas = ["cadence"]`; `$queryRaw` and `$executeRawUnsafe` are passed through verbatim. The unread `LEFT JOIN`, the seed's `setval` block and the catalogue queries in two test suites all had to be qualified                                                                                                |
| `prisma migrate deploy` hung indefinitely over the pooler   | It created the tables, then stalled holding an advisory lock with `finished_at` still null — so the generated half applied and **the entire hand-written index block did not**. Applied through `pg` in one transaction instead, which is also the only way the whole file is atomic                                                                      |
| `prisma migrate diff` emitted unqualified DDL               | So the migration pins `SET search_path TO "cadence"` after `CREATE SCHEMA`. One line to audit rather than twenty-four prefixes to get right — and in a **shared** project, unqualified DDL without it lands in another app's schema or `public`                                                                                                           |
| `gin_trgm_ops` could not resolve                            | `pg_trgm` was not installed in the project at all. It goes into `extensions` (Supabase's convention, already on the default path) and the index qualifies the operator class, because `search_path` is pinned to `cadence` where a bare name finds nothing                                                                                                |

**And one that made the whole thing look fine when it was not:** vitest does not load `.env`, so all
31 database tests reported as **skipped** while a working database sat beside them. A skip reads as a
deliberate choice; it took noticing the count had not moved. `vitest.setup.ts` now imports
`dotenv/config`.

### What the tests now actually prove

Not "the schema compiles" but the claims themselves, against Postgres:

- Two articles with a **NULL guid** in one feed both insert — the case a plain unique index silently
  forbids, which would make feeds like Hacker News appear to stop publishing after one item.
- The same **non-null** guid in one feed is refused; the same guid in **different** feeds is not.
- The same `url_hash` in different feeds **is** refused, because rung 2 is global. That one
  assertion is the whole reason one wire story through six feeds becomes one row.
- `articles_guid`, `ua_unread` and `feeds_due` each carry their `WHERE` clause in `pg_indexes`, and
  `articles_url` is unique and contains no `feed_id`.
- **The parity seam passes**: both implementations return the same rows, in the same order, with the
  same derived unread counts, across eight scopes, three pages of keyset pagination and four search
  terms. That is Appendix C's phase-2 check, and it is the sentence M1 was written to make true.

RLS is on across all nine tables, confirmed in `pg_class`.

**The indexes are hand-written SQL, and that is the point of the milestone.** Prisma's schema DSL
cannot express a `WHERE` predicate on an index, and `prisma migrate diff` generated **none** of the
six indexes this design depends on — confirming the split is necessary rather than a preference.
They live below a banner in `migrations/0000_init/migration.sql`, which also records that
`prisma db push` is never safe on this schema because it would drop them.

The sharp one is `articles_guid`. Without `WHERE guid_hash IS NOT NULL` it is wrong twice: SQL treats
NULLs as distinct, so every feed publishing no `<guid>` gets unlimited duplicate rows; and the
upsert's `ON CONFLICT ... WHERE guid_hash IS NOT NULL` cannot infer the index, so it fails at
RUNTIME rather than at migration time. `constraints.test.ts` attempts both forbidden inserts and
requires the database to refuse them, and asserts the index DEFINITIONS carry their predicates —
because an index created without one passes every query test.

**Both service implementations now exist**, and that is Appendix C's design rather than a hedge: its
phase-2 check is "swap the service implementation back to fixtures and the UI must be identical",
which is only checkable while both answer the same questions. `article-service.ts` became a chooser;
nothing else in the codebase knows which it got. The default is Postgres when `DATABASE_URL` is set
and fixtures when it is not, so a clone with no Supabase project still runs every screen and the 561
tests that predate the schema.

**Three things the schema does that Appendix D did not say:**

- **`article_urls` stores the URL, not only its hash.** From M3's review: a digest cannot be
  re-derived, so a `norm_version` bump could never replay the alternates this table owns. They would
  go dead, the address would resolve to nothing, and the next poll would re-insert it — a migration
  meant to remove duplicates manufacturing them.
- **`feeds.last_error_text` was added.** Appendix D kept a code but no message, and the health screen
  shows "answered 200 with a web page (text/html), not a feed" — which is a sentence, not a code.
- **RLS is on with no policies on all nine tables.** The role Prisma connects as owns them and
  bypasses it, so app queries are unaffected while a leaked anon key reads nothing. Ownership is
  still an explicit service-layer filter; RLS is the backstop.

**Two bugs found while wiring it, both in code I had just written:**

| Bug                                                 | Why it mattered                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Prisma client was constructed at MODULE SCOPE   | Merely importing `db/client.ts` threw when `DATABASE_URL` was unset, which broke fixtures mode and three suites that have no database and are not supposed to need one. It is a Proxy now, resolved on first property access — a module that is imported must not demand configuration it may never use |
| `no-offset.test.ts` pointed at `article-service.ts` | That file is now only a chooser, so the keyset assertion passed **vacuously**. It checks both implementations by name                                                                                                                                                                                   |

The contract test caught two new exports as it is meant to — `listTicks` and `dataSource` — and both
are now listed deliberately rather than having drifted in.

### Review round on M6 — twelve findings, and the lesson is the count

Every one is fixed. The number is the point: **M6 is the first milestone whose central claim could
not be executed**, and twelve defects got through a clean `typecheck`, a clean `lint` and 573 passing
tests. Four would have failed on the first run against a real database, which is the only reason
they survived review at all.

**The three that were more than mistakes:**

| Fix                                                        | Why it mattered                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopeWhere`'s `feed` case now spreads `base`              | A `{kind:"feed"}` scope was **not restricted to the viewer's subscriptions** — it returned articles from any feed by id. RLS is bypassed by the owning role, so this filter is the authorization model, not a convenience. The fixture implementation returned `[]` for the same input, so the two silently disagreed                                                                                      |
| The unread count is §6.2's `LEFT JOIN`, written raw        | It had been "articles in the feed minus articles read", which materialised **every article id the reader had ever read** into an `IN (...)` list — unbounded, and broken outright past Postgres' 65,535 bind-parameter limit, on the query that runs on every sidebar render. It also asked the _complement_ of what `ua_unread` indexes, so the one index Appendix D added for this count was dead weight |
| `db:migrate` is `prisma migrate deploy`, not `migrate dev` | `migrate dev` diffs the schema against the migrations and its diff contains `DROP INDEX` for **all seven hand-written indexes**. The migration header warns about `db push` and the package shipped the equally destructive script beside it. Authoring a new migration is now `db:new-migration`, which is `--create-only`                                                                                |

**One canonical timestamp form.** `toISOString()` emits `...:00.000Z`; the fixtures emitted `...:00Z`
in two places and a hand-sliced third form in the ballast generator. `service-parity.test.ts`
compares timestamps as strings, because a string is what a component renders — so the seam test that
is **M6's entire stated deliverable** could never have passed, over a difference no reader could see.
`map.test.ts` now asserts the property over the whole corpus, and it is checkable with no database.

**The rest:** the seed left BIGSERIAL sequences at 1, so the first insert without an explicit id
would collide on the primary key — which is every constraint test and every future ingestion;
`today.failed` counted only transport errors, so every 404 and 503 was a success; `listTicks` read
`fetch_log` with no subscription join while `getFeedHealth` directly below it did it correctly;
`DATABASE_POOL_MAX=""` coerced to `max: 0`; and one of my own constraint tests asserted a rejection
its own comment said would not happen.

**Still unverified, and the most likely thing to need adjustment on first run:** the raw unread query
passes feed ids as `ANY(${feedIds}::bigint[])`. That is the standard `pg` pattern and PrismaPg sits
on `pg`, but BigInt array serialisation is exactly the kind of thing that works or does not, and
nothing here has proved which.

### Review round on M6's completion — eight findings

**The first was a fix I had already claimed to make.** The `feed` scope spread `base` and then set
`feedId` on the next line — and `base` contains nothing _but_ `feedId`, so the spread was overwritten
and the subscription filter the comment described did not exist. A reader could list articles from a
feed they do not follow. It survived because all twelve fixture feeds belong to the one fixture user,
so no test distinguished "subscribed" from "exists". It is scoped by the subscription relation now,
which cannot be overwritten by a later key.

**Two were safety problems with the shared project**, and both are the kind worth being strict about:

| Fix                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database tests split by what they DO, not by whether a database exists | Loading `.env` in vitest had quietly made `pnpm check` **create and delete rows in a project shared with `paste` and `hacker_news_clone`**. Reads — the parity seam, the catalogue and index-definition checks — still run in `pnpm check`. The 8 insert probes need `CADENCE_DB_WRITE_TESTS=1`, which `pnpm test:db` sets. A test that silently writes to something shared is how a neighbouring app's afternoon gets ruined |
| `db:reset` is gone, replaced by `db:reset-cadence-schema`              | `prisma migrate reset --force` drops every table it can see. In a shared project that has no safe use. The replacement is scoped to the one schema Cadence owns, and names every table it is about to drop before doing it                                                                                                                                                                                                    |

**And the portability fix turned out to be the hang fix.** `CREATE EXTENSION ... WITH SCHEMA
extensions` assumed a schema the migration does not create, and was a silent no-op when `pg_trgm`
already lived elsewhere — after which a hard-coded `extensions.gin_trgm_ops` could not resolve at
all. Naming `extensions` in the `search_path` instead and leaving both unqualified made the migration
portable to a plain Postgres **and made `prisma migrate deploy` stop hanging**, which had forced the
earlier hand-application through `pg`. The whole rebuild now runs through the committed scripts.

The rest: `.env.example` documented `DIRECT_URL` _without_ `?schema=cadence`, so a clone following it
would have put `_prisma_migrations` in `public` of the shared project; the seed's schema-stripping
regex ate the leading `?`, turning `?schema=cadence&sslmode=require` into a database named
`postgres&sslmode=require`; and `client-config.test.ts` tested a _copy_ of `poolMax` linked to the
real one by a source-substring match that prettier would have broken — `poolMax` is exported and the
test calls it.

**Still true and still worth knowing:** `db:new-migration` (`migrate dev --create-only`) diffs the
schema and will emit `DROP INDEX` for all six hand-written indexes. It creates without applying, so
nothing is lost — but any generated migration must have those lines removed and the hand-written
block re-appended before it is applied.

---

## M7 — The identity ladder ✅

The corpus ingests twice and the second pass inserts **zero**. Then every guid is replaced, every link
gains `?utm_source=test`, the scheme is downgraded to `http:`, and it still inserts zero — while a
genuinely new article still inserts one, so the suite is not vacuously green.

`src/lib/ingest/dedupe.ts` is §6.1 as code: rungs 1–3 in order, first match wins, with the writes in
`src/lib/db/queries.ts` arbitrated by constraints rather than by a prior `SELECT`.

### Four bugs the ladder only gives up under a real database

Each of these passed `typecheck`, `lint`, and a suite that was already green. None is reachable
without a Postgres holding real rows.

**Rung 3 never fired.** It lived in the `catch` of `upsertByUrl` — but when both the guid and the
address are new, the insert **succeeds**, so there is no exception to catch. That is the one case
§6.1 says rung 3 exists for. It is a lookup before the write now, batched per poll, because
`content_hash` is deliberately non-unique and so has no constraint to trip.

**Rung 1 did no lookup at all** on the single-item path, leaving the guid match to the upsert's
`ON CONFLICT` — which runs **last**, after rung 3. So a moved article whose body had not changed was
resolved by _content_, and `fetch_log` recorded a guid match as a content match. Two consequences,
neither cosmetic: `shouldFlagGuidUnstable` reads those counters, so a feed with perfectly stable guids
looked like one that had never matched on them; and because two articles may legitimately share a
title and opening text, rung 3 could merge into the **wrong row** ahead of the publisher's own
explicit claim. Both orderings are pinned now by `ORDER:` tests.

**Rung 2 could not see its own aliases.** When rung 1 merges two items sharing a guid, the second
item's address becomes an alias in `article_urls` — it is not any row's current `articles.url_hash`.
The global `articles_url` constraint therefore cannot catch a later item at that address, and it
inserted a duplicate. Two corpus fixtures did exactly that once their guids churned. Rung 2 always
consults `article_urls` now, which is also what makes a **moved** article keep answering to the
address a feed is still publishing.

**`revised` was silently near-always false**, and the shape that caused it looks right:

```sql
RETURNING (revised_at IS NOT DISTINCT FROM now()) AS revised
```

`revised_at` is `TIMESTAMP(3)`, so what is stored is rounded to the millisecond; `now()` carries
microseconds. The two match about once in a thousand polls. `revision_count` was being incremented by
SQL nobody could observe — and M8's revised badge reads this flag. It is read from the content hash
captured in a `before` CTE now, which is the thing that actually defines a revision.

### The cap said one thing and did another

N7's cap stops the flood from a bad CMS deploy, and the comment above it said merges still run,
"because they update articles that already exist". The code `continue`d past the whole item. So a
genuine revision arriving in the same poll as a flood was silently discarded. Only the **insert** is
refused now, reported back as `"capped"` and counted in a new `itemsCapped` — because "the cap was
hit" does not distinguish a feed that overshot by one from a CMS that republished four thousand
articles, and those want different responses.

### The table rung 2 needed and the schema did not have

Rung 2 is global, so one story through six feeds is **one row** — and `articles.feed_id` can then
only name the feed that got there first. Nothing recorded the other five arrivals, which broke two
things:

- §8's **"also in 2 feeds" panel**, one of the three copy rules §8 says carry the product's
  credibility: a collapsed article must say _what it collapsed against_, so the reader can verify the
  deduplication rather than trust it. A single `feed_id` cannot say that.
- **every feed-scoped list and every unread badge.** Filtering on `feed_id` hid an article from the
  second feed's own list, and counted the whole row against the first feed so the second's badge read
  0 beside a list that had unread articles in it. Dedup reading as an article going missing is
  exactly the cost Appendix G question 2 warns about.

`cadence.article_feeds (article_id, feed_id, first_seen_at)` records one row per arrival, written on
**every** resolution rather than only on inserts — the second feed to carry a story merges, so an
insert-only write would never record it. `scopeWhere` and the unread count both match on it now.
`articles.feed_id` still names the owning feed, so a merge never steals an article for the feed that
arrived second.

The migration is additive and backfills every existing article against its owning feed, because a
list that starts reading arrivals would otherwise make every pre-existing row invisible — a migration
meant to stop articles going missing being the thing that makes them go missing.

**Migration filenames are an ordering, not a label.** The first attempt was timestamped
`20261120234900`, which sorts _before_ the init migration's `20261121013320`, so from a clean schema
Prisma applied it **first** and it failed on a table that did not exist yet — leaving the schema with
two tables and a failed-migration record that blocks every later deploy. Recovered by dropping the
schema and renaming.

### A plan that carried hashes could not be applied

`applyMergePlan` is implemented, and writing it exposed a gap in the pure planner it consumes:
`MergePlanGroup` carried `urlHashes: string[]`. But a replayed alternate is a hash **no row holds
yet** — the executor has to `INSERT` it, and `article_urls.url` is `NOT NULL` precisely so the next
bump can replay it in turn. A plan carrying bare hashes cannot write those rows at all, which would
have made the column M3's review added unfillable by its only caller. It is
`addresses: { urlHash, url }[]` now.

The executor is **one transaction per group**, not one for the plan: a bump over a large table is
thousands of groups, and a single transaction would hold locks on most of `articles` and time out
against a pooled connection. Per-group is still atomic where it matters — a half-applied _group_ is
what leaves rows pointing at a deleted article — and stopping halfway is resumable by re-planning.
The read-state union uses `LEAST`, which ignores NULLs, so the merge can only ever **add** read state.

### What the ladder's tests actually prove

| Suite                   | The bug it catches                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `parse-twice.test.ts`   | A regression in `canonical-url.ts`, which writes a **permanent** duplicate no later fix removes on its own                      |
| `ladder-rungs.test.ts`  | A rung that silently never fires, and a rung firing **out of order** — plus `revised`, and that an edit never clears read state |
| `url-history.test.ts`   | The duplicate a moved article creates, and an address being silently stolen between articles                                    |
| `global-rung-2.test.ts` | Per-feed scoping creeping back into rung 2, and a collapse that records only one arrival                                        |
| `insert-cap.test.ts`    | The flood — and the merge that must still happen past the cap                                                                   |

`parse-twice` deliberately excludes `14-five-hundred-items.xml`. Its 500 items are six times the rest
of the corpus combined, which made the suite take eleven minutes **and** made the insert cap fire
inside the headline test — so "the second pass inserted nothing" would have been partly the _cap_
talking rather than the ladder. Volume is `insert-cap`'s subject; this suite's subject is variety.

Every database test here needs `CADENCE_DB_WRITE_TESTS=1` (`pnpm test:db`), because the Supabase
project is shared and `pnpm check` stays read-only. Timeouts are 180s and 600s, not 5s: each pass is
real round trips against a remote Postgres, and §6.4's own budget is 240s for twenty-five feeds.

### Review round on M7 — twelve findings, and eleven share one cause

**I applied the arrivals change to the list queries and not to anything that consumes their output.**
That is the whole shape of this round. Switching `scopeWhere` from `articles.feed_id` to
`article_feeds` was correct and left every surface downstream reading `feed_id` as though nothing had
moved — so the half-applied change was worse than not making it:

| Surface                      | What the reader saw                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getArticle`                 | Still authorized on the OWNING feed, so a row the list showed **returned null when opened**. Two queries each defensible alone; only the pair wrong              |
| The header's unread count    | Summed the sidebar's per-feed badges, so a story carried by two subscribed feeds counted **twice** — "2 unread" above a one-row list                             |
| Every row's label            | `feedTitleOf(a.feedId)` rendered **"Unknown feed"** on a row the reader was looking at, in one of their own lists                                                |
| The sidebar badge            | Counted the whole row against the first feed, so the second said **0 unread** beside a list with unread articles in it                                           |
| §8's "also in 2 feeds" panel | `toArticle` hard-coded `arrivals: null`, so the panel — **the stated reason the table exists** — rendered nothing in the database path while working in fixtures |

The count is now its own query (`countUnread`) rather than an addition at the call site, because
`EXISTS` over arrivals is distinct by construction. The label is `displayFeedId` in
`lib/article-feed.ts` — the owning feed when the reader follows it, else the earliest arrival they
do, falling back to the owner so a genuinely inconsistent article still surfaces as "Unknown feed"
rather than being papered over. And arrivals needed a `url` column: §8 asks the panel to strike
through the discarded URL parts, which is exactly what canonicalisation throws away, so without the
raw per-feed address the panel would show one address twice and prove nothing.

**One finding was a poll-aborting crash on every new feed.** The `upsertByUrl` fallback had no
error-type check at all. It was written as rung 3's fallback, but rung 3 became a pre-check before
the write — which left the fallback dead for its own case and live for a different one:
`upsertByUrl` conflicts on `url_hash`, so a URL collision is handled rather than thrown, and what
actually throws is `articles_guid`. That fires whenever a feed's guids are **not trusted** (rung 1
does not route, but the partial unique index does not know about trust) and an item repeats a guid
at a new address. The content lookup found nothing and rethrew, so one repeated guid cost the whole
poll for every feed with fewer than three clean polls. It resolves as rung "guid" now — the index is
the arbiter and the error is how it reports — and records the new address, which was the only
resolution path that did not.

**`applyMergePlan` had ~130 lines of hand-written SQL and zero tests.** The one test it had asserted
it threw `NotImplementedInStaticPhase`, and implementing it deleted that. Which is the worst
coverage shape for this particular function: it runs once per `NORM_VERSION` bump against rows people
have already read, and a mistake is not re-runnable. Three real bugs were sitting in it:

- **`progress` lost the furthest read position.** `UPDATE … FROM user_articles AS loser` with two
  losers joins twice and takes one unpredictably. Every test now uses a group with **two** losers,
  because one loser hides this entirely.
- **`was_read_at` was never carried**, so M8's resurface state went with the deleted losers. Root
  cause: the union was built from `MergePlanGroup.userState`, a type with no such field. It is
  aggregated from the ROWS now, which also fixes a worse latent problem — a plan applied long after
  it was made would have replayed a stale snapshot and discarded every read since.
- **A chained rehash could not be ordered.** `rehashOnly` means "no two rows want the same new
  hash"; it does **not** mean a row's new hash is free. `412: H1→H2` beside `907: H2→H3` is refused
  mid-migration, and a straight swap `H1↔H2` has no correct order at all. Vacating every row to a
  random hash first removes the question instead of answering it — safe as an intermediate because
  nothing resolves on `articles.url_hash`; rung 2 reads `article_urls`, which neither pass touches.

Also: the per-group transaction took Prisma's **5-second default**, and a group's write is one round
trip per replayed address plus five fixed statements against a remote Postgres. A dozen alternates
already exceeds it, and the timeout aborts mid-migration.

**And a comment cited a test that did not exist.** `article-service.db.ts` claimed
`scopes-authorization.test.ts` catches a subscription filter going missing. There was no such file.
It exists now, and it is not optional cover: all twelve fixture feeds belong to the one fixture user,
so **no fixture case distinguishes "subscribed" from "exists"** — and with RLS bypassed by the owning
role, the `where` clause is the only thing between two readers' data.

Two smaller ones: `arrivalsFor`/`arrivalCounts` were unscoped reads of a reader-facing fact with no
production caller, so they are **deleted** rather than kept for later — an unscoped read path in a
codebase whose authorization is the query filter is a bypass waiting for its first caller. And
`@@index([feedId])` in the schema had no counterpart in the migration, which creates
`(feed_id, article_id DESC)`; `db:new-migration` would have emitted a `DROP` for the real index and a
`CREATE` for a narrower one nothing wants.

Each fix was verified by reverting it and watching a named test fail — including the two rehash cases,
which fail with `duplicate key value violates unique constraint "articles_url"`.

---

## Settled, so it is not re-litigated

| Question                                                | Settled as                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Where does data come from in phase 1?                   | A read-only frozen module. **Never** a local store that pretends to persist.       |
| Are service functions async before there is a database? | Yes, all of them, from M1. Otherwise every call site changes in phase 2.           |
| Does a read need the viewer?                            | Yes. §2: there is no public reading surface, because every list is someone's list. |
| Is the unread count stored?                             | No, derived, until P2 — and the P2 counter ships with its reconciliation job.      |

## Open, and blocking M8

Appendix G **question 3 — does an edited article return to unread?** The architecture assumes **no**:
a revision badge and a preserved `read_at`, following NewsBlur. For changelogs, status pages and
"live" posts the opposite is clearly right, so the hedge is a per-feed `resurface_on_revision`
defaulting to off. The column and `was_read_at` both exist in the schema already; what is open is the
resurface toggle's behaviour, and the plan says settle it before writing it.

M7 made the question live rather than theoretical: `revised` reports correctly now, and
`revision_count` moves, so there is finally a real signal for a resurface rule to act on.

Questions 1 and 7 are settled above. Question 2 — cross-feed URL dedup — is settled as
yes-collapse, and M7 paid the cost it names: `article_feeds` exists so a collapse can be shown and
verified rather than reading as an article going missing.
