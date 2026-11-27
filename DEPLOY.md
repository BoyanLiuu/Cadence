# Deploying Cadence (M15)

## The tick is DAILY, and that is a decision rather than a limitation we forgot

Vercel's Hobby plan caps cron at **once per day** and **fails the deployment**
for anything more frequent — `0 * * * *` and `*/30 * * * *` are both rejected
at build time with "Hobby accounts are limited to daily cron jobs". It also
gives no timing guarantee: `0 7 * * *` fires somewhere between 07:00 and 07:59.

The alternative was a GitHub Actions schedule calling the same route, which is
what `.github/workflows/ping.yml` did until M15. It was deleted, not disabled:
a scheduled workflow left in the repo keeps firing on the default branch and
fails every run once its secrets are absent, so "disabled" would have meant a
permanent stream of failure mail. The reasoning is in the memo's
`decisions.md`, and it reverses Appendix G question 4.

**What daily costs, stated so nobody has to rediscover it:**

- Feeds are read once a day. §6.4's adaptive curve still computes a per-feed
  interval and `next_fetch_at` still carries it, but with a daily tick every
  feed is effectively daily — so `effectiveIntervalSeconds` is what the screens
  show, and they say "checked once a day" rather than promising the computed
  number.
- A broken feed is marked `dead` after **14 days** with no success, which is
  §6.4's time-based backstop firing before the 20-consecutive-failures rule.
- A new feed needs 3 clean polls before rung 1 routes its guids, so **3 days**
  of running rung 2 as a pre-check.

Raising the cadence later needs no code change beyond `SWEEP_INTERVAL_S`: Pro
allows per-minute cron, and re-adding a pinger is a YAML file.

## Before the first deploy

1. **`prisma migrate deploy`**, never `db push`. M6's partial indexes are
   hand-written migration SQL, and `db push` replaces them silently.
2. **Environment variables in the Vercel project** — the same names as
   `.env.example`:
   - `DATABASE_URL` — transaction pooler (`:6543`, `?pgbouncer=true`), no
     `?schema=`
   - `DIRECT_URL` — session pooler (`:5432`, **with** `?schema=cadence`)
   - `CRON_SECRET` — `openssl rand -hex 32`. **The poll route refuses every
     request without it**, including Vercel's own cron, so the sweep silently
     never runs.
   - `CADENCE_IMG_SECRET` — `openssl rand -hex 32`. Without it every image is
     dropped from every article; the text still renders.
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` — the
     development pair, by decision. `clerkMiddleware()` **throws** when either
     is missing and its matcher covers every route, so the whole site answers
     500 and the only symptom is everything being broken at once.
   - `CADENCE_DEV_USER_ID` is **not** set in production. It only exists so the
     seed can clone fixture rows locally.
3. **One Supabase project, shared.** Cadence owns the `cadence` schema and
   production shares the 15-client session-pooler ceiling with the other apps
   in this workspace. Boyan's call at M15; if the sweep starts timing out on
   connections, this is the first thing to look at.

## After the first deploy, in this order

**1 · Prove the gate is closed.** This is the check that cannot be done
locally, because it depends on configuration rather than code:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<deployment>/api/cron/poll
# expect 401

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Authorization: Bearer wrong' https://<deployment>/api/cron/poll
# expect 401
```

A `200` here means the route is open to anyone who knows the path, which makes
this server a free amplifier pointed at publishers who see OUR `User-Agent`.

**2 · Prove the tick actually fires, on day one.** A cron that is not running
looks identical to a working system for the first 24 hours — that is the whole
reason this is a checklist item. Run one by hand first:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://<deployment>/api/cron/poll
```

It returns the sweep's summary: `claimed`, `changed`, `unchanged`, `failed`,
`skipped`, `itemsNew`, `budgetSpent`.

Then check the next morning that the SCHEDULER wrote rows, not just your curl.
Paste this into Supabase's SQL editor — it is the one check worth keeping to
hand, because the answer changes over time and the question is not a one-liner:

```sql
-- One row per tick, with the gap since the previous one.
-- A daily cron should show ~24 h gaps. Gaps of minutes mean somebody is
-- poking it by hand; no new rows at all means the cron is not firing.
select
  date_trunc('minute', at) as tick,
  count(*)                 as feeds_polled,
  round(avg(duration_ms))  as avg_ms,
  date_trunc('minute', at)
    - lag(date_trunc('minute', at)) over (order by date_trunc('minute', at))
                           as since_previous
from cadence.fetch_log
group by 1
order by 1 desc
limit 20;
```

The health screen's tick timeline is the same evidence in the UI, and
`/settings/feeds` shows it per feed. A tick that never ran leaves nothing
behind in any of the three, which is exactly why it has to be looked for.

**3 · Check the public page anonymously**, which catches a middleware matcher
mistake that only bites in production:

```bash
curl -s https://<deployment>/ | grep -q 'Three feeds, one story' && echo ok
curl -s -o /dev/null -w '%{http_code}\n' https://<deployment>/reader
# expect a redirect, not 200
```

## What is NOT verified, and will not be by deploying

- **N13 entirely.** No axe run, no keyboard assertions, no reduced-motion
  check; `j`/`k`/`o`/`m`/`s`/`r` were never built. See `decisions.md`.
- **Read state and mark-all-read in a signed-in browser.** Covered by unit
  suites against the fixture reader since M11 and never driven in a browser,
  because Clerk's bot protection blocks automated sign-up.
- **Extraction and the image proxy against a real feed.** Every fixture article
  is on a `.example` domain that does not resolve, and no fixture body contains
  an image. Following one real teaser feed is the first end-to-end test either
  has had.
