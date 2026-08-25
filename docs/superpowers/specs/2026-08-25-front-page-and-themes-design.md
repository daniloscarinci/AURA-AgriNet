# A front page that asks one question, a session that comes back live, and a theme you can choose

**Status:** approved · **Date:** 2026-08-25

## The problem

Three of them, found by walking the app rather than reading it.

**The first screen contradicts itself.** A new visitor lands on the Farmer deck, which says
*"These calls need a real location. Search for one above"* — while the search box beside it
already reads *Somanya · Eastern Region*, because `renderRegionPicker` writes the seeded region's
name into it on boot. Below both, `renderFarmer` draws moisture, NDVI and surface temperature for
that Ghanaian demo farm. The page gives two contradictory answers to *where am I?* within three
centimetres, and nothing tells a grower that the app's one prerequisite is a location.

**Reopening the app loses your readings.** `boot()` restores `State.data.place` and rebuilds the
catchment from its coordinates, then stops. It never calls `Live.ensure`, and it never reads the
`aura-live-` cache that `Live.persist()` has been writing all along. So `Live.ready()` is false on
every reload: the deck falls back to its empty notice, the header chip reads *Simulated*, and the
app asks you to search for the farm whose name is sitting in the search box. Keeping the farm you
searched for was fixed once, in the commit that named itself after it; keeping its numbers was not.

**Light and dark exist and cannot be chosen.** The stylesheet carries a full, warm-shifted dark
palette in two blocks — one behind `prefers-color-scheme`, one behind `[data-theme="dark"]` — and
both `theme-color` metas are declared and already tested. Nothing in the script block has ever set
`data-theme`. The app follows the operating system, and the explicit half of that CSS has never
once applied.

## What the app becomes

### The front page asks one question

Before a farm is chosen, the Farmer front page is a single panel: **Where is your farm?**, one
sentence saying why the app needs the answer, a search field with the ◎ button, three example
catchments, and four lines naming what arrives once the question is answered.

The panel is static markup toggled by `body[data-firstrun]`, not `innerHTML` from `renderDeck`.
The deck hosts are rewritten on every telemetry event, and a focused search input inside one would
be destroyed between keystrokes — the failure that has already cost this app its deck and, twice,
the driver's map.

While it is up, three things stop rendering: the *needs a real location* notice, which the panel
now says properly; `farmerExtra`, which is where the Ghanaian numbers come from; and the
pre-filled search box, which goes back to showing its placeholder.

The three example chips are the catchments `REGIONS` already ships. Each fires
`goToLocation({builtin: id})` — the path that exists today and already fetches live data — so one
tap gives a full live deck without ever putting an unasked-for farm on screen as if it were yours.

**A new flag, `State.data.chosen`**, decides this. It turns true the first time `goToLocation`
succeeds for any pick, and it is its own flag rather than `place !== null` because a built-in pick
leaves `place` null. Snapshots written before this ships infer it from `place`, or from a
`regionId` that is not the default, so nobody who already chose a farm is asked again.

This gate is the Farmer front page alone. Buyer, Driver and Ops keep the seeded region, because
the routing graph needs `NODES` and `EDGES` and the footer has always declared that simulation.

### A session comes back live

`goToLocation`'s tail — re-seed telemetry, rebuild edges, rebuild the route, recompute scoring,
repaint everything, refresh imagery — becomes `applyPayload`, and boot calls the same function.
The messaging stays in each caller, because a restore and a switch should not say the same thing.
What matters is that the boot path can no longer drift from the switch path by forgetting a
repaint, which is exactly how it broke.

Boot then does three things in order. Before the first paint it calls `Live.restore` for the
stored coordinates — from `State.data.place` for a searched farm, from `REGIONS[id].centre` for a
built-in — so the first frame carries real numbers. After the paint it re-fetches in the
background. If nothing is cached and nothing answers, the app is exactly where it is today:
simulated and labelled, except now it says so about a farm it can name.

The age of a restored reading is stated, not hidden. `Live.statusLine` already produces *Stale —
fetched 14 h ago* and *Offline — last good reading 2 d ago*, and the header chip already renders
them. This adds no honesty vocabulary; it reaches the vocabulary that was already there.

The same bug wears one more coat: leave the app open overnight and this morning's calls are
computed from yesterday's forecast. The `visibilitychange` handler re-fetches when the tab returns
and `Live.isFresh()` is false.

### Light and dark become a choice

The palettes do not change. What gets built is the control that reaches them.

A `Theme` module, shaped like `I18n` rather than inventing a second pattern: `initial()`,
`apply()`, `set(mode)`, a `localStorage` key, and an application in `boot()` before the first
paint. Three modes, because the CSS was written for three — `:not([data-theme="light"])` only
means something if *match system* is reachable. Light and dark set the attribute; system removes
it.

The control mirrors the language button and its menu: same markup shape, same stylesheet, same
open and close. Its glyph shows the setting rather than the resolved theme, so *match system*
reads ◐ and the code never has to ask `matchMedia` what the system currently thinks.

`theme-color` follows the choice. The two media-based metas are right for *match system* and wrong
the moment a reader forces dark on a light machine, where the browser's own chrome stays oat while
the page goes to soil. An explicit choice writes both metas to that theme's ground colour; *match
system* restores the split.

Three hardcoded colours that never went through a token are closed at the same time: the driver
marker's label, which was near-black on ochre and poor contrast in the light theme it was written
for, and two copies of a red that belongs to neither palette.

## What does not change

The honesty contract, the agronomy arithmetic, Dijkstra routing, crop-aware order revision, the
event engine, four languages at full depth, zero dependencies, no build step, one HTML file.

The dark palette stays duplicated across its two blocks rather than collapsing into `light-dark()`,
which would cost Chrome 123, Safari 17.5 and Firefox 120 as a floor — too much to spend on an app
that ships an APK onto whatever system WebView a device happens to carry. A test asserts the two
blocks declare the same tokens with the same values, which is how this repository already stops
the deck and the detail pane from drifting.

## What it costs

Every new English string needs its three translations in the same commit, or `meta.coverage` stops
matching what the catalogue holds and the i18n suite fails. `CACHE_VERSION` moves, because
`index.html` is precached and an installed copy otherwise serves yesterday's build.
