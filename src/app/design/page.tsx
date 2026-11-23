import { AppBar } from "@/components/app-bar";
import { listSubscriptions } from "@/lib/server/article-service";
import { requireViewer } from "@/lib/server/viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/*
 * M0 and M1's surface: the design system and the service boundary, rendered.
 *
 * This is a specimen sheet, not a product screen — it exists so the token port
 * can be checked against `hallmark/index.html` by eye, and so the service layer
 * is proven to work from a real Server Component before M4 depends on it. M4
 * replaces it with the three-pane reader.
 */

const TYPE = [
  { name: "display", cls: "font-display text-display", sample: "An unread count you can trust" },
  { name: "section", cls: "font-display text-section", sample: "Feeds that need attention" },
  { name: "title", cls: "font-display text-title", sample: "Council votes to raise the barrier" },
  { name: "read", cls: "text-[length:var(--text-read)]", sample: "The reading pane's own size." },
  { name: "md · body", cls: "text-md", sample: "The body face, at the size most text is set in." },
  { name: "sm", cls: "text-sm", sample: "Secondary rows, bylines and the nav." },
  { name: "xs", cls: "text-xs", sample: "Timestamps and table figures." },
];

/*
 * Class names are written out rather than built from the token name. Tailwind
 * scans source text, so `bg-${token}` produces no CSS at all — and the swatch
 * would render blank while looking correct in the source.
 */
const PALETTE = [
  {
    label: "paper",
    swatches: [
      { token: "paper", cls: "bg-paper" },
      { token: "paper-2", cls: "bg-paper-2" },
      { token: "paper-3", cls: "bg-paper-3" },
      { token: "paper-hi", cls: "bg-paper-hi" },
    ],
  },
  {
    label: "ink",
    swatches: [
      { token: "ink", cls: "bg-ink" },
      { token: "ink-2", cls: "bg-ink-2" },
      { token: "muted", cls: "bg-muted" },
      { token: "rule", cls: "bg-rule" },
    ],
  },
  {
    label: "signal",
    swatches: [
      { token: "accent", cls: "bg-accent" },
      { token: "focus", cls: "bg-focus" },
      { token: "error", cls: "bg-error" },
      { token: "success", cls: "bg-success" },
    ],
  },
];

const SPACING = ["3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl"];

export default async function DesignSystemPage() {
  // Resolved once per request and passed down — never read again further in,
  // and never taken from a request argument (§3).
  const viewer = await requireViewer();
  const subs = await listSubscriptions(viewer);
  // `requireViewer()` redirected an anon away, so this is always a reader.
  const account = viewer.user;

  return (
    <>
      <AppBar accountName={account.name} initials={account.initials} />

      <main className="gap-2xl px-lg py-xl mx-auto grid max-w-[920px]">
        <header className="gap-xs grid">
          <p className="font-outlier text-muted text-xs tracking-[0.08em] uppercase">
            M0 · design system · M1 · service boundary
          </p>
          <h1>The tokens render</h1>
          <p className="lead text-ink-2">
            Ported from the approved prototype. Check this page against{" "}
            <code className="text-sm">hallmark/index.html</code> before building a screen on it —
            where the two disagree, the prototype wins.
          </p>
        </header>

        <Separator />

        <section className="gap-md grid">
          <h2>Type</h2>
          <div className="gap-sm grid">
            {TYPE.map((t) => (
              <div key={t.name} className="gap-md grid grid-cols-[7rem_1fr] items-baseline">
                <code className="text-muted text-xs">{t.name}</code>
                <span className={t.cls}>{t.sample}</span>
              </div>
            ))}
          </div>
        </section>

        <Separator />

        <section className="gap-md grid">
          <h2>Palette</h2>
          <div className="gap-lg grid">
            {PALETTE.map((row) => (
              <div key={row.label} className="gap-xs grid">
                <code className="text-muted text-xs">{row.label}</code>
                <div className="gap-md grid grid-cols-4">
                  {row.swatches.map((s) => (
                    <div key={s.token} className="gap-2xs grid">
                      <div className={`h-xl border-rule border ${s.cls}`} />
                      <code className="text-muted text-xs">{s.token}</code>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <Separator />

        <section className="gap-md grid">
          <h2>Spacing</h2>
          <div className="gap-2xs grid">
            {SPACING.map((s) => (
              <div key={s} className="gap-md grid grid-cols-[4rem_1fr] items-center">
                <code className="text-muted text-xs">{s}</code>
                <div className="h-xs bg-ink" style={{ width: `var(--spacing-${s})` }} />
              </div>
            ))}
          </div>
        </section>

        <Separator />

        <section className="gap-md grid">
          <h2>Controls</h2>
          <div className="gap-md flex flex-wrap items-center">
            <Button>Add feed</Button>
            <Button variant="secondary">Cancel</Button>
            <Button variant="outline">Check now</Button>
            <Button variant="ghost">Dismiss</Button>
            <Button variant="destructive">Unfollow</Button>
          </div>
          <div className="gap-md flex flex-wrap items-center">
            <Input placeholder="Paste a feed or site address" className="max-w-[22rem]" />
            <Badge>Revised</Badge>
            <Badge variant="secondary">Atom</Badge>
            <Badge variant="destructive">Stopped</Badge>
          </div>
          <div className="gap-xs grid max-w-[22rem]">
            <Skeleton className="h-xs w-full" />
            <Skeleton className="h-xs w-3/4" />
          </div>
        </section>

        <Separator />

        <section className="gap-md grid">
          <h2>Figures</h2>
          <p className="text-muted text-sm">
            Live from <code className="text-sm">listSubscriptions(viewer)</code> — the same async
            function M6 reimplements against Postgres. Every unread figure is <em>derived</em>,
            never a stored column, and every number is tabular so the columns line up as they are
            read.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Feed</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Checks</TableHead>
                <TableHead className="text-right">304</TableHead>
                <TableHead className="text-right">Unread</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subs.map((s) => (
                <TableRow key={s.feedId}>
                  <TableCell>{s.customTitle ?? s.feed.title}</TableCell>
                  <TableCell>
                    {s.feed.status === "active" ? (
                      <span className="text-muted">active</span>
                    ) : (
                      <Badge variant={s.feed.status === "dead" ? "destructive" : "secondary"}>
                        {s.feed.status.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">{s.feed.today.checks}</TableCell>
                  <TableCell className="num text-right">{s.feed.today.n304}</TableCell>
                  <TableCell className="num text-right">{s.unread}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </main>
    </>
  );
}
