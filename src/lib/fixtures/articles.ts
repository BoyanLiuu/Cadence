import type { Article } from "@/lib/types";

import { D } from "./feeds";

/*
 * Articles, ported from `hallmark/data.js`.
 *
 * Two kinds of row live here and the difference matters:
 *
 *  1. The DESIGNED rows (ids 101–134). Each one exists because a screen or a
 *     state needs it — the duplicate pair, the revision redline, the gated
 *     teaser, the blocked extraction. Do not "tidy" these; a screen loses its
 *     only sample if one goes.
 *  2. The BALLAST rows (ids 200+), generated below purely so the list exceeds
 *     one 50-row page and keyset pagination has something to page through.
 *
 * Every date is literal and every generated value is a pure function of its
 * index — nothing calls `Date.now()` or `Math.random()`, so no test built on
 * this corpus can flake or drift.
 */

type ArticleSeed = Omit<
  Article,
  | "author"
  | "readAt"
  | "savedAt"
  | "revisedAt"
  | "revisionCount"
  | "revision"
  | "arrivals"
  | "extractStatus"
> &
  Partial<
    Pick<
      Article,
      | "author"
      | "readAt"
      | "savedAt"
      | "revisedAt"
      | "revisionCount"
      | "revision"
      | "arrivals"
      | "extractStatus"
      | "wasReadAt"
    >
  >;

/** Fills the defaults and converts the short date form, as the prototype's `A()` did. */
const A = (o: ArticleSeed): Article => ({
  author: "",
  extractStatus: "ok",
  revisionCount: 0,
  revision: null,
  arrivals: null,
  ...o,
  publishedAt: D(o.publishedAt),
  fetchedAt: D(o.fetchedAt),
  readAt: o.readAt ? D(o.readAt) : null,
  savedAt: o.savedAt ? D(o.savedAt) : null,
  revisedAt: o.revisedAt ? D(o.revisedAt) : null,
});

const designed: Article[] = [
  // ---------------------------------------------------------- Harbour Wire
  A({
    // The signature row: one story that arrived under three addresses, and the
    // proof that rung 2 is GLOBAL rather than per-feed (§6.1).
    id: 101,
    feedId: 1,
    title: "Council votes to raise the tidal barrier by a metre",
    author: "Dana Okoro",
    url: "https://harbourwire.example/2026/11/12/tidal-barrier-vote",
    publishedAt: "11-12T09:12",
    fetchedAt: "11-12T09:22",
    words: 412,
    summary:
      "The harbour council approved the higher barrier by nine votes to four, with work to start after the spring tides.",
    body: [
      {
        p: "The harbour council voted last night to raise the tidal barrier at the mouth of the estuary by a metre, ending two years of argument over how high the town should build against the sea.",
      },
      {
        p: "The motion passed by nine votes to four. Work is due to start after the spring tides in April and to run through two summers, with the barrier's gates kept working throughout.",
      },
      { h: "What changes on the quay" },
      {
        p: "The higher wall closes the old slipway beside the fish market. Boats that launch there will use the new ramp at the north mole, which opens in March.",
      },
      {
        p: "Councillors who voted against said the estimate had risen twice since the summer, and asked for a fixed price before any contract is signed.",
      },
    ],
    arrivals: [
      {
        feedId: 1,
        url: "https://harbourwire.example/2026/11/12/tidal-barrier-vote",
        at: D("11-12T09:22"),
        how: "first",
      },
      {
        feedId: 2,
        url: "http://www.harbourwire.example/2026/11/12/tidal-barrier-vote/?utm_source=lowland&utm_medium=rss",
        at: D("11-12T09:26"),
        how: "url",
      },
      {
        feedId: 3,
        url: "https://harbourwire.example/2026/11/12/tidal-barrier-vote?ref=northgate#top",
        at: D("11-12T09:33"),
        how: "url",
      },
    ],
  }),
  A({
    id: 102,
    feedId: 1,
    title: "Night ferry resumes after a week of repairs",
    author: "Priya Hale",
    url: "https://harbourwire.example/2026/11/12/night-ferry-resumes",
    publishedAt: "11-12T08:47",
    fetchedAt: "11-12T08:52",
    words: 236,
    summary: "The 22:40 sailing returns tonight after a gearbox fault kept the boat in dry dock.",
    body: [
      {
        p: "The night ferry to the islands sails again from tonight after a week in dry dock, the operator said this morning.",
      },
      {
        p: "A gearbox fault found during a routine inspection kept the boat out of service. Passengers booked on cancelled sailings can travel on any crossing this week.",
      },
    ],
  }),
  A({
    id: 103,
    feedId: 1,
    title: "Grain prices hold as the harvest comes in late",
    author: "Tom Achebe",
    url: "https://harbourwire.example/2026/11/12/grain-prices-hold",
    publishedAt: "11-12T08:20",
    fetchedAt: "11-12T08:22",
    words: 298,
    summary:
      "Merchants at the corn exchange say a wet October delayed the harvest but not the price.",
    body: [
      {
        p: "Prices at the corn exchange held steady this week even as the last of the harvest came in a month late after a wet October.",
      },
      {
        p: "Merchants said stores from last year had kept the market supplied, and that the late crop was smaller than hoped but sound.",
      },
    ],
  }),
  A({
    id: 104,
    feedId: 1,
    title: "Lighthouse keepers' cottages go up for sale",
    author: "Priya Hale",
    url: "https://harbourwire.example/2026/11/12/gull-point-cottages",
    publishedAt: "11-12T07:55",
    fetchedAt: "11-12T08:07",
    words: 344,
    savedAt: "11-12T08:30",
    summary: "The three cottages at Gull Point have stood empty since the light was automated.",
    body: [
      {
        p: "The three keepers' cottages beside the lighthouse at Gull Point are for sale for the first time since they were built.",
      },
      {
        p: "They have stood empty since the light was automated. The trust that owns them says buyers must keep the stone walls and the slate roofs as they are.",
      },
    ],
  }),
  A({
    id: 105,
    feedId: 1,
    title: "Rail strike called off after overnight talks",
    author: "Dana Okoro",
    url: "https://harbourwire.example/2026/11/12/rail-strike-off",
    publishedAt: "11-12T07:31",
    fetchedAt: "11-12T07:37",
    words: 268,
    summary:
      "Trains run to the normal timetable tomorrow after the union and the operator agreed terms at four this morning.",
    body: [
      {
        p: "Tomorrow's rail strike has been called off after talks between the union and the operator ran through the night and ended in agreement at four this morning.",
      },
      {
        p: "Trains will run to the normal timetable. The terms go to a vote of union members next week.",
      },
    ],
    arrivals: [
      {
        feedId: 1,
        url: "https://harbourwire.example/2026/11/12/rail-strike-off",
        at: D("11-12T07:37"),
        how: "first",
      },
      {
        feedId: 2,
        url: "http://harbourwire.example/2026/11/12/rail-strike-off?utm_source=lowland&utm_campaign=wire",
        at: D("11-12T07:56"),
        how: "url",
      },
    ],
  }),
  A({
    id: 106,
    feedId: 1,
    title: "Fog warning for the estuary this morning",
    author: "Tom Achebe",
    url: "https://harbourwire.example/2026/11/12/estuary-fog",
    publishedAt: "11-12T06:58",
    fetchedAt: "11-12T07:07",
    words: 152,
    readAt: "11-12T07:20",
    summary: "Visibility stays under 200 metres until about ten, the coastguard says.",
    body: [
      {
        p: "The coastguard has warned small boats to stay in harbour this morning, with visibility in the estuary under 200 metres until about ten.",
      },
    ],
  }),
  A({
    id: 107,
    feedId: 1,
    title: "Dredging contract awarded for the outer harbour",
    author: "Dana Okoro",
    url: "https://harbourwire.example/2026/11/12/dredging-contract",
    publishedAt: "11-12T06:10",
    fetchedAt: "11-12T06:22",
    words: 310,
    readAt: "11-12T07:18",
    summary: "Work to deepen the channel begins in January and closes the outer berth for a month.",
    body: [
      {
        p: "The port authority has awarded the contract to deepen the outer harbour channel. Work begins in January and closes the outer berth for a month.",
      },
    ],
  }),

  // ----------------------------------------------------- The Lowland Courier
  A({
    id: 108,
    feedId: 2,
    title: "Market square to close for resurfacing",
    author: "Ruth Pell",
    url: "https://lowlandcourier.example/news/market-square-resurfacing",
    publishedAt: "11-12T09:02",
    fetchedAt: "11-12T09:26",
    words: 220,
    summary:
      "The square closes from Monday for six weeks; the Saturday market moves to Bridge Street.",
    body: [
      {
        p: "The market square closes to traffic and stalls from Monday for six weeks while the setts are lifted and relaid.",
      },
      {
        p: "The Saturday market moves to Bridge Street for the duration, with the same stalls in the same order.",
      },
    ],
  }),
  A({
    id: 109,
    feedId: 2,
    title: "The bakery that never closed",
    author: "Owen Marsh",
    url: "https://lowlandcourier.example/features/mill-lane-bakery",
    publishedAt: "11-12T08:15",
    fetchedAt: "11-12T08:26",
    words: 1180,
    summary:
      "Ninety years of bread on Mill Lane, and the night shift that kept the ovens lit through the floods.",
    body: [
      {
        p: "The bakery on Mill Lane has baked every night for ninety years, including the week in 1953 when the water stood a foot deep in the street.",
      },
      {
        p: "The night shift starts at eleven. By five the first trays are cooling in the window, and by seven there is a queue that reaches the corner.",
      },
    ],
  }),
  A({
    id: 110,
    feedId: 2,
    title: "Letters: the new cycle lane",
    author: "Readers",
    url: "https://lowlandcourier.example/letters/cycle-lane",
    publishedAt: "11-11T17:40",
    fetchedAt: "11-11T17:56",
    words: 540,
    readAt: "11-11T20:05",
    summary: "Six readers on the lane along the river road, for and against.",
    body: [
      {
        p: "Six readers wrote this week about the new lane along the river road. Four are for it, two against, and all of them mention the bend by the boathouse.",
      },
    ],
  }),

  // --------------------------------------------------------- Northgate Daily
  A({
    id: 111,
    feedId: 3,
    title: "Northgate library extends its winter hours",
    author: "Lena Fox",
    url: "https://northgatedaily.example/2026/11/library-winter-hours",
    publishedAt: "11-12T08:30",
    fetchedAt: "11-12T08:33",
    words: 190,
    summary:
      "The library opens until eight on weekdays from December, with the reading room heated all day.",
    body: [
      {
        p: "Northgate library will stay open until eight on weekday evenings from the first of December until the end of February.",
      },
      {
        p: "The reading room will be heated all day, and the children's corner opens on Saturday mornings as well.",
      },
    ],
  }),
  A({
    id: 112,
    feedId: 3,
    title: "School playing fields saved after vote",
    author: "Lena Fox",
    url: "https://northgatedaily.example/2026/11/playing-fields-vote",
    publishedAt: "11-11T16:20",
    fetchedAt: "11-11T16:33",
    words: 260,
    readAt: "11-11T20:12",
    summary:
      "The planning committee turned down housing on the fields at St Anne's by six votes to five.",
    body: [
      {
        p: "The planning committee has turned down the application to build on the playing fields at St Anne's, by six votes to five.",
      },
    ],
  }),

  // ----------------------------------------------------- Brightwater Gazette
  A({
    id: 113,
    feedId: 4,
    title: "Harvest fair returns to the green",
    author: "Mo Adair",
    url: "https://brightwater-gazette.example/2026/11/08/harvest-fair",
    publishedAt: "11-08T12:00",
    fetchedAt: "11-08T17:02",
    words: 330,
    readAt: "11-08T21:30",
    summary: "Forty stalls and the tug of war, back on the green after three years.",
    body: [
      {
        p: "The harvest fair returned to the green on Saturday after three years away, with forty stalls and the tug of war across the pond.",
      },
    ],
  }),

  // ------------------------------------------------------ The Fenwick Review
  A({
    id: 114,
    feedId: 5,
    title: "What the ferry timetable knows",
    author: "Ines Calloway",
    url: "https://fenwickreview.example/essays/ferry-timetable",
    publishedAt: "11-11T06:00",
    fetchedAt: "11-12T02:14",
    words: 2140,
    summary:
      "A timetable is a record of what a town agreed to wait for. An essay on the 1962 edition.",
    body: [
      {
        p: "A timetable is a record of what a town agreed to wait for. The 1962 edition of the island ferry's runs to eleven pages and has one sailing on Sundays.",
      },
      {
        p: "Read closely, it is a census. The early boat on Tuesdays exists because the market was on Tuesdays; the late one on Fridays because the dance hall closed at eleven.",
      },
      {
        p: "When the timetable changes, something in the town has already changed. The paper only catches up.",
      },
    ],
  }),
  A({
    id: 115,
    feedId: 5,
    title: "In praise of the second draft",
    author: "Marek Lund",
    url: "https://fenwickreview.example/essays/second-draft",
    publishedAt: "11-04T06:00",
    fetchedAt: "11-05T02:15",
    words: 1640,
    summary: "The first draft finds out what you meant. The second one says it.",
    body: [
      {
        p: "The first draft finds out what you meant. The second one says it, and the third takes out the parts where you were finding out.",
      },
      {
        p: "Most writing that fails stops after the first, because the first feels like the work. It is only the search for it.",
      },
    ],
  }),
  A({
    // The revision case: edited after being read, and it STAYED read (§6.2).
    // `revisedAt` is set, `readAt` is untouched, and the redline is the proof.
    id: 116,
    feedId: 5,
    title: "Letters to a harbourmaster",
    author: "Ines Calloway",
    url: "https://fenwickreview.example/essays/letters-to-a-harbourmaster",
    publishedAt: "10-28T06:00",
    fetchedAt: "10-29T02:13",
    words: 2860,
    readAt: "10-29T20:15",
    savedAt: "10-29T20:40",
    revisedAt: "11-03T02:14",
    revisionCount: 1,
    summary:
      "For forty years the harbourmaster at Fenwick answered every letter he was sent, and kept a copy.",
    body: [
      {
        p: "For forty years the harbourmaster at Fenwick answered every letter he was sent, and kept a carbon copy in a box under the chart table.",
      },
      {
        p: "The log begins in 1913, the year the outer wall was finished. A reader in Fenwick wrote to say the first volume survives in the county archive.",
      },
      {
        p: "Most of the letters are about moorings. Some are about weather, and a few, from the war years, are about sons.",
      },
    ],
    revision: [
      "The log begins in ",
      { del: "1931" },
      " ",
      { ins: "1913" },
      ", the year the outer wall was finished. ",
      { ins: "A reader in Fenwick wrote to say the first volume survives in the county archive." },
    ],
  }),
  A({
    id: 117,
    feedId: 5,
    title: "The weight of a paper map",
    author: "Marek Lund",
    url: "https://fenwickreview.example/essays/paper-map",
    publishedAt: "10-21T06:00",
    fetchedAt: "10-22T02:12",
    words: 1920,
    readAt: "10-22T19:44",
    summary: "A folded map tells you where you are by showing you everything you are not.",
    body: [
      {
        p: "A folded map tells you where you are by showing you everything you are not. A phone shows you the dot and the street, and nothing past the next turning.",
      },
    ],
  }),

  // ------------------------------------------------------- Marginalia Weekly
  A({
    // extractStatus 'thin': a 200 came back but under 600 characters of text,
    // so the publisher gates the body. An honest degraded state (§6.5).
    id: 118,
    feedId: 6,
    title: "Footnotes are a second voice",
    author: "Sabine Ekwall",
    url: "https://marginaliaweekly.example/2026/footnotes-second-voice",
    publishedAt: "11-10T10:00",
    fetchedAt: "11-11T04:49",
    words: 64,
    savedAt: "11-11T21:40",
    extractStatus: "thin",
    summary:
      "A footnote lets a writer argue with herself in public. The best ones are where the real book is hiding, and the…",
    body: [
      {
        p: "A footnote lets a writer argue with herself in public. The best ones are where the real book is hiding, and the…",
      },
    ],
  }),
  A({
    // extractStatus 'none': a teaser feed nothing has been fetched for yet.
    id: 119,
    feedId: 6,
    title: "On rereading",
    author: "Sabine Ekwall",
    url: "https://marginaliaweekly.example/2026/on-rereading",
    publishedAt: "11-03T10:00",
    fetchedAt: "11-04T04:50",
    words: 58,
    readAt: "11-04T22:10",
    extractStatus: "none",
    summary:
      "The second time through a book, you read the sentences instead of the story. That is when…",
    body: [
      {
        p: "The second time through a book, you read the sentences instead of the story. That is when…",
      },
    ],
  }),

  // -------------------------------------------------- Orchard Street Journal
  A({
    id: 120,
    feedId: 7,
    title: "A year of walking the same street",
    author: "Hugh Tamsin",
    url: "https://orchardstreet.example/journal/same-street",
    publishedAt: "11-10T07:30",
    fetchedAt: "11-10T09:22",
    words: 1310,
    summary:
      "Fifty-two walks down Orchard Street, one every Sunday, and what changed between them.",
    body: [
      {
        p: "I walked the length of Orchard Street every Sunday for a year, at the same hour, and wrote down what had changed since the week before.",
      },
      {
        p: "Most weeks it was small: a new name on a bell, a gate painted, a tree down after a storm. In March a whole shop front changed in a day.",
      },
    ],
  }),
  A({
    id: 121,
    feedId: 7,
    title: "Notes from the allotment committee",
    author: "Hugh Tamsin",
    url: "https://orchardstreet.example/journal/allotment-committee",
    publishedAt: "10-27T07:30",
    fetchedAt: "10-27T09:22",
    words: 880,
    readAt: "10-27T21:00",
    savedAt: "10-28T08:15",
    summary:
      "The water rota, the shed roof and the question of the bonfire, settled in under an hour.",
    body: [
      {
        p: "The committee met on Thursday and settled the water rota, the shed roof and the question of the bonfire in fifty minutes, which is a record.",
      },
    ],
  }),

  // ------------------------------------------------------- Hollow Pine Notes
  A({
    id: 122,
    feedId: 8,
    title: "Closing the cabin for winter",
    author: "Wren Oduya",
    url: "https://hollowpinenotes.example/2026/10/closing-the-cabin",
    publishedAt: "10-20T16:00",
    fetchedAt: "10-20T20:10",
    words: 970,
    readAt: "10-21T07:40",
    summary:
      "Draining the pipes, stacking the wood and the list that hangs by the door until spring.",
    body: [
      {
        p: "Every October the same list comes off the nail by the door: drain the pipes, stack the wood under cover, take the rope down from the jetty.",
      },
    ],
  }),

  // ---------------------------------------------------------- Ledger & Lathe
  // 123 and 124 are THE VISIBLE DUPLICATE PAIR: one post retitled, reworded
  // and republished at a new address, so the GUID, the URL *and* the text all
  // changed in one build. No rung catches that, which is why the manual merge
  // exists (§6.1). M12 merges them; until then the reader can see both.
  A({
    id: 123,
    feedId: 9,
    title: "Truing a lathe chuck with a dial indicator",
    author: "Ada Penrose",
    url: "https://ledgerandlathe.example/2026/11/truing-a-lathe-chuck",
    publishedAt: "11-11T19:00",
    fetchedAt: "11-11T21:03",
    words: 1460,
    summary: "Half a thou of runout at the jaws, and the twenty minutes it takes to chase it out.",
    body: [
      {
        p: "My chuck had half a thou of runout at the jaws, which is enough to see on a finished part. Here is the twenty minutes it took to chase it out.",
      },
      {
        p: "Mount the indicator on the cross slide, touch it to a ground pin held in the jaws, and turn the spindle by hand.",
      },
    ],
  }),
  A({
    id: 124,
    feedId: 9,
    title: "Truing a lathe chuck, with a dial indicator",
    author: "Ada Penrose",
    url: "https://ledgerandlathe.example/2026/11/truing-a-lathe-chuck-with-a-dial-indicator",
    publishedAt: "11-11T19:00",
    fetchedAt: "11-12T09:05",
    words: 1490,
    summary:
      "Runout you can see on a finished part, and the twenty minutes it takes to chase it out with an indicator.",
    body: [
      {
        p: "If you can see runout on a finished part, it is worth twenty minutes with a dial indicator. Mine was half a thou at the jaws.",
      },
      {
        p: "Mount the indicator on the cross slide, touch it to a ground pin held in the jaws, and turn the spindle by hand.",
      },
    ],
  }),
  A({
    id: 125,
    feedId: 9,
    title: "Sharpening a skew chisel",
    author: "Ada Penrose",
    url: "https://ledgerandlathe.example/2026/11/skew-chisel",
    publishedAt: "11-04T19:00",
    fetchedAt: "11-04T21:02",
    words: 1120,
    readAt: "11-05T07:30",
    summary: "Two flat bevels, a burr you can feel and not see, and a strop.",
    body: [
      {
        p: "A skew wants two flat bevels that meet in a straight edge. Grind them hollow and the edge rolls the first time it touches end grain.",
      },
    ],
  }),

  // ----------------------------------------------------- Plainfield Changelog
  A({
    // The one feed with resurfaceOnRevision on, so `wasReadAt` records what the
    // read state had been before the edit returned it to unread (§6.2).
    id: 126,
    feedId: 10,
    title: "Plainfield 4.2: offline maps and a faster import",
    author: "The Plainfield team",
    url: "https://plainfield.example/changelog/4-2",
    publishedAt: "11-11T18:00",
    fetchedAt: "11-11T21:30",
    words: 380,
    revisedAt: "11-12T09:30",
    revisionCount: 1,
    wasReadAt: D("11-11T22:05"),
    summary:
      "Maps now work without a connection, and importing a large file takes a third of the time.",
    body: [
      { h: "What's new" },
      {
        li: [
          "Maps download for offline use, a region at a time",
          "Importing a 50 MB file takes a third of the time it did in 4.1",
          "Search keeps your last ten queries",
        ],
      },
      { h: "Known issue" },
      {
        p: "On some tablets the offline map shows blank tiles at the edge of a region. A fix is in 4.2.1.",
      },
    ],
    revision: [
      {
        ins: "Known issue. On some tablets the offline map shows blank tiles at the edge of a region. A fix is in 4.2.1.",
      },
    ],
  }),
  A({
    id: 127,
    feedId: 10,
    title: "Plainfield 4.1.3: fixes for the sync conflict screen",
    author: "The Plainfield team",
    url: "https://plainfield.example/changelog/4-1-3",
    publishedAt: "10-29T18:00",
    fetchedAt: "10-29T21:31",
    words: 210,
    readAt: "10-30T08:02",
    summary: "The conflict screen no longer loses your choice when the phone sleeps.",
    body: [
      {
        p: "The conflict screen no longer loses your choice when the phone goes to sleep in the middle of a sync.",
      },
    ],
  }),

  // ----------------------------------------------------- Kestrel Field Notes
  // Subscribed yesterday, so the back-articles arrived unread in one fetch.
  A({
    id: 128,
    feedId: 11,
    title: "Building a bat box from offcuts",
    author: "Jo Marr",
    url: "https://kestrelfieldnotes.example/notes/bat-box",
    publishedAt: "11-11T14:00",
    fetchedAt: "11-11T15:02",
    words: 760,
    summary: "Rough-sawn timber, no paint and a slot 20 millimetres wide.",
    body: [
      {
        p: "A bat box wants rough-sawn timber inside so they can grip, no paint or preservative, and an entry slot about 20 millimetres wide.",
      },
    ],
  }),
  A({
    id: 129,
    feedId: 11,
    title: "Field notes: the first frost",
    author: "Jo Marr",
    url: "https://kestrelfieldnotes.example/notes/first-frost",
    publishedAt: "11-09T08:00",
    fetchedAt: "11-11T15:02",
    words: 640,
    summary: "Minus two on the lower field at six, and the redwings in by eight.",
    body: [
      {
        p: "Minus two on the lower field at six this morning. By eight the redwings were in the hawthorns along the lane.",
      },
    ],
  }),
  A({
    id: 130,
    feedId: 11,
    title: "Ten years of the same notebook",
    author: "Jo Marr",
    url: "https://kestrelfieldnotes.example/notes/ten-years",
    publishedAt: "11-06T08:00",
    fetchedAt: "11-11T15:02",
    words: 1050,
    summary: "The same pocket notebook, refilled forty times, and what it says about the field.",
    body: [
      {
        p: "I have used the same make of pocket notebook for ten years and filled forty of them. Laid end to end they are a record of one field.",
      },
    ],
  }),

  // ------------------------------------------------------- Saltmarsh Almanac
  A({
    id: 131,
    feedId: 12,
    title: "Sowing broad beans before the frost",
    author: "Ivo Brand",
    url: "https://saltmarshalmanac.example/almanac/broad-beans",
    publishedAt: "11-11T05:45",
    fetchedAt: "11-11T06:50",
    words: 46,
    extractStatus: "none",
    summary:
      "Broad beans sown now stand through the winter and crop a month early. Here is how deep, how far apart and…",
    body: [
      {
        p: "Broad beans sown now stand through the winter and crop a month early. Here is how deep, how far apart and…",
      },
    ],
  }),
  A({
    id: 132,
    feedId: 12,
    title: "Mending a cold frame",
    author: "Ivo Brand",
    url: "https://saltmarshalmanac.example/almanac/cold-frame",
    publishedAt: "11-04T05:45",
    fetchedAt: "11-04T06:50",
    words: 720,
    readAt: "11-04T19:00",
    summary: "New glass, old putty knife, and why the frame faces south-east.",
    body: [
      {
        p: "Two panes of the cold frame cracked in the last frost. Here is how to cut the old putty out without cracking a third.",
      },
    ],
  }),

  // ------------------------------------------------ the two remaining states
  // The prototype boarded `none`, `ok` and `thin`. Appendix D's enum has five,
  // and §6.5 gives `blocked` and `failed` their own copy, so each needs a row
  // or its screen has nothing to render.
  A({
    // extractStatus 'blocked': a CDN challenge answered 403 (§6.5).
    id: 133,
    feedId: 6,
    title: "The margin as a room of one's own",
    author: "Sabine Ekwall",
    url: "https://marginaliaweekly.example/2026/margin-as-a-room",
    publishedAt: "10-27T10:00",
    fetchedAt: "10-28T04:50",
    words: 71,
    extractStatus: "blocked",
    summary:
      "Every book worth keeping has a second book written beside it in pencil, and that one is yours…",
    body: [
      {
        p: "Every book worth keeping has a second book written beside it in pencil, and that one is yours…",
      },
    ],
  }),
  A({
    // extractStatus 'failed': fetched, but Readability returned nothing usable.
    id: 134,
    feedId: 12,
    title: "Pruning apples in the second winter",
    author: "Ivo Brand",
    url: "https://saltmarshalmanac.example/almanac/pruning-apples",
    publishedAt: "10-28T05:45",
    fetchedAt: "10-28T06:50",
    words: 52,
    extractStatus: "failed",
    summary: "Open the middle, take the leader back by a third, and leave the spurs alone…",
    body: [{ p: "Open the middle, take the leader back by a third, and leave the spurs alone…" }],
  }),
];

/*
 * Ballast, so the list exceeds one 50-row page.
 *
 * Deliberately dull and deliberately deterministic: the title, the feed, the
 * date and the read state are all pure functions of the index. The one property
 * that matters is that `publishedAt` strictly descends and never collides,
 * because keyset pagination orders on `(publishedAt, id)` and a tie is how an
 * off-by-one page boundary hides.
 */
const BALLAST_FEEDS = [1, 2, 3, 5, 7, 9, 10, 11] as const;
const BALLAST_SUBJECTS = [
  "the tide gauge",
  "a borrowed ladder",
  "the long shed",
  "two kinds of rope",
  "the Tuesday market",
  "a kettle on the stove",
  "the near field",
  "a door that sticks",
  "the low bridge",
  "winter light",
];
const BALLAST_SHAPES = [
  "Notes on",
  "A short account of",
  "Second thoughts about",
  "In defence of",
  "What to do with",
  "An afternoon with",
];

function ballast(count: number): Article[] {
  const out: Article[] = [];
  for (let i = 0; i < count; i += 1) {
    const feedId = BALLAST_FEEDS[i % BALLAST_FEEDS.length];
    const shape = BALLAST_SHAPES[i % BALLAST_SHAPES.length];
    const subject = BALLAST_SUBJECTS[(i * 7) % BALLAST_SUBJECTS.length];
    // Walk backwards from 2026-10-20 in 83-minute steps: strictly descending,
    // no two equal, and every one older than the designed rows above.
    const at = new Date(Date.UTC(2026, 9, 20, 0, 0, 0) - i * 83 * 60_000);
    // The FULL ISO form, milliseconds included. Slicing them off produced a
    // third spelling of a timestamp in this corpus, and `service-parity`
    // compares timestamps as strings — so the seam test would have failed on a
    // difference no reader could see.
    const iso = at.toISOString();
    out.push({
      id: 200 + i,
      feedId,
      title: `${shape} ${subject}`,
      author: "A. Correspondent",
      url: `https://example.invalid/ballast/${200 + i}`,
      publishedAt: iso,
      fetchedAt: iso,
      words: 180 + ((i * 37) % 900),
      summary: `A back-article kept only so the list has a second page. ${shape} ${subject}.`,
      body: [{ p: `${shape} ${subject}. This row exists to be paged past, not to be read.` }],
      extractStatus: "ok",
      revisedAt: null,
      revisionCount: 0,
      revision: null,
      arrivals: null,
      // Every third one read, so the unread count is not simply the row count.
      readAt: i % 3 === 0 ? iso : null,
      savedAt: null,
    });
  }
  return out;
}

/** Newest first, which is the order every list renders in. */
export const articles: readonly Article[] = [...designed, ...ballast(90)].sort((a, b) =>
  a.publishedAt === b.publishedAt ? b.id - a.id : a.publishedAt < b.publishedAt ? 1 : -1,
);
