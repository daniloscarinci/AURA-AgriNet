# AURA-AgriNet 1.0

**Autonomous Unified Remote-sensing Agent for Agricultural Micro-Logistics.**

An installable, offline-capable PWA that pulls real observations for **any location on
Earth**, turns them into decisions a grower can act on — irrigate or hold, harvest tonight
or tomorrow, spray now or wait — and drives the operational consequences: early-harvest
warnings, crop-aware buyer order revisions, and Dijkstra rerouting of delivery drivers
around roads that are no longer passable.

Zero dependencies, no build step, no API key, no server. One HTML file, one stylesheet,
one service worker.

## Honest scope

This app's whole argument is that **saying where a number came from is part of the
number**. So:

| Metric | Source | Status |
|---|---|---|
| Soil moisture (3–9 cm) | Open-Meteo · ECMWF IFS / DWD ICON | **modelled**, ~11 km |
| Surface temperature | Same, 0 cm soil layer | **modelled**, ~11 km |
| Air temperature, rain, wind, humidity, ET₀ | Same | **modelled** |
| River discharge | Copernicus GloFAS via Open-Meteo | **modelled**, ~5 km |
| Root-zone stress | Position between wilting point and field capacity | **derived** |
| Trafficability | Soil water + 24/72 h rain + river percentile | **derived** — ours, and labelled ours |
| NDVI | *no keyless point source exists* | **simulated**, and says so |

Not one of these says *measured*. None is a direct instrument retrieval at plot scale, so
none of them claims to be.

**What is genuinely satellite:** the map's imagery layers come from NASA GIBS —
`SMAP_L4_Analyzed_Root_Zone_Soil_Moisture`, `MODIS_Terra_L3_NDVI_16Day`, and MODIS true
colour. These are the real products, drawn unsmoothed at their real resolution, with the
true footprint of one source pixel outlined over the catchment. On a 5 km holding, a
single 9 km SMAP pixel covers everything — which is exactly why per-plot soil moisture is
an estimate. Most dashboards resample that away; this one draws it.

**What is not real:** Sentinel-1/2 at 10 m needs a Copernicus OAuth client secret, and a
secret in a static file is public. The **farm layout is synthesised** — coordinates,
elevation, timezone and telemetry for a searched place are real, but no open dataset
publishes plot boundaries and farm tracks per smallholding, so the plots, roads and river
crossing around the point are generated deterministically from the coordinates. The app
says so, on screen.

## Offline

"Live data offline" is a contradiction. What actually happens:

- Every successful fetch is cached against its coordinates in `localStorage`, and the
  service worker keeps the HTTP responses too.
- Lose the connection and the app serves that cache with its **age stated** in the header
  chip — *Offline · cached*, exact age on hover.
- NASA imagery is cached tile-by-tile (cache-first: a published granule never changes).
- A location never visited falls back to simulation, labelled as such.
- The **city list is precached**, so choosing where to look never needs a network
  even though the geocoder does.

The app never presents a stale number as current, and never invents one.

## Held upright

`env(safe-area-inset-*)` appeared four times in the stylesheet and resolved to zero every
time, because the viewport meta never opted in — so on a phone held upright the header ran
under the status bar and the tab bar under the gesture bar. `viewport-fit=cover` turns the
four on, and every surface that touches an edge now reads `--safe-t` or `--safe-b`,
resolved once on `:root`, rather than repeating an `env()` call that is easy to forget.

The Android wrapper pads the WebView itself, so this fixed the browser and the installed
PWA and left the APK exactly as it was.

## The first screen

Before anyone has said where their farm is, the Farmer view is one panel and nothing else:
**Where is your farm?**, a sentence saying why the app needs an answer, a search field with
the ◎ button, the three catchments this repository ships as one-tap examples, and four lines
naming what arrives once the question is answered.

It replaces a screen that gave two answers to *where am I?* at once. The deck said *these
calls need a real location*; the search box beside it already read *Somanya · Eastern
Region*, because the seeded region's name was written into it on boot; and below both,
moisture, NDVI and surface temperature for that Ghanaian demo farm.

Everything that named the unchosen catchment is gated with it, because the leak had five
doors and the deck was only the widest:

| Surface | Before | Now |
|---|---|---|
| Deck | *these calls need a real location* | the panel, which asks instead |
| Harvest window · My plots | the demo farm's readings | absent until there is a farm |
| Header search box | pre-filled *Somanya · Eastern Region* | hidden; the panel owns the question |
| Chat opening | moisture 31.3% · NDVI 0.643, and a farmer asking after Plot F-2 | one line saying what it needs |
| *Send as* | *Amara — Farmer, Plot F-2* | hidden |
| Quick replies | *Soil moisture?* · *Frost risk today?* | none; each is a question about a farm |
| An answer | *Plot F-2 root-zone moisture is 31.9% (SMAP)* | the agent declines and says why |

The last one mattered most. A number with a source attached is the most believable thing
this app can put on a screen, and it was putting one there for a catchment the reader had
never picked. Your own words are still posted — those are yours — but the agent answers for
a farm only once it has one.

The example chips go through the same `goToLocation` a search result does, so one tap gives
a full live deck without ever putting an unasked-for farm on screen as if it were yours.

A flag, `State.data.chosen`, decides this, and it is persisted. It is its own flag rather
than *is there a searched place*, because picking a built-in catchment is a real answer and
leaves `place` null. Snapshots written before it existed infer it from a stored place or a
non-default region, so nobody who already chose a farm is asked again.

The seeded region is still there underneath — Buyer, Driver, Ops, the map and Dijkstra all
need a graph, and the footer has always declared that simulation. The gate is the Farmer
front page alone.

## Reopening the app

Keeping the farm you searched for was fixed once. Keeping its numbers was not.

Boot rebuilt the catchment from the stored coordinates and then never asked `Live`
anything, so `Live.ready()` was false on every reload. Every fetch had been written to
`localStorage` against its coordinates since the first build, and nothing had ever read
that cache at startup. The result: reopen the app and the deck told you to search for a
location while the search box beside it named one, and the header chip said *Simulated*
about a farm the app could name.

Now boot reads that cache **before the first paint**, so the first frame carries real
numbers, and then re-fetches in the background. The age is stated rather than hidden — the
chip already knew how to say *Stale — fetched 14 h ago* and *Offline — last good reading
2 d ago*, and this simply reaches the vocabulary that was already there. Nothing cached and
nothing answering leaves the app exactly where it was before: simulated and labelled, but
now about a farm it can name.

The same bug wore one more coat. Leave the app open overnight and this morning's irrigation
call was arithmetic over yesterday's forecast; a tab returning to a payload older than three
hours now refreshes it.

One function does the repainting for both the location switch and the restore, because the
boot path is exactly what broke — it rebuilt the catchment and forgot thirteen render calls.
A second hand-maintained copy of that list would have drifted again the first time one was
added.

## The controls are drawn, not typed

Every control used to be labelled with an emoji — 🌱 for the farmer, 📦 for the buyer, 🌐 for
the language. Three things wrong with that, none of them taste. An emoji is painted by the
platform's own font, so the same button is a different picture on every device and there is
no version of it this project can test. It ignores the theme: a colour glyph stays colour on
a dark ground beside text that has gone pale, so the loudest thing in the tab bar was the
decoration rather than the label. And at 15px it is mush.

They are line drawings now, on a 24-unit grid at one stroke weight, drawn in `currentColor`
so each one inherits the text colour of whatever it sits in and follows both themes for
free. Defined once and painted into every `[data-icon]` in the markup, so the tab bar and
the header cannot drift apart.

Drawing them found two things the emoji had been hiding. The first sprout had a leaf either
side of a stem, which at 15px closed into a tuning fork — two thin arcs with no white left
between them; it is one leaf and one stem now. And both dropdowns anchored to the end edge
of their wrapper, which is correct only while that wrapper is on the right of the header: it
wraps on a phone and on any desktop narrow enough, and then a 210px menu hung off the left
of the screen with the icons and the first letters of *Light* and *Match system* simply
gone. The menu is measured against the window when it opens rather than tied to a
breakpoint, because the wrap point moves with the language — the same three controls are
wider in Portuguese.

## Themes

Light, dark, or whatever the machine says, from the ◐ button in the header.

The light palette started as an oat page under near-white cards, which is warm and also
dim: it spent most of its warmth on the one surface that fills the screen, so the app read
as underlit in daylight, which is where a grower uses it. The page is nearly white now and
the cards are white; the tint lives in the wells, the hairlines and the washes, where it
still says agrarian and stays out of the way of the numbers. A hairline had to darken with
it — `rgba(43,38,34,0.10)` over #fffdf9 and over pure white are not the same line.

Brightening the surfaces did not finish it, because the app was **dark-first** and a dozen
colours had never gone through a token at all. They were invisible while the ground was
oat and obvious once it was white: 55%-black shadows under every card, which on white is
not a shadow but a smudge; a slate scrollbar thumb; `rgba(255,255,255,.04)` fills that mean
"a lift" on dark and nothing at all on light; a blue focus ring; and avatar initials set in
near-black on a mid-blue circle. Shadows are now four tokens per theme rather than a colour,
and a test reads the **stylesheet** as well as the script, which is how these were found —
the original check watched only the script and all of them were in CSS.

## The graphics

Each call now gets the shape its question has, instead of two of them sharing a row of
coloured bars:

| Call | Was | Is |
|---|---|---|
| Spray & fieldwork | 48 detached bars | a **ribbon** — adjacent hours of one rating merge into a block, and the run the headline names is bracketed |
| Next 72 hours | 72 detached bars | a **curve**, with the frost floor drawn across it and a dot at the minimum |
| Trafficability | *nothing* | an **arc**, one number against the passability floor, with the floor ticked on the dial |
| Heat units | *nothing* | the **running total** climbing across the window |
| Harvest window | one word in 40px type | a **medallion**: a ring that closes when the schedule is intact and breaks open when the frost protocol runs |

Two of these had no graphic at all, and the two that did had the *same* graphic — which made
two different questions look like one question answered twice.

The temperature chart is scaled to the temperatures actually forecast rather than anchored
at freezing. Anchoring it was honest and useless: on a Ghanaian night running 23 to 31 °C it
pressed the whole day into the top fifth of the box. The frost line is drawn only when
freezing is near enough to be in frame, which is exactly when it is worth drawing.

Nothing here invents a quantity to length-encode. The harvest window is a binary call, so it
gets a state and not a bar.

Both palettes have been in the stylesheet since the first build: light on bare `:root`, dark
on a `prefers-color-scheme` block **and** on `[data-theme]`. Nothing had ever set that
attribute, so half of that CSS had never once applied and the app could only follow the
system. Three options rather than two, because the CSS was written for three — an explicit
light that survives a dark machine, an explicit dark that survives a light one, and no
attribute at all for following along.

The button shows the **setting**, not the resolved theme: on *match system* it reads ◐,
because a button claiming *light* would be answering a question the reader did not ask.

**The Android WebView will darken the page for you, and it should not.** The wrapper used to
allow algorithmic darkening, on the reasoning that a page declaring `color-scheme: light
dark` would be left to paint its own dark theme. On a phone in night mode it darkened
whatever the page painted instead — including the light theme a reader had just chosen on
purpose. Dark mode looked fine, because darkening something already dark changes little;
light mode came out dark. That asymmetry is the signature of this bug, and no amount of
work on the light palette can fix it, because the palette was never what was wrong.

Darkening is now off. The cost is that `prefers-color-scheme` inside that WebView reports
light whatever the phone is set to, so *match system* can no longer read it — the wrapper
hands the real setting in through `Theme.systemIsDark()`, at first paint and again whenever
the phone switches. A browser never calls it, and there the media query decides exactly as
before. Both paths are tested, including running the wrapper's snippet against the shipped
script, because it is a Java string that no compiler checks.

The two `theme-color` metas are per-scheme, which is right until someone forces dark on a
light machine and the browser's own chrome stays oat over a page gone to soil. An explicit
choice points both at that theme's ground; *match system* hands the split back.

The dark palette is written out twice — plain CSS cannot share one body between a media
block and a bare selector, and collapsing them with `light-dark()` would put a Chrome 123 /
Safari 17.5 floor under an app that ships an APK onto whatever WebView a device happens to
carry. A test compares the two blocks token by token instead, and another fails on any raw
colour left in the script. Three had escaped: a near-black driver-marker label that was poor
contrast on light-theme ochre before dark mode was ever a question, and two copies of a red
belonging to neither palette.

## Choosing a location

The search box does two things at once, and says which is which.

Focus it and a list of **cities** appears immediately, drawn from a precached
file — no request, no spinner. Type, and it filters as you press each key,
folding accents so `sao` finds *São Paulo* and `cordoba` finds *Córdoba*. Under a
second heading, the Open-Meteo geocoder answers for **anywhere on Earth**, which
is what you want for an actual smallholding that no list would ever carry.

The two halves fail independently, which is the point. Lose the connection and
the geocoder half is replaced by a sentence explaining why — while the cities are
still sitting above it, still selectable, still loading real cached observations.
You lose the long tail, not the feature.

396 cities across 117 countries, 12 KB gzipped. They are **curated for
agricultural relevance and weighted toward the global South** rather than ranked
by population: Kano, Ludhiana, Sorriso, Chipata and Bahir Dar earn a place here
that they would not on a list of world capitals. Every row — coordinates, admin
region, population — was resolved once against the same geocoder the box queries
and then frozen, so a city picked from the list and the same city found by typing
are the same record. Writing coordinates from memory would have put a farm in the
sea and fetched real weather for it without ever saying so.

The **◎ button** beside the box is still there and still the fastest answer when
it applies: one tap, browser geolocation, straight to where you are standing. It
asks only on an explicit tap, never on load.

City names are not translated. They are proper nouns, and neither is *Bodija
Market*.

## Real-time decisions

Five calls, computed from the live series:

- **Water balance** — FAO-56 over a 300 mm root zone. Depletion against the refill point,
  7-day rain and ET₀, and an *irrigate N mm* / *hold* call that defers when rain is coming.
- **Next 72 hours** — hourly air temperature, hours at or below freezing, and how long
  until the frost window opens.
- **Spray & fieldwork** — wind, gusts, humidity and rain probability over 48 h, resolved
  into good / marginal / do-not-spray hours and the next usable run.
- **Heat units** — growing-degree days against the crop's base temperature, with days to
  maturity at the current rate.
- **Trafficability** — blocked, degrading or passable. It decides whether the crop can
  leave the farm at all, which is too large a question to answer from a tile.

## The deck

The app does not show you five calls at once. It ranks them.

Each call resolves itself to a tone — act, warn, ok — for its own headline, and the deck
reads that same field rather than inventing a second severity vocabulary that could
disagree with the one on screen. The three groups follow:

- **Needs you** — the first one stays open, with the chart that justifies it.
- **Watching** — one line each.
- **All clear** — one line each.

A quiet day collapses to a short screen and looks quiet from the doorway. That is the
point of the grouping rather than a side effect of it: five identical cards make you read
all five to find out nothing is wrong.

Two rules sit on top of the tone. **An armed advisory outranks its card**, so the rule
engine and the deck can never contradict each other, and it only ever promotes — a rule
firing must not make a call look calmer than the arithmetic already found it. **Ties break
by deadline**: whatever bites soonest sorts first.

A promoted card states the rule that promoted it. An injected frost is not in the forecast
series, so the thermal arithmetic can honestly still read *Clear 72 h* while the advisory
is the only thing that knows better; showing the model's verdict there filed a card under
*Needs you* that said everything was fine.

An advisory no call claims becomes a card of its own, and armed rules reach the deck with
or without a location loaded. The agronomy needs real coordinates and says so; the event
engine does not, and an advisory nobody can see is worse than no advisory.

Tapping any row opens a **detail sheet**: the verdict, the chart behind it, the inputs, and
a fixed *Where this came from* block. At 1024px and above the deck becomes a left rail and
that same body fills the pane beside it — the same renderer and the same markup, so the two
hosts cannot drift, and a test compares them to keep it that way. Nothing waits behind a tap
on a screen with the room to show it.

Provenance moved into that block rather than being dropped. Taking the labels off the home
screen is only defensible if they land somewhere a reader can always find them: *derived*
rather than measured, *~11 km*, *our formula, not a published product*, *farm tracks
synthesised from the coordinates*. Four checks fail if any detail screen loses it.

## Run it

```
serve.cmd            # or: python -m http.server 8080
```

Then open <http://localhost:8080>. A service worker will **not** register over `file://`,
so opening `index.html` directly gives you the app without offline support.

## Manual

A **Manual** button in the header (or `?`) opens a seven-section guide over the console.
It generates its tables from the running configuration — the provenance table from
`Live.PROV`, thresholds from `CFG.THRESH`, crop sensitivities from `CROPS` — so it cannot
drift from the code, and a test fails if it ever disagrees.

## Languages

Four languages, each maintained to full depth: **English · Español · Português ·
Français.** Pick one from the 🌐 control in the header.

Every user-facing surface is translated — not just headings. The interface, the
map and its legend, tiles and their provenance labels, the four decision cards,
advisories, the event log, the agent's briefings and the whole seven-section
manual. Verified empirically rather than by inspection: the app is rendered in
each language, the DOM walked, and any remaining English reported. All three
report zero, and that walk is now a **test rather than a claim**: every intent
asked, every briefing played and every rule armed in English, then the language
switched and the whole lot reread — chat, advisory cards, the map and all three
role panes, with a field in trouble so every branch is on screen. Up to 376
translatable strings checked per language, zero English survivors, zero English
decimal separators. Reverting a single `t()` names the exact label that broke.

Map labels follow too. Regions hold English source and `Geo.project` produces
what is drawn, so a reprojection on language change relabels the catchment;
a route stores node **ids**, never a snapshot of their names. Genuine proper
nouns are left alone in every language — Bodija Market is a real market in
Ibadan — while `Somanya Depot` turned out to be `<Place> Depot` and is built
from its parts.

Typing works in your own language too — each catalogue carries its own keyword
list per intent, so `humedad del suelo` and `umidade do solo` reach the
soil-moisture answer. English keywords stay active everywhere, which is why the
quick-reply buttons keep working: they send English and display the translation.

Translation is resolved at **paint time**, never at write time. A stored line —
a chat message, a log entry — keeps English source and its variables rather than
a finished sentence, so switching language rereads the whole transcript instead
of stranding whatever was already on screen. Messages you typed are never
translated: those are your words.

An answer is therefore stored in pieces, because the pieces resolve differently.
The sentences are English source. The **readings are values**, not text — `33.4`
is fixed at the moment the agent answered, but whether it prints as `33.4` or
`33,4` is decided when you read it. Waypoints are node ids, read back from the
live map so the transcript cannot disagree with it. Ask a question in English,
switch to Português, and the answer you already have reads as Portuguese prose
with Portuguese decimals over the same numbers.

Briefings are the exception that needed wiring: their long-form prose arrives
after the repaint that the language switch triggers, so the transcript is redrawn
a second time when it lands.

Numbers and dates go through `Intl` with the active locale, and place-name search
asks the geocoder in your language.

**These translations are machine-produced and have not been reviewed by native
speakers.** Every catalogue records `reviewed: false`. Before this reaches real
growers, `i18n/*.json` (short strings) and `i18n/prose/*.json` (long-form blocks)
should be reviewed — both are plain JSON keyed by the English source, so a
reviewer needs no tooling and no build step. Text in `{braces}` is substituted at
render time and must survive translation; a test enforces that, and another
enforces that HTML tag structure in prose blocks matches the English.

Delivery is split by what must survive a lost connection. Short strings — labels,
advisories, the event log — are **precached**. Long-form prose — the manual and
the briefings — is **fetched on first use** and then cached. The precached shell
is **217 KB gzipped**, of which `index.html` is 130 KB and the three catalogues
44 KB. (Three earlier drafts of this file were wrong here: one claimed "around
100 KB", the figure for `index.html` alone; one left 151 KB standing after the
deck and its detail screens had grown the shell; and one left 191 KB standing
after the first-run panel, the farm sheet and the drawn icons had grown it
again. Measure it rather than remembering it.)

All four are left-to-right, and the app carries no notion of direction at all —
no `dir` attribute, no mirrored stylesheet, no per-language direction field. A
right-to-left language would need that layout work done again; keeping unused
machinery alive against a language that may never come is how a codebase
accumulates rules nobody can test.

## What you tell it

The app made four assumptions on the grower's behalf and printed each one beside the number
it produced. They are questions now, in **Your farm** in the header, and every one of them is
already wired into a calculation — so answering one changes a call on the deck rather than
filing a preference.

| You set | It was assuming | What it decides |
|---|---|---|
| **Crop** | whatever the *synthesised* plot layout said | frost sensitivity, GDD base, days to maturity |
| **Soil texture** | mid-texture loam | the span between wilting point and field capacity — three times wider on a clay than on a sand |
| **Root zone** | 300 mm | total available water, and therefore the refill point |
| **Spray limits** | wind 20, gust 28, RH 40 % | when the spray window opens |

Every default is exactly the constant that was there before, so an untouched install computes
precisely what it computed yesterday. Answering is what changes things: set a sand soil on a
150 mm root zone and the water balance goes from *4 % depleted* to *0 %*, because 15 mm of
usable water is a different quantity from 60. The provenance follows — *"FAO-56 over a 300 mm
root zone, assumed mid-texture soil"* becomes *"over a 150 mm root zone on Sand, as you set
them"*. Text in a numeric field is refused rather than clamped: a field nobody answered
legibly is unanswered, and the honest value for it is the assumption the app was already
printing.

## Talking to it

The quick replies follow the deck. A fixed four — *soil moisture, frost risk, crop health,
full status* — asks the same thing on the morning of a frost as on a quiet Tuesday, so on the
day it matters the buttons are furniture. They now offer *Why can I not spray?* when there is
no window, *How much water?* when the call is irrigate, *Should I harvest early?* when frost
is in the forecast, and fall back to the standing four to fill the row. Each still resolves
to an intent the matcher answers, and a test puts every one of them through it.

They are repainted with the deck, which is the second half of that: computed once at boot
they were built before the first payload landed, when there was nothing contextual to say,
and then never rebuilt.

*Send as — Amara, Farmer, Plot F-2* has moved to Ops. It is simulation machinery: in real use
the reader is the farmer, the role tab has already said so, and choosing to speak as the buyer
is something you do while driving the simulation.

## Sources, on the page

Every feed the app can draw on is listed **directly under the controls and above everything
they produced**, in every role and at both widths — **whether it is active or not**, because
a source that is missing is exactly the one worth naming. *Open-Meteo LIVE · GloFAS LIVE · NASA GIBS OFF*, or the four simulated
instruments with their lock state when no location is loaded.

These chips existed from the first build but lived only in the Ops console, so from the day
the roles were split a grower could not see where their numbers came from without going to
find the instrumentation. Ops keeps its copy; one function builds both, and a test fails if
the two ever disagree about which feeds are up.

**The bars belong to the app, not to the phone.** Android draws the status bar and the
navigation bar around a page it cannot see, and dressed them from the phone's night mode:
choose Light on a dark phone and it drew white status-bar icons over a white header, with a
dark band behind both bars above and below a light app. The page now tells the wrapper which
theme it actually resolved to, the bar icons follow that, and the window ground is painted
the page's own `--plane` so the strip behind each bar matches what it borders. A test compares
the two colours Java spells out against the palettes, since that is the only thing stopping
them drifting.

Neither fixed bar is translucent any more either. `--header-bg` is 92 % alpha leaning on
`backdrop-filter`, and even where the browser blurs properly the remaining 8 % is legible —
a plot name and its status chip could be read straight across the tab labels.

The screen also has room at its edges now. The header clears the status bar and then leaves
a margin after it, and the tab bar does the same at the bottom. The clearance for the fixed
bar belongs on the **footer**, not on `main`: they are siblings, so padding `main` pushed a
large empty gap into the middle of the page and still left the last thing on it running
underneath the tab bar.

## Roles

A tab bar switches between Farmer, Buyer, Driver and Ops. Each shows only what that person
acts on; chat and simulation controls stay reachable in every role.

The app **opens on Farmer**, not on Ops. A first visit should land on the decisions rather
than on the instrumentation, and a stored choice still wins over that.

Ops is where the console lives. The mission clock, the four downlink chips, the readiness
tiles, the thermal chart, the raw table and the event log used to greet every visitor,
including the one whose question was whether to spray this afternoon. They are not deleted
— deleting them would answer *this reads like a console* by throwing away the part of the
app that earns the name. They are in Ops, where anyone who wants a downlink table finds
one and a grower never meets it.

## Simulation on top of real data

The event triggers still work on a live location — an injected excursion overrides the
live feed. Asking *"what would a frost tonight do to my order book here?"* against a real
catchment with real crops is the most useful thing this app does.

## Tests

```
node tests/run.js              # 822 checks, no dependencies, no network
node tests/run.js i18n -v      # filter by file, list every check
```

Six groups: **153 logic** (geography, Dijkstra, crop-aware orders, hysteresis, scoring,
downscaling, intent matching), **45 triage** (which group each call lands in, how an armed
advisory promotes a card and never demotes one, deadline ordering, and a check that every
rule a card claims is a rule the engine can actually arm), **109 live** (fetch and cache,
metric mapping, geocoding, catchment synthesis, agronomy, satellite tiling, and the deck
and its detail screens driven over a real payload, and a reopened session restored from
its own cache), **106 i18n** (engine, catalogue and
prose integrity — placeholders and HTML tag structure must survive translation — intent
keywords per language, a suite that switches language *after* a transcript and its advisories exist and
rereads them, and guards against the three regressions that actually happened: shadowing
the translator, dropping a prose key on its way to the message, and painting the chat
before the prose it needs has arrived),
**226 control-reachability** (every referenced element exists, every trigger names a real
code path, every quick reply resolves to an intent, every deck row opens a detail the
renderer answers for, the first-run panel replaces the deck and not a plot reading,
the theme survives a restart, the manual's numbers match the engine), and **161 PWA asset
integrity** (precache completeness, icon dimensions, cache strategy, safe-area insets, the
two dark palettes token by token, no raw colour in the script, no embedded credential).

The triage suite touches no DOM, which is what lets the ranking be tested on its own. That
matters more here than elsewhere: *All clear* is a promise, and a frost filed under it is a
lie the reader has no reason to go and check.

`tests/harness.js` boots the shipped inline script in a `vm` context against a stub DOM,
with a seeded PRNG, a virtual clock and a stubbed network — so the code under test is the
code that ships, a 72-hour forecast can be exercised in milliseconds, and a suite run on a
plane gives the same answer as one run at a desk.

CI runs the same command on Node 20, 22 and 24 (`.github/workflows/tests.yml`). There is
nothing to install and nothing to cache, because there are no dependencies.

**What the suite cannot tell you:** it drives the shipped script against a *stub* DOM.
Layout, the service worker, and anything that depends on a real rendering engine are
outside it — which is not theoretical. Opening the app in a browser found four things
580 passing checks did not:

- every `placeholder` and `aria-label` was still English — attributes are not text, so
  no DOM walk sees them, and the reader worst affected is the one using a screen reader;
- the Agronomy card's empty state, the panel a visitor sees *before* searching, had never
  been through `t()`;
- `gap-5` and five other utility classes were silently inert, because `app.css` is
  prebuilt and this project has no build step — that one showed up as `9,6 km19 min` in
  the driver's pane, and only in Portuguese, where the labels are long enough to push the
  values onto their own line;
- an installed copy kept serving the previous shell until `CACHE_VERSION` moved.

The first three are now guarded by tests. The fourth is a habit: **bump `CACHE_VERSION`
whenever you change a precached file**, or your testers will be looking at yesterday.

Restructuring the UI proved the point again. Driving the real app at five widths in four
languages found four more things that 718 passing checks did not:

- the deck was **invisible on every phone width**, because the Farmer pane's renderer
  assigns to its own `innerHTML` on every downlink and destroyed the deck seconds after it
  was filled — the same failure that once cost this app a driver's map;
- the detail sheet **opened by itself over the deck** on a phone, because the auto-select
  was gated on the desktop pane *existing* rather than being visible, and it exists at
  every width;
- a card promoted by an armed rule kept its own verdict, so the deck filed *Next 72 hours*
  under **Needs you** while the card read **Clear 72 h**;
- and with no location loaded the deck hid armed advisories behind *search for a location*.

The third is now a test. The first two are layout and stay the browser's job.

A second pass walked every rendered element at eight widths in four languages, with a
field in trouble so every alert branch was on screen, checking four things: content wider
than its own box, a child past its parent's edge, SVG text outside the graphic that owns
it, and the document scrolling sideways. It found headline chips leaving their cards in
*every* language, the sparkline pushing out of a narrow tile, the persona `<select>`
forcing the composer apart — and, not an overflow at all, that **the driver's map was
destroyed by its own pane's next re-render**, seconds after a phone user opened it. All
fixed. What remains is a 2px status dot deliberately overlapping the avatar it sits on.

Rebuilding the front page made the point a third time. 764 passing checks agreed that no
farm reading survives on a screen with no farm chosen, and they were right about every
surface they were looking at. Opening the app showed two they were not:

- the chat's **opening cascade read out the unchosen catchment** — moisture 31.3%, NDVI
  0.643, surface 28.8°C — and had a farmer asking after Plot F-2, which is the exact
  contradiction the panel had just been built to remove, arriving through a different door.
  No test saw it because every test that renders the chat sets `chosen` first, in order to
  have a chat worth reading;
- and **two search boxes** on a screen whose whole job is to ask one question, the header
  copy narrow enough on a phone to truncate its own placeholder.

Neither is a bug in a function. Both are what the screen actually said.

## iPhone

There is no App Store build and there is no Xcode project, because there is no Mac: iOS
binaries can only be compiled on macOS, and writing a wrapper here would mean committing
several hundred lines of Swift that nobody could build or test. What there is instead is the
thing iPhone has supported for years — **Safari → Share → Add to Home Screen** — which gives
the same app the Android package gives: its own icon, a standalone window with no browser
chrome, the service worker, and offline.

Being *compatible* with that is not the same as being *finished* for it. Three things were
wrong specifically for iPhone:

- **The status bar.** `apple-mobile-web-app-status-bar-style` was `black-translucent`, which
  runs the page under the bar *and* forces the bar's text white — white on white against this
  app's header. It ships `default` now, and `Theme.apply()` swaps it to `black` for a dark
  theme. Both hold the page below the bar, so both stay readable. **Best effort:** iOS reads
  that meta at load and runtime changes to it are not documented to work in an installed app.
  The failure mode was chosen deliberately — if the swap is ignored, a dark reader gets a
  light bar over a dark app, which is a seam and not an unreadable screen.
- **The launch screen.** There was none, so the icon opened on a blank rectangle. Twelve are
  generated by `icons/build-icons.js` from the same mark the icons use, on the app's own
  ground so it does not change colour as it opens. They are **not precached**: a device
  fetches exactly the one matching its screen, once, while the app is being added to the Home
  Screen — which is by definition online — and the service worker caches it on that fetch.
  Precaching all twelve would put a quarter of a megabyte nobody asked for into an atomic
  `cache.addAll`. A test still requires every one of them to exist, and to be exactly the size
  its media query claims.
- **Viewport height.** Safari's `vh` is the toolbar-retracted height, and under
  `viewport-fit=cover` `100vh` includes the home-indicator strip. Every `vh` rule now has a
  `dvh` line after it — the `vh` stays first, so a browser without `dvh` keeps what it had —
  and a test fails if a `vh` is ever added without one.

And one thing that was missing rather than wrong. Chrome fires `beforeinstallprompt` and
offers to install itself; **iOS fires nothing**, has no API for it, and buries the only route
two taps inside the Share sheet. So an iPhone reader had no way to discover this was
installable at all — which is the difference between shipping an iOS version and merely being
compatible with one. A single dismissible hint names the two taps, shown only in iOS Safari,
never inside the installed app, and never again once dismissed. iPadOS reports itself as a
Mac, so the touch-point count is what separates a tablet from a desktop; Chrome and Firefox
on iOS run the same WebKit behind their own share sheets and are excluded by name, because
the instruction would be wrong for them.

**What none of this can tell you**, and what only an iPhone will settle: whether iOS honours
the runtime status-bar swap in an installed app, whether the launch images are picked up,
what the safe-area insets really are on a notched device, and whether the service worker
installs and serves offline under iOS's storage rules. Everything above was driven in a
desktop browser with an iOS user agent and a simulated home indicator, which is as close as a
Windows machine gets.

## Android

An installable APK lives in `android/`. It is a wrapper, not a port: the same `index.html`,
`app.css` and `sw.js` that serve the web app are copied into the package and served from
`https://appassets.androidplatform.net/` by `WebViewAssetLoader`. That is a real secure
origin rather than `file://`, so the service worker registers and every caching strategy
described above works unchanged — including a first launch with no network, which a wrapper
around a hosted URL could not manage.

```
cd android
./gradlew assembleDebug        # writes android/AURA-AgriNet-1.0-debug.apk
```

**Gradle has to be told where JDK 17 is, and `java` is not necessarily on your `PATH`.**
Two machine-specific paths matter, and only one of them is the Android plugin's business:

| Path | Lives in | Read by |
|---|---|---|
| Android SDK | `android/local.properties`, as `sdk.dir` | the Android Gradle plugin |
| JDK 17 | `JAVA_HOME`, or `org.gradle.java.home` | Gradle itself |

Neither belongs in a committed file. `local.properties` is gitignored for exactly that
reason; `android/gradle.properties` is not, so the JDK path does not go there. Export it
for the shell you build in:

```bash
export JAVA_HOME="C:/Users/danil/AppData/Local/Programs/Java/jdk-17.0.20+8"
./gradlew assembleDebug
```

Forward slashes, as in `local.properties`, and for the same reason: a `.properties` file
treats a backslash as an escape, and the habit is worth keeping in the shell too.

That path is where the JDK sits on the machine this was built on, and it will not be yours.
The usual homes are `C:/Program Files/Java`, `C:/Users/<you>/AppData/Local/Programs/Java`,
and the JBR that Android Studio bundles at `<studio>/jbr`. To make the choice stick without
committing it, set `org.gradle.java.home` in your **user-level** `~/.gradle/gradle.properties`
rather than the one in this repository — at the cost that it then applies to every Gradle
build on the machine, not only this one.

Both paths fail loudly when they are wrong, so a bad answer here costs you an error message
rather than a package that looks fine and is not.

Gradle's own output lands five directories down at
`android/app/build/outputs/apk/debug/app-debug.apk`, under a name that says neither which
app nor which version, so every assemble copies it up beside the build file as
`android/AURA-AgriNet-1.0-debug.apk`. The copy is wired into the build rather than made by
hand: a stale package that looks current is worse than a buried one that is honest.

Install it with `adb install -r android/AURA-AgriNet-1.0-debug.apk`. It carries the debug
signing key, so it is for sideloading and testing, not for the Play Store. The APK is
**gitignored build output** — this repository carries the project that produces the
package, never the package itself.

**This adds a build step and dependencies — to the APK, not to the web app.** The root of
this repository still has neither. `android/` wants JDK 17 and the Android SDK, and Gradle
downloads three AndroidX artifacts: `webkit` for the asset loader, `activity` for the back
dispatcher, `core` for window insets. Every version is pinned in
`android/gradle/libs.versions.toml` — including a Kotlin BOM, which a project containing no
Kotlin needs anyway because `androidx.core` pulls in coroutines 1.6.4, which still asks for
`kotlin-stdlib-jdk8` after Kotlin 1.8 folded those classes back into `kotlin-stdlib`.

The wrapper replaces what a browser supplied for free. Geolocation is bridged to a runtime
permission, asked for on a tap as before. `ACCESS_NETWORK_STATE` is granted, without which
WebView reports `navigator.onLine` as true forever and the *Offline · cached* chip would
never appear. Back closes the manual or the simulation sheet before it closes the app,
because the shell registers no history entries and would otherwise quit under an open
dialog. Rotation is handled without recreating the Activity, which would reload the app and
destroy the driver's map.

Launching shows the mark on the app's own oat ground rather than a blank window, and the
splash is held until the shell actually paints — `onPageCommitVisible`, not
`onPageFinished`, which would wait for every subresource long after there is something
worth looking at. A four-second timeout releases it if a load never commits. The launcher
icon is a vector, with a monochrome layer so Android 13's themed icons follow the wallpaper
like everything else on the home screen.

**The mark has one source.** It is a sensor footprint over a point of ground with the
platform passing overhead: a faint orbit carrying the satellite, a scan ring broken where
the downlink passes through, a solid core for the point being measured. That geometry
appears in six places — the header SVG, four PNGs, and two Android vector drawables — so
`icons/build-icons.js` holds the numbers and generates the PNGs, and a test fails if the
header SVG or the shipped `icon-192.png` stops agreeing with it. The generator writes PNGs
by hand with `zlib`, because adding an image library to a repository that advertises zero
dependencies in order to draw four circles would be a poor trade.

The asset copy is defined by **exclusion**, so a web file added later ships by default and
the failure mode is a slightly larger APK rather than a file that 404s in a field. Two tests
guard the seams that no build error would catch: one fails if anything `sw.js` precaches has
been excluded from the package, the other if either element id the back button probes stops
existing in `index.html`. The `i18n/prose` catalogues ride along too, so the manual works
offline from first launch rather than first use.

**Not yet run on hardware.** It builds, and the package contains what it should. No device
was available, so service-worker registration, the geolocation prompt, the back button and
the window insets have not been exercised on a real Android runtime. `chrome://inspect`
reaches a debug build once installed, which is the fastest way to check the first of those.
The practical floor is not `minSdk 24` but the installed Android System WebView, which
updates independently of the OS: `minSdk` describes what will install, not what will render.

## Licence

MIT — see `LICENSE`. The observations come from third parties on their own terms
(Open-Meteo CC BY 4.0, Copernicus, NASA GIBS); attribution for each is shown in the app
beside the numbers it produces.
