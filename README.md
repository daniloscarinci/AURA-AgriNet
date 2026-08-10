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

The app never presents a stale number as current, and never invents one.

## Real-time decisions

Four cards, computed from the live series:

- **Water balance** — FAO-56 over a 300 mm root zone. Depletion against the refill point,
  7-day rain and ET₀, and an *irrigate N mm* / *hold* call that defers when rain is coming.
- **Next 72 hours** — hourly air temperature, hours at or below freezing, and how long
  until the frost window opens.
- **Spray & fieldwork** — wind, gusts, humidity and rain probability over 48 h, resolved
  into good / marginal / do-not-spray hours and the next usable run.
- **Heat units** — growing-degree days against the crop's base temperature, with days to
  maturity at the current rate.

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
report zero. The chat and the advisory cards are swept the same way — every
intent asked, every briefing played and every rule armed in English, then the
language switched and the whole lot reread: 65 translated sources and 4
advisories per language, zero English survivors, zero English decimal
separators.

One surface is knowingly behind: the **role panes** below 1024px still hold
around twenty English labels of their own (`My plots`, `Order book`, `Hold
position`, `Next stop`) that were never routed through `t()`. The advisory cards
inside those panes are translated; the furniture around them is not.

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
the briefings — is **fetched on first use** and then cached, keeping the install
around 100 KB.

All four are left-to-right, and the app carries no notion of direction at all —
no `dir` attribute, no mirrored stylesheet, no per-language direction field. A
right-to-left language would need that layout work done again; keeping unused
machinery alive against a language that may never come is how a codebase
accumulates rules nobody can test.

## Roles

Below 1024px a bottom tab bar switches between Farmer, Buyer, Driver and Ops views. Each
shows only what that person acts on; chat and simulation controls stay reachable in every
role.

## Simulation on top of real data

The event triggers still work on a live location — an injected excursion overrides the
live feed. Asking *"what would a frost tonight do to my order book here?"* against a real
catchment with real crops is the most useful thing this app does.

## Tests

```
node tests/run.js              # 573 checks, no dependencies, no network
node tests/run.js i18n -v      # filter by file, list every check
```

Five groups: **151 logic** (geography, Dijkstra, crop-aware orders, hysteresis, scoring,
downscaling, intent matching), **77 live** (fetch and cache, metric mapping, geocoding,
catchment synthesis, agronomy, satellite tiling), **i18n** (engine, catalogue and prose
integrity — placeholders and HTML tag structure must survive translation — intent
keywords per language, a suite that switches language *after* a transcript and its advisories exist and
rereads them, and guards against the three regressions that actually happened: shadowing
the translator, dropping a prose key on its way to the message, and painting the chat
before the prose it needs has arrived),
**control-reachability** (every referenced element exists, every trigger names a real
code path, every quick reply resolves to an intent, the manual's numbers match the
engine), and **PWA asset integrity** (precache completeness, icon dimensions, cache
strategy, no embedded credential).

`tests/harness.js` boots the shipped inline script in a `vm` context against a stub DOM,
with a seeded PRNG, a virtual clock and a stubbed network — so the code under test is the
code that ships, a 72-hour forecast can be exercised in milliseconds, and a suite run on a
plane gives the same answer as one run at a desk.
