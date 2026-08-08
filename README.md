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

## Roles

Below 1024px a bottom tab bar switches between Farmer, Buyer, Driver and Ops views.
Each shows only what that person acts on; the chat and simulation controls remain
reachable in every role.

## Regions

Ghana (Somanya), Nigeria (Oyo) and USA (Fresno) — real WGS-84 coordinates, with edge
distances derived as `haversine × road sinuosity` rather than hardcoded.

## Tests

255 automated checks: 155 logic, 54 control-reachability, 46 PWA asset integrity.
