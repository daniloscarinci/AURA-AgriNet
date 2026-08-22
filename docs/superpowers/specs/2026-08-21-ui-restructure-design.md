# UI/UX restructure — a triage deck, and a console that stops shouting

**Status:** approved · **Date:** 2026-08-21

## The problem

The app reads as a mission console. A mission clock, four downlink chips, a
readiness score, twenty telemetry tiles and an event log greet a grower whose
question is whether to spray this afternoon. Everything appears at once, so
nothing is ranked. Below 1024 px the roles exist; above it they vanish and every
visitor gets the Ops console whether they wanted it or not. On a phone held
upright the shell runs under the status bar at the top and under the gesture bar
at the bottom.

Four rounds of browser mockups settled the direction. This spec records what was
chosen and what it costs.

## What the app becomes

**A triage deck.** Each role opens on its own decisions, grouped by whether they
need you:

- **Needs you** — expanded, with the chart that justifies the call.
- **Watching** — one line each, with a sparkline.
- **Clear** — one line each.

A quiet day collapses to a short screen and looks quiet. Tapping any row opens a
**detail sheet** carrying the chart, the inputs, the provenance and the actions.
At 1024 px and above the deck moves to a left rail and the sheet's content
becomes the pane beside it — the same markup, re-parented.

**Ops keeps the console.** The answer to "this reads like a console" is not to
delete the console. The mission clock, downlink chips, readiness tiles, thermal
chart, raw table and event log move into the Ops role, where anyone who wants
them finds them and a grower never meets them.

## What does not change

The honesty contract survives intact, and the restructure exists partly to serve
it better. Every number keeps its label — modelled, derived, simulated — and
provenance gains a permanent home in the detail sheet rather than a grey line
under a tile. The live / offline-cached chip stays in the header.

Also unchanged: the agronomy arithmetic, Dijkstra routing, crop-aware order
revision, the event engine, four languages at full depth, zero dependencies, no
build step, and one HTML file.

## Triage rules

Each agronomy card already computes a `tone` of `act`, `warn` or `ok`
(`index.html:3821`, `3846`, `3875`). The deck reads that field instead of
inventing a second severity vocabulary.

| Card | Needs you | Watching | Clear |
|---|---|---|---|
| Water balance | `call === 'irrigate'` | `call === 'monitor'` | `call === 'hold'` |
| Spray & fieldwork | no window in 48 h | window opens later | window open now |
| Next 72 hours | `verdict === 'frost'` | `heat` or `marginal` | `clear` |
| Trafficability | any segment below the passability floor | mean falling, or river above the 75th percentile | otherwise |
| Heat units | never | never | always |

Two rules sit on top:

1. **An armed advisory outranks its card.** A `critical` or `serious` entry in
   `State.data.alerts` pins its card to *Needs you* whatever the tone says. The
   rule engine and the deck must never disagree on screen.
2. **Ties break by deadline.** Within a group, the call that bites soonest sorts
   first.

Trafficability becomes the fifth card. Today it is a tile and a route chip, which
buries the one reading that decides whether the crop can leave the farm.

## Layout

### Phone, below 1024 px

A header of one row — place, live chip, language, manual — then the deck, then
the role tab bar. Ask docks as a bar above the tab bar and opens to full height.
Detail opens as a bottom sheet.

### Desktop, 1024 px and above

Header, then three columns: the deck as a left rail at 340 px, the detail pane
filling the middle, and Ask as a collapsible right rail. Selecting a row fills
the pane; nothing waits behind a tap on a screen with room to spare.

Driver is the exception, and deliberately: the map fills the pane, because there
the map is the subject rather than a panel.

### Safe areas

`env(safe-area-inset-*)` appears four times in the stylesheet already and
resolves to zero every time, because the viewport meta never opted in. Three
changes fix it:

- add `viewport-fit=cover` to the viewport meta;
- resolve the insets once into `--safe-t` and `--safe-b` on `:root`;
- pad the header by `--safe-t` and the tab bar, sheet and docked composer by
  `--safe-b`.

The Android wrapper already pads the WebView itself
(`MainActivity.java:122`), so this fixes the browser and the installed PWA and
leaves the APK correct.

## Components

New CSS lives in the inline `<style>` block. **`app.css` is prebuilt and this
project has no build step, so a new Tailwind utility class does nothing** —
`gap-5` shipped inert once already.

| Class | Purpose |
|---|---|
| `.deck` | the column, and the rail above 1024 px |
| `.deck-group` | a triage heading with its count |
| `.deck-row` | one collapsed call |
| `.deck-card` | one expanded call |
| `.detail` | sheet body and pane body, one rule for both |
| `.prov-block` | where this came from |

`.sheet`, `.sheet-panel` and `.sheet-grab` already exist for the simulation
sheet and serve the detail sheet unchanged. Scrim dismissal is wired at
`index.html:6321`, and the Android back button already closes
`['manualLayer','simSheet']` before quitting — the detail sheet joins that array.

## Charts

Every call carries the evidence for itself:

- **Water** — depletion against the refill point, plus rain and ET₀ as paired
  bars seven days either side of now, forecast bars drawn lighter.
- **Spray** — wind against its limit over 48 h, with usable windows shaded and
  the next one marked.
- **Frost** — hourly temperature over 72 h against the freezing line.
- **Heat units** — accumulation toward maturity, the forecast half dashed.
- **Trafficability** — river discharge percentile against the passability floor.

All are inline SVG with a `viewBox`, as the thermal chart is today. No library.

## Internationalisation

Every new string goes through `t()` and lands in `i18n/es.json`, `fr.json` and
`pt.json`, which carry 446 keys each today. Placeholders in `{braces}` must
survive translation; a test enforces it. Attributes need `data-i18n-attr` — a DOM
walk cannot see a `placeholder` or an `aria-label`, and the reader worst served
by an untranslated one uses a screen reader.

Estimate: 60 to 80 new keys per language.

## Tests

The suite runs 633 checks today and must run green at the end of every stage.

Control reachability adapts by itself: it scans the source for `el('x')` and
checks the markup defines it, so renames stay honest without editing the test.
Three suites need new checks:

- **triage classification** — a fixed set of readings lands each card in the
  expected group, including the advisory override;
- **safe area** — the viewport meta carries `viewport-fit=cover`, and the header
  and tab bar consume the insets;
- **deck reachability** — every deck row opens a detail sheet that exists.

`tests/i18n.test.js:742` reads `paneFarmer` and needs updating when the pane's
contents change.

Bump `CACHE_VERSION` in `sw.js`. An installed copy serves the old shell until it
moves, and testers then review yesterday's app.

## Staging

Each stage leaves the app working and the suite green.

1. **Safe areas.** Small, independent, valuable on its own.
2. **Triage engine.** Classification and ordering, with tests, before any markup.
3. **Farmer deck.** The deck replaces the Farmer pane and the agronomy grid.
4. **Detail sheet.** Sheet on phone, and the same content as a pane above
   1024 px.
5. **Ops absorbs the console.** Clock, chips, tiles, thermal chart, table and log
   move; Buyer and Driver adopt the deck.
6. **Catalogues, tests and cache version.** Four languages verified by rendering,
   not by inspection.

## Known limits

The suite drives the shipped script against a stub DOM. Layout, the service
worker and anything needing a rendering engine fall outside it, which is how
`gap-5` shipped inert and how a driver's map was destroyed by its own pane's
re-render. This restructure touches layout on every screen, so it needs a pass in
a real browser at several widths in all four languages, with a field in trouble
so every alert branch paints.

No Android device is available, so the safe-area fix stays unverified on hardware
— exactly as the APK itself is.
