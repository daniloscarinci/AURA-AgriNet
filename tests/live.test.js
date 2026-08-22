/* Live data, geocoding, catchment synthesis, agronomy and satellite imagery.

   Hermetic: the network is stubbed with a fixture shaped like a real Open-Meteo
   response. A suite that actually called the service would pass or fail with the
   weather, and would fail entirely on a plane — which is the exact situation this
   part of the app exists to handle gracefully.

   The fixture is generated, not copied, so a test can shape the weather it needs
   (a frost, a drought, a flood) and assert the decision that follows. */
'use strict';

const fs = require('fs');
const path = require('path');
const { boot, ROOT } = require('./harness');

module.exports = ({ suite, test, assert }) => {

  /* ---------------------------------------------------------------- fixture */

  const HOURLY_FIELDS = ['temperature_2m','relative_humidity_2m','precipitation','precipitation_probability',
    'wind_speed_10m','wind_gusts_10m','soil_temperature_0cm','soil_moisture_3_to_9cm',
    'soil_moisture_0_to_1cm','et0_fao_evapotranspiration','cloud_cover'];

  /** A forecast payload covering 7 past + 3 forecast days at hourly resolution,
      with every field a constant unless overridden. `at` lets a test drive one
      field as a function of the hour index. */
  function forecast(over = {}, at = {}) {
    const HOURS = 240;
    const start = Date.UTC(2026, 7, 2, 0, 0, 0);         // 2026-08-02T00:00Z
    const iso = ms => new Date(ms).toISOString().slice(0, 16);
    const base = {
      temperature_2m: 20, relative_humidity_2m: 60, precipitation: 0,
      precipitation_probability: 5, wind_speed_10m: 8, wind_gusts_10m: 14,
      soil_temperature_0cm: 21, soil_moisture_3_to_9cm: 0.26,
      soil_moisture_0_to_1cm: 0.24, et0_fao_evapotranspiration: 0.15, cloud_cover: 30,
    };
    const hourly = { time: [] };
    HOURLY_FIELDS.forEach(f => { hourly[f] = []; });
    for (let i = 0; i < HOURS; i++) {
      hourly.time.push(iso(start + i * 3600000));
      HOURLY_FIELDS.forEach(f => {
        const v = at[f] ? at[f](i) : (over[f] !== undefined ? over[f] : base[f]);
        hourly[f].push(v);
      });
    }
    const days = [];
    for (let d = 0; d < 10; d++) days.push(new Date(start + d * 86400000).toISOString().slice(0, 10));
    return {
      latitude: 6.095, longitude: 0.042, elevation: 29,
      utc_offset_seconds: 0, timezone: 'GMT',
      hourly_units: { soil_moisture_3_to_9cm: 'm³/m³', temperature_2m: '°C' },
      current: { time: iso(start), ...base },
      hourly,
      daily: {
        time: days,
        temperature_2m_min: days.map(() => over.tmin !== undefined ? over.tmin : 15),
        temperature_2m_max: days.map(() => over.tmax !== undefined ? over.tmax : 27),
        precipitation_sum: days.map(() => 2),
        et0_fao_evapotranspiration: days.map(() => 4),
        precipitation_hours: days.map(() => 3),
      },
    };
  }

  function flood(discharge) {
    const start = Date.UTC(2026, 7, 2);
    const days = [];
    for (let d = 0; d < 10; d++) days.push(new Date(start + d * 86400000).toISOString().slice(0, 10));
    return { daily: { time: days, river_discharge: days.map((_, i) => discharge[i % discharge.length]) } };
  }

  const GEO = {
    results: [{ id: 1, name: 'Kisumu', admin1: 'Kisumu County', country: 'Kenya', country_code: 'KE',
                latitude: -0.10221, longitude: 34.76171, elevation: 1174, timezone: 'Africa/Nairobi',
                population: 397957 }],
  };

  /** A fetch stub that routes by hostname and records what was asked for. */
  function stub(opts = {}) {
    const calls = [];
    const fn = url => {
      calls.push(String(url));
      const u = String(url);
      const body = u.includes('geocoding-api') ? (opts.geo || GEO)
                 : u.includes('flood-api')     ? (opts.flood !== undefined ? opts.flood : flood([10, 12, 11]))
                 : (opts.forecast || forecast());
      if (body === null) return Promise.reject(new Error('service down'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
    fn.calls = calls;
    return fn;
  }

  const live = (o = {}) => {
    const h = boot({ fetch: stub(o), ...(o.bootOpts || {}) });
    h.app.Telemetry.stop();
    return h;
  };
  const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);            // mid-window, day 7 of 10

  /* ============================================================ transport == */
  suite('live · fetch and cache', () => {
    test('a successful load reports the network as its source', async () => {
      const h = live();
      const r = await h.app.Live.ensure(6.095, 0.042, 'Somanya');
      assert.equal(r.source, 'network', 'did not use the network');
      assert.ok(h.app.Live.ready(), 'payload not retained');
    });

    test('the forecast request asks for every field the app reads', async () => {
      const h = live();
      const f = h.window.fetch;
      await h.app.Live.ensure(6.095, 0.042);
      const wx = f.calls.find(c => c.includes('api.open-meteo.com'));
      ['soil_moisture_3_to_9cm', 'soil_temperature_0cm', 'et0_fao_evapotranspiration',
       'wind_gusts_10m', 'precipitation_probability'].forEach(field =>
        assert.includes(wx, field, `${field} is used by the app but never requested`));
    });

    test('the request asks for past days as well as forecast', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      const wx = h.window.fetch.calls.find(c => c.includes('api.open-meteo.com'));
      assert.includes(wx, 'past_days=', 'no history requested, so a 7-day water balance is impossible');
    });

    test('a successful load is cached to localStorage', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042, 'Somanya');
      const keys = [...h.storage.keys()].filter(k => k.startsWith('aura-live-'));
      assert.equal(keys.length, 1, `expected one cache entry, got ${keys.length}`);
    });

    test('the cache key is the rounded coordinate, so one place reuses one entry', async () => {
      const h = live();
      await h.app.Live.ensure(6.0951, 0.0422);
      await h.app.Live.ensure(6.0952, 0.0421);
      assert.equal([...h.storage.keys()].filter(k => k.startsWith('aura-live-')).length, 1,
        'nearly-identical coordinates created separate cache entries');
    });

    test('offline with a cache serves the cache, not a failure', async () => {
      const warm = live();
      await warm.app.Live.ensure(6.095, 0.042, 'Somanya');
      const cold = boot({ online: false, storage: Object.fromEntries(warm.storage) });
      cold.app.Telemetry.stop();
      const r = await cold.app.Live.ensure(6.095, 0.042);
      assert.equal(r.source, 'cache', 'did not fall back to the cache');
      assert.ok(cold.app.Live.ready(), 'cached payload not usable');
    });

    test('offline with no cache reports no data rather than inventing one', async () => {
      const h = boot({ online: false });
      h.app.Telemetry.stop();
      const r = await h.app.Live.ensure(1, 1);
      assert.equal(r.source, 'none', 'claimed to have data it does not have');
      assert.notOk(h.app.Live.ready(), 'reports ready with nothing loaded');
    });

    test('a network failure falls back to cache rather than throwing', async () => {
      const warm = live();
      await warm.app.Live.ensure(6.095, 0.042);
      const broken = boot({ storage: Object.fromEntries(warm.storage),
                            fetch: () => Promise.reject(new Error('DNS')) });
      broken.app.Telemetry.stop();
      const r = await broken.app.Live.ensure(6.095, 0.042);
      assert.equal(r.source, 'cache', 'a failed fetch did not fall back');
    });

    test('a missing river service degrades one metric, not the whole load', async () => {
      const h = live({ flood: null });
      const r = await h.app.Live.ensure(6.095, 0.042);
      assert.ok(r.payload, 'the whole load failed because GloFAS did');
      assert.equal(r.payload.river, null, 'river should be absent, not fabricated');
      assert.ok(h.app.Live.metricAt('traff', NOW), 'trafficability should still compute without a river');
    });

    test('status reports live when fresh and cached when offline', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      assert.equal(h.app.Live.statusLine().mode, 'live', 'fresh data not reported as live');
      const cold = boot({ online: false, storage: Object.fromEntries(h.storage) });
      cold.app.Telemetry.stop();
      await cold.app.Live.ensure(6.095, 0.042);
      assert.equal(cold.app.Live.statusLine().mode, 'cached', 'offline not reported as cached');
    });

    test('with nothing loaded the status says simulated', () => {
      const h = live();
      assert.equal(h.app.Live.statusLine().mode, 'simulated', 'claimed real data before any load');
    });
  });

  /* =========================================================== metric map == */
  suite('live · mapping to metrics', () => {
    test('soil moisture is converted from m³/m³ to percent', async () => {
      const h = live({ forecast: forecast({ soil_moisture_3_to_9cm: 0.281 }) });
      await h.app.Live.ensure(6.095, 0.042);
      assert.close(h.app.Live.metricAt('moisture', NOW).v, 28.1, 0.01, 'unit conversion wrong');
    });

    test('surface temperature comes from the soil sensor, not the air', async () => {
      const h = live({ forecast: forecast({ soil_temperature_0cm: 31, temperature_2m: 19 }) });
      await h.app.Live.ensure(6.095, 0.042);
      assert.close(h.app.Live.metricAt('temp', NOW).v, 31, 0.01, 'used air temperature for surface temp');
    });

    test('NDVI reports no live source rather than guessing', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      assert.equal(h.app.Live.metricAt('ndvi', NOW), null,
        'NDVI has no keyless point source and must not pretend otherwise');
    });

    test('every live value carries provenance naming its real source', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      ['moisture', 'temp', 'stress', 'traff'].forEach(k => {
        const m = h.app.Live.metricAt(k, NOW);
        assert.ok(m && m.prov, `${k} has no provenance`);
        assert.ok(m.prov.source && m.prov.kind, `${k} provenance is incomplete`);
        assert.notIncludes(['SMAP', 'Sentinel-1', 'Sentinel-2'], m.prov.source,
          `${k} is labelled as a satellite retrieval it is not`);
      });
    });

    test('no live metric claims to be a direct measurement', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      Object.values(h.app.Live.PROV).forEach(p =>
        assert.includes(['modelled', 'derived', 'simulated'], p.kind,
          `provenance kind "${p.kind}" implies more than the data supports`));
    });

    test('stress rises as soil dries', async () => {
      const wet = live({ forecast: forecast({ soil_moisture_3_to_9cm: 0.31 }) });
      await wet.app.Live.ensure(6.095, 0.042);
      const dry = live({ forecast: forecast({ soil_moisture_3_to_9cm: 0.14 }) });
      await dry.app.Live.ensure(6.095, 0.042);
      assert.greater(dry.app.Live.metricAt('stress', NOW).v, wet.app.Live.metricAt('stress', NOW).v,
        'stress did not respond to drying');
    });

    test('stress is clamped to 0–1 at both extremes', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      assert.equal(h.app.Live.stressFrom(0.60), 0, 'saturated soil should be zero stress');
      assert.equal(h.app.Live.stressFrom(0.01), 1, 'bone dry should be full stress');
    });

    test('trafficability falls with heavy rain', async () => {
      const dry = live({ forecast: forecast({ precipitation: 0 }) });
      await dry.app.Live.ensure(6.095, 0.042);
      const wet = live({ forecast: forecast({ precipitation: 4, soil_moisture_0_to_1cm: 0.42 }) });
      await wet.app.Live.ensure(6.095, 0.042);
      assert.less(wet.app.Live.metricAt('traff', NOW).v, dry.app.Live.metricAt('traff', NOW).v,
        'rain did not degrade trafficability');
    });

    test('trafficability stays within 0–100 under an extreme', async () => {
      const h = live({ forecast: forecast({ precipitation: 60, soil_moisture_0_to_1cm: 0.45,
                                            soil_moisture_3_to_9cm: 0.45 }),
                       flood: flood([900, 950, 999]) });
      await h.app.Live.ensure(6.095, 0.042);
      assert.between(h.app.Live.metricAt('traff', NOW).v, 0, 100, 'index escaped its range');
    });

    test('hourly values interpolate between samples rather than stepping', async () => {
      const h = live({ forecast: forecast({}, { temperature_2m: i => i }) });
      await h.app.Live.ensure(6.095, 0.042);
      const a = h.app.Live.hourlyAt('temperature_2m', NOW);
      const b = h.app.Live.hourlyAt('temperature_2m', NOW + 1800000);   // +30 min
      assert.close(b - a, 0.5, 0.01, 'half an hour did not move the value by half a step');
    });

    test('a 24 h rainfall sum adds the right number of hours', async () => {
      const h = live({ forecast: forecast({ precipitation: 2 }) });
      await h.app.Live.ensure(6.095, 0.042);
      assert.close(h.app.Live.sumBack('precipitation', NOW, 24), 48, 0.001, 'window is the wrong length');
    });

    test('river discharge is reported with a percentile, not a bare number', async () => {
      const h = live({ flood: flood([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) });
      await h.app.Live.ensure(6.095, 0.042);
      const r = h.app.Live.river(NOW);
      assert.ok(r, 'no river reading');
      assert.between(r.pct, 0, 1, 'percentile out of range');
    });
  });

  /* ============================================================== places === */
  suite('live · geocoding and catchment synthesis', () => {
    test('search returns normalised results', async () => {
      const h = live();
      const r = await h.app.Places.search('Kisumu');
      assert.equal(r.length, 1, 'wrong result count');
      assert.equal(r[0].name, 'Kisumu', 'name not mapped');
      assert.equal(r[0].country, 'Kenya', 'country not mapped');
      assert.equal(typeof r[0].lat, 'number', 'coordinates not mapped');
    });

    test('a one-character query never hits the network', async () => {
      const h = live();
      const before = h.window.fetch.calls.length;
      await h.app.Places.search('K');
      assert.equal(h.window.fetch.calls.length, before, 'searched on a single character');
    });

    test('a synthesised catchment carries every node the topology needs', () => {
      const h = live();
      const c = h.app.Places.catchmentFor({ name:'X', lat:10, lon:20, country:'Y', countryCode:'YY' });
      const needed = new Set(h.app.EDGE_SPEC.flatMap(e => [e.a, e.b]));
      needed.forEach(n => assert.ok(c.nodes[n], `synthesised catchment is missing ${n}`));
    });

    test('it is flagged as synthesised, so the UI can say so', () => {
      const h = live();
      const c = h.app.Places.catchmentFor({ name:'X', lat:10, lon:20 });
      assert.ok(c.synthesised, 'a generated layout is not marked as generated');
    });

    test('the same place always produces the same layout', () => {
      const h = live();
      const p = { name:'Kisumu', lat:-0.10221, lon:34.76171 };
      assert.deepEqual(h.app.Places.catchmentFor(p).nodes, h.app.Places.catchmentFor(p).nodes,
        'layout is not deterministic, so a map would change between visits');
    });

    test('different places produce different layouts', () => {
      const h = live();
      const a = h.app.Places.catchmentFor({ name:'A', lat:10, lon:20 });
      const b = h.app.Places.catchmentFor({ name:'B', lat:40, lon:-3 });
      assert.notEqual(JSON.stringify(a.nodes.XR), JSON.stringify(b.nodes.XR), 'every place looks identical');
    });

    test('the catchment is a plausible size anywhere on Earth', () => {
      const h = live();
      [[-0.1, 34.7], [64.8, -147.7], [-33.9, 151.2], [6.1, 0.04], [78.2, 15.6]].forEach(([lat, lon]) => {
        const c = h.app.Places.catchmentFor({ name:'P', lat, lon });
        const km = h.app.Geo.haversine(c.nodes.F1, c.nodes.DEP);
        assert.between(km, 2, 20, `catchment at ${lat},${lon} is ${km.toFixed(1)} km across`);
      });
    });

    test('longitude convergence is handled near the poles', () => {
      const h = live();
      const polar = h.app.Places.catchmentFor({ name:'P', lat:78, lon:15 });
      polar.nodes && Object.values(polar.nodes).forEach(n => {
        assert.between(n.lat, -90, 90, 'latitude escaped the globe');
        assert.between(n.lon, -180, 180, 'longitude escaped the globe');
      });
    });

    test('crops follow the latitude band', () => {
      const h = live();
      assert.includes(h.app.Places.cropsFor(5), 'Cassava', 'tropics should grow cassava');
      assert.includes(h.app.Places.cropsFor(52), 'Wheat', 'high latitudes should grow wheat');
      assert.notIncludes(h.app.Places.cropsFor(60), 'Cassava', 'cassava does not grow at 60°');
    });

    test('every crop a catchment can pick is defined in CROPS', () => {
      const h = live();
      [5, 20, 35, 55, -40].forEach(lat =>
        h.app.Places.cropsFor(lat).forEach(c =>
          assert.ok(h.app.CROPS[c], `crop ${c} is selectable but has no definition`)));
    });

    test('every crop declares what the agronomy and order logic need', () => {
      const h = live();
      Object.entries(h.app.CROPS).forEach(([name, c]) => {
        assert.between(c.frostSensitivity, 0, 1, `${name} frost sensitivity`);
        assert.equal(typeof c.baseTempC, 'number', `${name} has no GDD base temperature`);
        assert.greater(c.gddToMaturity, 0, `${name} has no maturity target`);
      });
    });

    test('CROP-CASMA coverage is CONUS, not merely the United States', () => {
      const h = live();
      assert.ok(h.app.Places.conus(36.75, -119.77), 'Fresno should be covered');
      assert.notOk(h.app.Places.conus(64.8, -147.7), 'Alaska is not CONUS');
      assert.notOk(h.app.Places.conus(21.3, -157.8), 'Hawaii is not CONUS');
      assert.notOk(h.app.Places.conus(6.1, 0.04), 'Ghana is not CONUS');
    });
  });

  /* ============================================================ agronomy == */
  suite('live · agronomy decisions', () => {
    test('nothing is computed without live data', () => {
      const h = live();
      assert.equal(h.app.Agronomy.water(NOW), null, 'water balance invented without data');
      assert.equal(h.app.Agronomy.thermal(NOW), null, 'forecast invented without data');
      assert.equal(h.app.Agronomy.spray(NOW), null, 'spray window invented without data');
    });

    test('dry soil with no rain coming says irrigate, with a figure', async () => {
      const h = live({ forecast: forecast({ soil_moisture_3_to_9cm: 0.15, precipitation: 0,
                                            precipitation_probability: 0 }) });
      await h.app.Live.ensure(6.095, 0.042);
      const w = h.app.Agronomy.water(NOW);
      assert.equal(w.call, 'irrigate', 'dry soil did not trigger an irrigation call');
      assert.greater(w.applyMm, 0, 'no application depth given');
    });

    test('wet soil says hold', async () => {
      const h = live({ forecast: forecast({ soil_moisture_3_to_9cm: 0.31 }) });
      await h.app.Live.ensure(6.095, 0.042);
      assert.equal(h.app.Agronomy.water(NOW).call, 'hold', 'wet soil asked for irrigation');
    });

    test('rain in the forecast defers irrigation', async () => {
      const dry = { soil_moisture_3_to_9cm: 0.15, precipitation: 0, precipitation_probability: 0 };
      const noRain = live({ forecast: forecast(dry) });
      await noRain.app.Live.ensure(6.095, 0.042);
      assert.equal(noRain.app.Agronomy.water(NOW).call, 'irrigate', 'precondition failed');

      const rain = live({ forecast: forecast({ ...dry, precipitation: 3 }) });
      await rain.app.Live.ensure(6.095, 0.042);
      assert.equal(rain.app.Agronomy.water(NOW).call, 'hold',
        'told a grower to irrigate through 144 mm of forecast rain');
    });

    test('the water balance never reports negative available water', async () => {
      const h = live({ forecast: forecast({ soil_moisture_3_to_9cm: 0.02 }) });
      await h.app.Live.ensure(6.095, 0.042);
      const w = h.app.Agronomy.water(NOW);
      assert.ok(w.available >= 0, 'negative available water');
      assert.ok(w.depletion <= w.taw + 0.001, 'depletion exceeds total available water');
    });

    test('a frost in the window is reported with hours of warning', async () => {
      const h = live({ forecast: forecast({}, { temperature_2m: i => (i > 175 ? -3 : 12) }) });
      await h.app.Live.ensure(6.095, 0.042);
      const t = h.app.Agronomy.thermal(NOW);
      assert.equal(t.verdict, 'frost', 'a frost in the next 72 h was not flagged');
      assert.greater(t.firstFrostIn, 0, 'no lead time given');
      assert.greater(t.frostHours, 0, 'no frost hours counted');
    });

    test('a mild window reports clear', async () => {
      const h = live({ forecast: forecast({ temperature_2m: 18 }) });
      await h.app.Live.ensure(6.095, 0.042);
      assert.equal(h.app.Agronomy.thermal(NOW).verdict, 'clear', 'a mild forecast was not reported clear');
    });

    test('heat is distinguished from frost', async () => {
      const h = live({ forecast: forecast({ temperature_2m: 39 }) });
      await h.app.Live.ensure(6.095, 0.042);
      assert.equal(h.app.Agronomy.thermal(NOW).verdict, 'heat', 'a heatwave was not flagged as heat');
    });

    test('calm dry conditions produce a spray window', async () => {
      const h = live({ forecast: forecast({ wind_speed_10m: 6, wind_gusts_10m: 10,
                                            relative_humidity_2m: 65, precipitation_probability: 0 }) });
      await h.app.Live.ensure(6.095, 0.042);
      const s = h.app.Agronomy.spray(NOW);
      assert.ok(s.nextWindow, 'no window in ideal conditions');
      assert.equal(s.nextWindow.start, 0, 'ideal conditions should be sprayable now');
    });

    test('high wind closes the spray window and says why', async () => {
      const h = live({ forecast: forecast({ wind_speed_10m: 34, wind_gusts_10m: 48 }) });
      await h.app.Live.ensure(6.095, 0.042);
      const s = h.app.Agronomy.spray(NOW);
      assert.equal(s.nextWindow, null, 'recommended spraying in a gale');
      assert.includes(s.blocks[0].fails, 'wind', 'the wind failure was not named');
    });

    test('rain risk blocks spraying even when calm', async () => {
      const h = live({ forecast: forecast({ wind_speed_10m: 5, precipitation_probability: 85 }) });
      await h.app.Live.ensure(6.095, 0.042);
      assert.includes(h.app.Agronomy.spray(NOW).blocks[0].fails, 'rain risk', 'rain risk ignored');
    });

    test('spray blocks cover 48 hours', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      assert.equal(h.app.Agronomy.spray(NOW).blocks.length, 48, 'wrong window length');
    });

    test('growing-degree days accumulate above the crop base temperature', async () => {
      const h = live({ forecast: forecast({ tmin: 10, tmax: 30 }) });
      await h.app.Live.ensure(6.095, 0.042);
      const g = h.app.Agronomy.heatUnits('Tomato');       // base 10 °C, mean 20 → 10/day
      assert.close(g.rate, 10, 0.01, 'GDD rate wrong');
      assert.equal(g.baseTempC, 10, 'wrong base temperature');
    });

    test('a cold spell accumulates no heat units rather than negative ones', async () => {
      const h = live({ forecast: forecast({ tmin: -5, tmax: 2 }) });
      await h.app.Live.ensure(6.095, 0.042);
      assert.equal(h.app.Agronomy.heatUnits('Tomato').total, 0, 'negative GDD accumulated');
    });

    test('a crop with no GDD definition returns nothing rather than guessing', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      assert.equal(h.app.Agronomy.heatUnits('Unobtainium'), null, 'invented parameters for an unknown crop');
    });
  });

  /* ============================================================ satellite == */
  suite('live · satellite imagery', () => {
    const h = live();
    const { Sat } = h.app;

    test('imagery is off until asked for', () =>
      assert.equal(Sat.activeId(), null, 'a layer was on at boot'));

    test('every layer declares a product, resolution and maximum zoom', () =>
      Sat.LAYERS.forEach(l => {
        assert.ok(l.gibs && l.tms && l.ext, `${l.id} is missing tile parameters`);
        assert.greater(l.maxZ, 0, `${l.id} has no maximum zoom`);
        assert.greater(l.resM, 0, `${l.id} does not state its ground resolution`);
      }));

    test('the tile matrix set name matches the declared maximum zoom', () =>
      Sat.LAYERS.forEach(l => {
        const level = Number((l.tms.match(/Level(\d+)/) || [])[1]);
        assert.equal(l.maxZ, level, `${l.id} claims max zoom ${l.maxZ} but uses ${l.tms}`);
      }));

    test('tile URLs are https and point at NASA GIBS', () =>
      Sat.LAYERS.forEach(l => {
        const u = Sat.url(l, 3, 4, 5);
        assert.ok(u.startsWith('https://gibs.earthdata.nasa.gov/'), `${l.id} URL is not GIBS`);
        assert.includes(u, '/default/', 'not requesting the default style');
        assert.ok(/\/(default|\d{4}-\d{2}-\d{2})\//.test(u.replace('/default/', '/')),
          'time is neither "default" nor an ISO date');
      }));

    test('tile row and column are in the order GIBS expects', () => {
      // GIBS is {TileMatrix}/{TileRow}/{TileCol} — swapping them silently serves
      // the wrong part of the world, which no error would ever reveal.
      const u = Sat.url(Sat.LAYERS[0], 7, 11, 22);        // z, x, y
      assert.includes(u, '/7/22/11.', 'row and column are transposed');
    });

    test('daily imagery lags a day so it is not a half-built mosaic', () => {
      const daily = Sat.LAYERS.find(l => l.lagDays);
      assert.ok(daily, 'no layer declares a lag');
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(Sat.timeFor(daily)), 'lagged layer did not resolve to a date');
      const composite = Sat.LAYERS.find(l => !l.lagDays);
      assert.equal(Sat.timeFor(composite), 'default', 'composite products should ask for the latest granule');
    });

    test('zoom never exceeds what the product supports', () => {
      const tiny = { minLat: 6.09, maxLat: 6.10, minLon: 0.04, maxLon: 0.05 };
      Sat.LAYERS.forEach(l =>
        assert.ok(Sat.zoomFor(l, tiny) <= l.maxZ, `${l.id} would request a zoom GIBS rejects`));
    });

    test('web mercator tile maths round-trips', () => {
      const n = 256;
      assert.close(Sat.x2lon(Sat.lon2x(34.76, n), n), 34.76, 1e-9, 'longitude round-trip');
      assert.close(Sat.y2lat(Sat.lat2y(-0.102, n), n), -0.102, 1e-6, 'latitude round-trip');
    });

    test('selecting a layer turns it on and selecting it again turns it off', () => {
      assert.equal(Sat.set('smap'), 'smap', 'layer did not activate');
      assert.equal(Sat.set('smap'), null, 'selecting the active layer did not toggle it off');
    });

    test('tiles are only produced when a layer is active', () => {
      Sat.set(null);
      assert.equal(Sat.tilesFor(h.app.Region.current()).html, '', 'produced tiles with no layer selected');
    });

    test('an active layer produces positioned tiles for the catchment', () => {
      Sat.set('truecolor');
      const t = Sat.tilesFor(h.app.Region.current());
      assert.ok(t.html.includes('<image'), 'no tiles emitted');
      assert.greater(t.info.tiles, 0, 'zero tiles cover the catchment');
      assert.ok(t.info.mPerPx > 0, 'no ground resolution reported');
    });

    test('tiles are drawn unsmoothed, because the blocks are the resolution', () => {
      Sat.set('smap');
      assert.includes(Sat.tilesFor(h.app.Region.current()).html, 'image-rendering:pixelated',
        'resampling would hide the true pixel size');
      Sat.set(null);
    });

    test('a coarse product draws its true pixel footprint', () => {
      Sat.set('smap');
      assert.includes(Sat.footprintFor(h.app.Region.current()), 'pixel-footprint',
        'a 9 km product does not show what 9 km covers');
      Sat.set(null);
    });

    test('a fine product draws no footprint, because it would be meaningless', () => {
      Sat.set('truecolor');
      assert.equal(Sat.footprintFor(h.app.Region.current()), '', 'drew a footprint for a 250 m product');
      Sat.set(null);
    });

    test('a failed layer stops emitting tiles instead of leaving broken images', () => {
      Sat.reset();
      Sat.set('ndvi');
      Sat.markFailed('ndvi');
      assert.equal(Sat.tilesFor(h.app.Region.current()).html, '', 'kept requesting a dead layer');
      Sat.reset(); Sat.set(null);
    });
  });

  /* =============================================================== search == */
  suite('live · search behaviour', () => {
    test('an empty query offers the built-in catchments', () => {
      const h = live();
      const s = h.app.Search.suggestions();
      assert.equal(s.length, Object.keys(h.app.REGIONS).length, 'suggestions do not match the built-ins');
      s.forEach(x => assert.ok(x.builtin, 'a suggestion is not marked as a built-in'));
    });

    test('every built-in suggestion resolves to a real region', () => {
      const h = live();
      h.app.Search.suggestions().forEach(s =>
        assert.ok(h.app.REGIONS[s.builtin], `suggestion ${s.builtin} is not a region`));
    });

    test('country codes render as flags without crashing on a blank', () => {
      const h = live();
      assert.notEqual(h.app.Search.flag('KE'), '', 'no flag for a valid code');
      assert.equal(h.app.Search.flag(''), '🌐', 'blank code should fall back to a globe');
      assert.equal(h.app.Search.flag(null), '🌐', 'null code should fall back to a globe');
    });

    test('search is debounced rather than firing per keystroke', () => {
      const h = live();
      assert.greater(h.app.Search.DEBOUNCE, 100, 'a public free geocoder would be hammered');
    });

    test('a failed search reports it instead of showing an empty list', async () => {
      const h = boot({ fetch: () => Promise.reject(new Error('offline')) });
      h.app.Telemetry.stop();
      await h.app.Search.run('kisumu');
      assert.includes(h.document.getElementById('placeResults').innerHTML, 'res-empty',
        'a failure rendered as "no results" rather than as a failure');
    });

    /* ---- the curated city list ---- */

    /* Serves cities.json off disk, the way a browser would get it from the
       precache, so these exercise the real file rather than a fixture. */
    const withCities = async (opts = {}) => {
      const h = boot({
        fetch: url => {
          const u = String(url);
          if (u.includes('cities.json'))
            return Promise.resolve({ ok: true, status: 200,
              json: () => Promise.resolve(JSON.parse(fs.readFileSync(path.join(ROOT, 'cities.json'), 'utf8'))) });
          return (opts.fetch || (() => Promise.reject(new Error('network disabled'))))(url);
        },
      });
      h.app.Telemetry.stop();
      await h.app.Cities.load();
      return h;
    };

    test('the city list loads and is worth browsing', async () => {
      const h = await withCities();
      assert.ok(h.app.Cities.ready(), 'no cities loaded');
      assert.greater(h.app.Cities.count(), 100, 'too few cities to browse');
    });

    /* The person typing is often on a keyboard that cannot produce the accent
       that the city is spelled with. */
    test('matching folds accents, so "sao" finds São Paulo', async () => {
      const h = await withCities();
      const hit = h.app.Cities.match('sao', 8).find(c => c.name.startsWith('São'));
      assert.ok(hit, 'an unaccented query missed the accented city');
      assert.equal(hit.countryCode, 'BR', 'wrong São Paulo');
    });

    test('a name that starts with the term outranks one that merely contains it', async () => {
      const h = await withCities();
      const names = h.app.Cities.match('kan', 6).map(c => c.name.toLowerCase());
      assert.ok(names.length, 'no matches at all');
      assert.ok(names[0].startsWith('kan'), `a mid-word match ranked first: ${names.join(', ')}`);
    });

    /* A city must synthesise a catchment like any searched place. Carrying a
       `builtin` key would send it down the built-in branch instead, and it
       would load the wrong region entirely. */
    test('a city carries what catchmentFor needs, and no builtin flag', async () => {
      const h = await withCities();
      const c = h.app.Cities.match('ludhiana', 1)[0];
      assert.ok(c, 'Ludhiana is not in the list');
      assert.notOk(c.builtin, 'a city marked builtin would never synthesise a catchment');
      ['name', 'lat', 'lon'].forEach(k => assert.ok(c[k] !== undefined && c[k] !== '', `city has no ${k}`));
      const region = h.app.Places.catchmentFor(c);
      assert.ok(region.synthesised, 'a picked city did not synthesise a catchment');
      assert.includes(region.name, 'Ludhiana', 'the catchment is not named after the city');
    });

    /* The whole point of curating a list: offline you lose the long tail, not
       the feature. */
    test('cities still list when the geocoder is unreachable', async () => {
      const h = await withCities({ fetch: () => Promise.reject(new Error('offline')) });
      await h.app.Search.run('lag');
      const html = h.document.getElementById('placeResults').innerHTML;
      assert.includes(html, 'Lagos', 'the city list vanished when the geocoder failed');
      assert.includes(html, 'res-empty', 'the failure was not reported alongside the cities');
    });

    test('an empty query shows cities and the built-ins together', async () => {
      const h = await withCities();
      await h.app.Search.run('');
      const html = h.document.getElementById('placeResults').innerHTML;
      assert.greater((html.match(/res-head/g) || []).length, 1, 'the two sections did not both render');
      assert.greater(h.app.Search.current().length, 3, 'the flat result list is missing the cities');
    });

    /* Sections are a rendering detail; picking must stay an index into one flat
       list, because that is what pick() and the arrow keys use. */
    test('picking indexes across both sections', async () => {
      const h = await withCities();
      await h.app.Search.run('');
      const all = h.app.Search.current();
      const last = all.length - 1;
      let picked = null;
      h.app.Search.setHandler(p => { picked = p; });
      h.app.Search.pick(last);
      assert.ok(picked, 'the last row across the sections did not pick');
      assert.equal(picked.name, all[last].name, 'pick(i) selected a different row than results[i]');
    });
  });

  /* ====================================================== telemetry mode === */
  suite('live · telemetry switches to real data', () => {
    test('with no live data every metric is simulated', () => {
      const h = live();
      assert.equal(h.app.Telemetry.mode(), 'simulated', 'claimed live mode with nothing loaded');
    });

    test('with live data the metrics that have a source report live', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      h.app.State.data.clock = NOW;
      assert.equal(h.app.Telemetry.mode(), 'live', 'did not switch to live mode');
      ['moisture', 'temp', 'traff'].forEach(k =>
        assert.equal(h.app.Telemetry.modeFor(k), 'live', `${k} did not switch to live`));
    });

    test('NDVI stays simulated even when everything around it is live', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      h.app.State.data.clock = NOW;
      assert.equal(h.app.Telemetry.modeFor('ndvi'), 'simulated',
        'NDVI must not report as live — no keyless point source exists');
    });

    test('a live reading is used verbatim, not walked', async () => {
      const h = live({ forecast: forecast({ soil_moisture_3_to_9cm: 0.29 }) });
      await h.app.Live.ensure(6.095, 0.042);
      h.app.State.data.clock = NOW;
      assert.close(h.app.Telemetry.readingFor('moisture').v, 29, 0.01, 'live value was perturbed');
    });

    test('an injected excursion still overrides live data', async () => {
      // Otherwise the simulation triggers would do nothing on a real location,
      // and asking "what would a frost do here?" is the app's best feature.
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      h.app.State.data.clock = NOW;
      h.app.Telemetry.inject('temp', -4, 6, true);
      assert.notOk(h.app.Telemetry.readingFor('temp').live, 'an injection was ignored on a live location');
    });

    test('live readings carry provenance into the per-plot record', async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042);
      h.app.State.data.clock = NOW;
      const r = h.app.Telemetry.readingFor('moisture');
      assert.ok(r.prov, 'no provenance attached');
      assert.equal(r.prov.kind, 'modelled', 'wrong provenance kind');
    });
  });
  /* ================================================== the deck, on real data = */
  suite('live · the deck over a loaded location', () => {

    /* The reachability suite proves the deck renders. It cannot prove the deck
       renders anything worth reading: with no location loaded, the empty state
       satisfies every structural check while telling the grower nothing. These
       drive a real payload through it. */
    const loaded = async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042, 'Somanya');
      h.app.State.data.clock = NOW;
      h.app.Views.renderDeck();
      return { h, html: h.document.getElementById('farmerDeck').innerHTML };
    };

    test('a loaded location produces calls rather than the empty state', async () => {
      const { html } = await loaded();
      assert.notIncludes(html, 'deck-empty', 'a live location still rendered the empty state');
      assert.greater([...html.matchAll(/data-call="/g)].length, 3,
        'fewer calls than the five the deck is built from');
    });

    test('every call the deck knows about appears exactly once', async () => {
      const { html } = await loaded();
      ['water', 'spray', 'thermal', 'gdd'].forEach(id =>
        assert.equal([...html.matchAll(new RegExp(`data-call="${id}"`, 'g'))].length, 1,
          `${id} should appear once and appears otherwise`));
    });

    test('the deck groups what it renders', async () => {
      const { html } = await loaded();
      assert.greater([...html.matchAll(/class="deck-group /g)].length, 0,
        'no group heading — the triage is invisible');
    });

    test('at most one card is left open', async () => {
      const { html } = await loaded();
      assert.less([...html.matchAll(/class="deck-card /g)].length, 2,
        'more than one open card defeats the point of collapsing the rest');
    });

    test('an armed advisory reaches the deck', async () => {
      const { h } = await loaded();
      h.app.State.data.alerts.set('FROST_EVENT',
        { id:'FROST_EVENT', label:'Frost event', severity:'critical',
          since: NOW, detailKey:'Frost event', vars:{} });
      h.app.Views.renderDeck();
      const html = h.document.getElementById('farmerDeck').innerHTML;
      assert.includes(html, 'deck-group act',
        'a critical advisory did not produce a Needs you group');
    });

    test('the deck states a verdict, not a bare number', async () => {
      const { html } = await loaded();
      assert.greater([...html.matchAll(/class="verdict"/g)].length
                   + [...html.matchAll(/class="deck-call /g)].length, 3,
        'rows rendered without verdicts');
    });
  });
  /* ================================================ the detail screens ===== */
  suite('live · a call at full depth', () => {

    const loaded = async () => {
      const h = live();
      await h.app.Live.ensure(6.095, 0.042, 'Somanya');
      h.app.State.data.clock = NOW;
      return h;
    };

    const CALLS = ['water', 'spray', 'thermal', 'gdd'];

    test('every call renders a body', async () => {
      const h = await loaded();
      CALLS.forEach(id =>
        assert.greater(h.app.Views.detailFor(id).length, 100, `${id} rendered almost nothing`));
    });

    test('every body says where the number came from', async () => {
      const h = await loaded();
      /* Stripping provenance off the deck is only defensible because it lands
         here. A detail screen without it breaks the app's central claim. */
      CALLS.forEach(id =>
        assert.includes(h.app.Views.detailFor(id), 'prov-block',
          `${id} has no provenance block`));
    });

    test('no body claims a modelled number was measured', async () => {
      const h = await loaded();
      CALLS.forEach(id =>
        assert.notIncludes(h.app.Views.detailFor(id).toLowerCase(), '>measured<',
          `${id} presents an estimate as an instrument reading`));
    });

    test('every body leads with a verdict', async () => {
      const h = await loaded();
      CALLS.forEach(id =>
        assert.includes(h.app.Views.detailFor(id), 'detail-call',
          `${id} opens with something other than its call`));
    });

    test('an unknown call renders nothing rather than a broken screen', async () => {
      const h = await loaded();
      assert.equal(h.app.Views.detailFor('nonsense'), '');
      assert.equal(h.app.Views.detailFor(null), '');
    });

    test('opening a call fills the sheet and names it', async () => {
      const h = await loaded();
      h.app.Views.openDetail('water');
      assert.notOk(h.document.getElementById('detailSheet').hidden, 'the sheet stayed closed');
      assert.greater(h.document.getElementById('detailBody').innerHTML.length, 100);
      assert.greater(h.document.getElementById('detailTitle').textContent.length, 0,
        'the sheet opened with no title');
    });

    test('closing it hides the sheet again', async () => {
      const h = await loaded();
      h.app.Views.openDetail('water');
      h.app.Views.openDetail(null);
      assert.ok(h.document.getElementById('detailSheet').hidden, 'the sheet would not close');
    });

    test('the pane carries the same body as the sheet', async () => {
      const h = await loaded();
      h.app.Views.openDetail('water');
      assert.equal(h.document.getElementById('paneBody').innerHTML,
                   h.document.getElementById('detailBody').innerHTML,
                   'the two hosts have drifted apart');
    });

    test('an armed advisory opens as its own call', async () => {
      const h = await loaded();
      h.app.State.data.alerts.set('NDVI_DECLINE',
        { id:'NDVI_DECLINE', label:'Canopy vigour decline', severity:'warning',
          since: NOW, detailKey:'Canopy vigour decline', vars:{} });
      const html = h.app.Views.detailFor('alert:NDVI_DECLINE');
      assert.includes(html, 'detail-call', 'an armed rule has no detail screen');
    });

    test('a card promoted by a rule states the rule, not its own calm verdict', async () => {
      /* A browser pass found this and no stub-DOM check could have: an injected
         frost is not in the forecast series, so the thermal model still read
         "Clear 72 h" while the advisory had lifted the card into Needs you. The
         deck filed it under "needs you" and the card said everything was fine. */
      const h = await loaded();
      h.app.State.data.alerts.set('FROST_EVENT',
        { id:'FROST_EVENT', label:'Frost event', severity:'critical',
          since: NOW, detailKey:'Surface temperature at the frost floor.', vars:{} });
      h.app.Views.renderDeck();
      const html = h.document.getElementById('farmerDeck').innerHTML;

      assert.includes(html, 'deck-group act', 'the advisory did not reach Needs you');
      const open = html.slice(html.indexOf('deck-card'), html.indexOf('</button>', html.indexOf('deck-card')));
      assert.includes(open, 'Frost event', 'the promoted card does not name the rule that promoted it');
      assert.notIncludes(open, 'Clear 72 h',
        'the card contradicts the group it was filed under');
    });

    test('a card no rule promoted keeps its own verdict', async () => {
      const h = await loaded();
      h.app.State.data.alerts.clear();
      h.app.Views.renderDeck();
      const html = h.document.getElementById('farmerDeck').innerHTML;
      assert.notIncludes(html, 'Frost event',
        'a rule that is not armed is being named on the deck');
    });

    test('an advisory no card claims still reaches the deck', async () => {
      const h = await loaded();
      h.app.State.data.alerts.set('NDVI_DECLINE',
        { id:'NDVI_DECLINE', label:'Canopy vigour decline', severity:'warning',
          since: NOW, detailKey:'Canopy vigour decline', vars:{} });
      h.app.Views.renderDeck();
      assert.includes(h.document.getElementById('farmerDeck').innerHTML,
        'data-call="alert:NDVI_DECLINE"',
        'a rule the engine armed is invisible on the screen that lists what needs you');
    });
  });
};
