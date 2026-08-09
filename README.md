# AURA-AgriNet 1.0

**Autonomous Unified Remote-sensing Agent for Agricultural Micro-Logistics.**

An installable offline-first PWA that fuses simulated NASA SMAP, ESA Sentinel-1/2 and
thermal-IR telemetry into frost, drought and flood advisories, then drives real
operational consequences: early-harvest warnings, crop-aware buyer order revisions, and
Dijkstra rerouting of delivery drivers around impassable roads.

## Honest scope

This is a **working decision engine running on synthetic telemetry**. The distinction
that matters:

- **Real:** Dijkstra pathfinding, haversine distances, the map projection, hysteresis on
  every rule, crop-aware order logic, the intent matcher, the PWA offline shell.
- **Simulated:** every telemetry reading is a bounded random walk. No network calls are
  made. `R-14 "Ford X-1"` is not a real crossing — coordinates are fabricated points
  near real towns.

The app is deliberately honest about instrument granularity, which most demos in this
space gloss over: a **9 km SMAP pixel cannot resolve a 1.4 ha plot**, so per-plot soil
moisture is labelled `≈ downscaled · conf 0.55`, while Sentinel-2 NDVI at 10 m is
labelled `✓ measured`. CROP-CASMA is CONUS-only and its chip greys out outside the US.

## Run it

```
serve.cmd            # or: python -m http.server 8080
```

Then open <http://localhost:8080>. A service worker will **not** register over
`file://`, so opening `index.html` directly gives you the app without offline support.

## Manual

A **Manual** button in the header (or `?`) opens a seven-section guide over the
console: what the app does, the four feeds, real vs simulated, how an advisory
becomes an action, reading the map, six runnable scenarios, and a threshold
reference. `Esc` closes it.

It generates its tables from the running configuration rather than restating it —
the feed table from `SOURCES`/`METRICS`, every threshold from `CFG.THRESH`, the
crop sensitivities from `CROPS`. Change a threshold and the manual changes with
it; a test fails if the two ever disagree. The scenario buttons carry the same
`data-trigger` attribute the console buttons do, so the manual cannot demonstrate
a code path the app does not have.

## Roles

Below 1024px a bottom tab bar switches between Farmer, Buyer, Driver and Ops views.
Each shows only what that person acts on; the chat and simulation controls remain
reachable in every role.

## Regions

Ghana (Somanya), Nigeria (Oyo) and USA (Fresno) — real WGS-84 coordinates, with edge
distances derived as `haversine × road sinuosity` rather than hardcoded.

## Tests

```
node tests/run.js              # 377 checks, no dependencies
node tests/run.js manual -v    # filter by file, list every check
```

377 checks in three groups: **151 logic** (geography, Dijkstra, crop-aware orders,
hysteresis, scoring, downscaling, intent matching), **137 control-reachability**
(every referenced element exists, every trigger names a real code path, every quick
reply resolves to an intent, the manual's numbers match the engine), and **89 PWA
asset integrity** (precache completeness, icon dimensions, offline independence).

`tests/harness.js` boots the shipped inline script in a `vm` context against a stub
DOM, with a seeded PRNG and a virtual clock — so the code under test is the code
that ships, ingestion can be driven a minute at a time in milliseconds, and a
bounded-random-walk assertion means the same thing on every run.
