# The release gate

`pnpm gate` runs three suites. They are the project's irreducible correctness
claims, and all three **break silently** — which is the property that earns
them a gate of their own rather than a place in the 1 200 tests `pnpm check`
runs. A failure in any of these is not a regression to triage later; it is a
reason not to ship.

Promoted at M14, which is where §6.4's assertions were supposed to become
measurements.

## `parse-twice.test.ts` — one article, one row, forever

The whole corpus ingested twice, asserting the second pass inserts **0**. Then
every guid replaced, every link tagged, the scheme downgraded — still 0.

**Why it is silent.** Both failure directions are invisible and neither is
reportable (§6.1). Too loose and two articles collapse into one row: nobody
complains about an article they never saw. Too strict and one article becomes
two rows, one read and one unread, and the unread count starts lying — which is
the number §6.1 says the product's credibility rests on. A reader that says
_14 unread_ and shows you nothing new is dead, and it dies without an error.

## `sanitize.test.ts` — no extracted HTML executes

Zero surviving `<script>`, every `on*` attribute dropped, `javascript:` and
`data:` hrefs removed, `iframe` / `object` / `form` gone.

**Why it is silent.** §6.5 calls this the one failure in the project that is
_completely_ silent. A missed `<script>` renders perfectly, looks like nothing
happened, and executes in the session holding the Clerk cookie — which can
reach every mutation in the app. There is no screen on which this looks broken.

The N9 assertion is adversarial on purpose: the payload is
`<scr<script></script>ipt>…` followed by an unclosed `<script>`, because three
well-formed script elements are exactly what a regex stripper handles. Two
earlier versions of that case passed against an implementation this suite
exists to reject.

## `corpus-round-trip.test.ts` — the sanitiser does not eat the article

The whole seeded corpus through the real sanitiser, byte for byte unchanged.

**Why it is here**, and it was not in the plan's list of two: `sanitize.test.ts`
proves the hostile half, that a payload does not survive. The opposite failure
is just as real and much quieter — an allowlist too NARROW, a URL rewrite that
drops a link, a parser that reorders markup. Every one of those makes every
article slightly wrong, no security test notices, and nothing reports it. A
gate covering only one direction would have let that ship.

It also pins the exact element set the corpus exercises, so the gap — no `img`,
`a`, `blockquote`, `pre` or `table` yet — is visible on every run instead of
assumed.

## What this gate does NOT cover

- **Accessibility.** M14's axe and `prefers-reduced-motion` checks were cut;
  N13 is unverified. See `decisions.md` in the memo.
- **Keyboard shortcuts.** `j`/`k`/`o`/`m`/`s`/`r` (Appendix A item 17) were
  never built, and at M15 the affordance that advertised them was removed too.
  Nothing to gate, and now nothing claiming otherwise on screen.
- **Etiquette.** `pnpm audit:etiquette` talks to 20 real publishers and is run
  deliberately, never in CI — a job hitting them on every push is the thing
  §6.4 exists to prevent.
