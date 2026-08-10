/* Decision-engine logic.

   These are the parts of AURA that are not simulated: geography, routing, the
   crop-aware order arithmetic, hysteresis, scoring and the downscaling model.
   Each suite boots its own copy of the app so one suite's state cannot leak into
   the next -- the app is one big closure, and a shared instance would make
   failures depend on file order. */
'use strict';

const { boot } = require('./harness');

module.exports = ({ suite, test, assert }) => {

  /* ====================================================== geography ======== */
  suite('logic · geography', () => {
    const { app } = boot();
    const { Geo, NODES, REGIONS, MAP_VIEW, EDGE_SPEC, EDGES } = app;

    test('distance to self is zero', () =>
      assert.equal(Geo.haversine({ lat: 6.1, lon: 0.04 }, { lat: 6.1, lon: 0.04 }), 0, 'non-zero self distance'));

    test('one degree of latitude is ~111.19 km', () =>
      assert.close(Geo.haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111.19, 0.05, 'meridian degree wrong'));

    test('one degree of longitude at the equator is ~111.19 km', () =>
      assert.close(Geo.haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 111.19, 0.05, 'equatorial degree wrong'));

    test('a degree of longitude shrinks with latitude (cos 60° = ½)', () =>
      assert.close(Geo.haversine({ lat: 60, lon: 0 }, { lat: 60, lon: 1 }), 55.6, 0.3, 'convergence not modelled'));

    test('distance is symmetric', () => {
      const a = NODES.F1, b = NODES.DEP;
      assert.close(Geo.haversine(a, b), Geo.haversine(b, a), 1e-9, 'asymmetric haversine');
    });

    test('triangle inequality holds across the catchment', () => {
      const { F1, J1, DEP } = NODES;
      assert.ok(Geo.haversine(F1, DEP) <= Geo.haversine(F1, J1) + Geo.haversine(J1, DEP) + 1e-9,
        'direct hop longer than going via the junction');
    });

    test('known separation: Somanya F-1 to the depot is a few km', () => {
      const km = Geo.haversine(REGIONS['ghana-eastern'].nodes.F1, REGIONS['ghana-eastern'].nodes.DEP);
      assert.between(km, 5, 12, 'catchment scale looks wrong');
    });

    Object.keys(REGIONS).forEach(id => {
      test(`projection of ${id} keeps every node inside the viewBox`, () => {
        const p = Geo.project(REGIONS[id]);
        Object.keys(p).forEach(n => {
          assert.between(p[n].x, 0, MAP_VIEW.w, `${n}.x outside viewBox`);
          assert.between(p[n].y, 0, MAP_VIEW.h, `${n}.y outside viewBox`);
        });
      });

      test(`projection of ${id} respects the padding`, () => {
        const p = Geo.project(REGIONS[id]);
        const xs = Object.values(p).map(n => n.x), ys = Object.values(p).map(n => n.y);
        assert.ok(Math.min(...xs) >= MAP_VIEW.pad - 0.001, 'a node sits inside the left pad');
        assert.ok(Math.max(...xs) <= MAP_VIEW.w - MAP_VIEW.pad + 0.001, 'a node sits inside the right pad');
        assert.ok(Math.min(...ys) >= MAP_VIEW.pad - 0.001, 'a node sits inside the top pad');
        assert.ok(Math.max(...ys) <= MAP_VIEW.h - MAP_VIEW.pad + 0.001, 'a node sits inside the bottom pad');
      });

      test(`projection of ${id} is deterministic`, () => {
        assert.deepEqual(Geo.project(REGIONS[id]), Geo.project(REGIONS[id]), 'projection is not a pure function');
      });

      test(`projection of ${id} puts screen-y the right way up`, () => {
        const p = Geo.project(REGIONS[id]);
        const ns = Object.keys(p);
        const north = ns.reduce((a, b) => (REGIONS[id].nodes[a].lat > REGIONS[id].nodes[b].lat ? a : b));
        const south = ns.reduce((a, b) => (REGIONS[id].nodes[a].lat < REGIONS[id].nodes[b].lat ? a : b));
        assert.less(p[north].y, p[south].y, 'the northern node is drawn below the southern one');
      });
    });

    test('projection preserves aspect ratio (no east-west stretch)', () => {
      // Two nodes an equal number of km apart should land an equal number of
      // pixels apart regardless of whether the separation is N-S or E-W.
      const r = REGIONS['usa-fresno'];
      const p = Geo.project(r);
      const ids = Object.keys(r.nodes);
      const pairs = [];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const km = Geo.haversine(r.nodes[ids[i]], r.nodes[ids[j]]);
        const px = Math.hypot(p[ids[i]].x - p[ids[j]].x, p[ids[i]].y - p[ids[j]].y);
        if (km > 0.5) pairs.push(px / km);
      }
      const min = Math.min(...pairs), max = Math.max(...pairs);
      assert.ok(max / min < 1.05, `px-per-km varies by ${((max / min - 1) * 100).toFixed(1)}% across bearings`);
    });

    test('every edge distance is derived, never typed', () => {
      EDGES.forEach(e => {
        const spec = EDGE_SPEC.find(s => s.id === e.id);
        assert.close(e.km, e.straightKm * spec.sinuosity, 1e-9, `${e.id} km is not straight × sinuosity`);
      });
    });

    test('road distance always exceeds straight-line distance', () =>
      EDGES.forEach(e => assert.greater(e.km, e.straightKm, `${e.id} road shorter than the crow flies`)));

    test('every edge has positive length', () =>
      EDGES.forEach(e => assert.greater(e.km, 0, `${e.id} has zero length`)));

    test('every edge references nodes that exist', () =>
      EDGES.forEach(e => {
        assert.ok(NODES[e.a], `${e.id} references missing node ${e.a}`);
        assert.ok(NODES[e.b], `${e.id} references missing node ${e.b}`);
      }));
  });

  /* ========================================================= regions ======= */
  suite('logic · regions', () => {
    const { app } = boot();
    const { Region, REGIONS, PLOTS, EDGE_SPEC, DEFAULT_REGION } = app;

    Object.keys(REGIONS).forEach(id => {
      test(`${id} declares every node the shared topology needs`, () => {
        const needed = new Set(EDGE_SPEC.flatMap(e => [e.a, e.b]));
        needed.forEach(n => assert.ok(REGIONS[id].nodes[n], `${id} is missing node ${n}`));
      });
      test(`${id} grows a crop on every plot`, () =>
        PLOTS.forEach(p => assert.ok(REGIONS[id].nodes[p].crop, `${id} plot ${p} has no crop`)));
      test(`${id} declares a climate baseline for every metric`, () =>
        ['temp', 'moisture', 'ndvi', 'stress', 'traff'].forEach(k =>
          assert.equal(typeof REGIONS[id].climate[k], 'number', `${id} climate.${k} missing`)));
      test(`${id} has plausible WGS-84 coordinates`, () =>
        Object.entries(REGIONS[id].nodes).forEach(([n, v]) => {
          assert.between(v.lat, -90, 90, `${id}.${n} latitude`);
          assert.between(v.lon, -180, 180, `${id}.${n} longitude`);
        }));
    });

    test('CROP-CASMA covers the US region only', () => {
      assert.ok(REGIONS['usa-fresno'].sources.CROP_CASMA, 'CONUS region should have CROP-CASMA');
      assert.notOk(REGIONS['ghana-eastern'].sources.CROP_CASMA, 'Ghana is not CONUS');
      assert.notOk(REGIONS['nigeria-oyo'].sources.CROP_CASMA, 'Nigeria is not CONUS');
    });

    test('an unknown region id falls back to the default rather than throwing', () =>
      assert.equal(Region.load('atlantis').id, DEFAULT_REGION, 'bad region id did not fall back'));

    test('plotsGrowing resolves a crop to its plots', () => {
      Region.load('ghana-eastern');
      assert.deepEqual(Region.plotsGrowing('Tomato'), ['F2'], 'tomato plot lookup wrong');
      assert.deepEqual(Region.plotsGrowing('Cassava'), ['F1'], 'cassava plot lookup wrong');
      assert.deepEqual(Region.plotsGrowing('Durian'), [], 'a crop grown nowhere should return nothing');
    });

    test('switching region rebuilds the graph rather than reusing it', () => {
      Region.load('ghana-eastern');
      const before = app.Geo.haversine(app.NODES.F1, app.NODES.DEP);
      Region.load('usa-fresno');
      const after = app.Geo.haversine(app.NODES.F1, app.NODES.DEP);
      assert.notEqual(before.toFixed(3), after.toFixed(3), 'graph did not change with the region');
    });
  });

  /* ========================================================= routing ======= */
  suite('logic · routing', () => {
    const { app } = boot();
    const { Dispatch, State, NODES, EDGES, CFG, ROUTE_ORIGIN, ROUTE_DEST } = app;

    const allPassable = () => {
      const s = {};
      EDGES.forEach(e => { s[e.id] = { traff: 95, passable: true, degraded: false }; });
      State.data.edgeState = s;
    };

    test('a route exists from origin to depot on a healthy network', () => {
      allPassable();
      const r = Dispatch.shortestPath(ROUTE_ORIGIN, ROUTE_DEST, false);
      assert.ok(r, 'no path found on a fully passable network');
    });

    test('the route starts at the origin and ends at the depot', () => {
      allPassable();
      const r = Dispatch.shortestPath(ROUTE_ORIGIN, ROUTE_DEST, false);
      assert.equal(r.path[0], ROUTE_ORIGIN, 'wrong origin');
      assert.equal(r.path[r.path.length - 1], ROUTE_DEST, 'wrong destination');
    });

    test('consecutive path nodes are joined by a real edge', () => {
      allPassable();
      const r = Dispatch.shortestPath(ROUTE_ORIGIN, ROUTE_DEST, false);
      for (let i = 0; i < r.path.length - 1; i++) {
        const a = r.path[i], b = r.path[i + 1];
        assert.ok(EDGES.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a)),
          `no edge between ${a} and ${b}`);
      }
    });

    test('the path visits no node twice', () => {
      allPassable();
      const r = Dispatch.shortestPath(ROUTE_ORIGIN, ROUTE_DEST, false);
      assert.equal(new Set(r.path).size, r.path.length, 'the path revisits a node');
    });

    test('reported km equals the sum of its edges', () => {
      allPassable();
      const r = Dispatch.shortestPath(ROUTE_ORIGIN, ROUTE_DEST, false);
      assert.close(r.km, r.edges.reduce((s, e) => s + e.km, 0), 1e-9, 'km does not match the edge list');
    });

    test('Dijkstra returns the true optimum, checked against brute force', () => {
      allPassable();
      const r = Dispatch.shortestPath(ROUTE_ORIGIN, ROUTE_DEST, false);
      // Enumerate every simple path and take the cheapest, independent of Dijkstra.
      const adj = {};
      Object.keys(NODES).forEach(n => { adj[n] = []; });
      EDGES.forEach(e => { adj[e.a].push([e.b, e]); adj[e.b].push([e.a, e]); });
      let best = Infinity;
      (function walk(at, seen, cost) {
        if (cost >= best) return;
        if (at === ROUTE_DEST) { best = cost; return; }
        adj[at].forEach(([to, e]) => {
          if (seen.has(to)) return;
          const st = State.data.edgeState[e.id];
          if (st && !st.passable) return;
          seen.add(to);
          walk(to, seen, cost + e.km / Dispatch.edgeSpeed(st ? st.traff : 100) * 60);
          seen.delete(to);
        });
      })(ROUTE_ORIGIN, new Set([ROUTE_ORIGIN]), 0);
      assert.close(r.min, best, 1e-6, 'Dijkstra did not find the cheapest path');
    });

    test('routing refuses to cross a blocked segment', () => {
      allPassable();
      // Block the ford; the route must detour rather than use it.
      State.data.edgeState['R-14'] = { traff: 10, passable: false, degraded: true };
      const r = Dispatch.shortestPath(ROUTE_ORIGIN, ROUTE_DEST, false);
      assert.ok(r, 'no detour found when one exists');
      assert.notIncludes(r.edges.map(e => e.id), 'R-14', 'the route crosses a blocked segment');
    });

    test('ignoreBlocked=true may cross a blocked segment', () => {
      allPassable();
      EDGES.forEach(e => { State.data.edgeState[e.id] = { traff: 5, passable: false, degraded: true }; });
      assert.equal(Dispatch.shortestPath(ROUTE_ORIGIN, ROUTE_DEST, false), null, 'found a path with everything blocked');
      assert.ok(Dispatch.shortestPath(ROUTE_ORIGIN, ROUTE_DEST, true), 'fallback could not find a path either');
    });

    test('a severed network produces a route flagged as fallback, not a silent lie', () => {
      allPassable();
      State.data.latest.traff = 2;
      Dispatch.refreshEdges();
      const r = Dispatch.buildRoute();
      if (r) assert.ok(r.fallback === true || Dispatch.blockedEdges().length === 0,
        'routed over blocked segments without flagging a fallback');
    });

    test('effective speed rises with trafficability', () => {
      assert.greater(Dispatch.edgeSpeed(100), Dispatch.edgeSpeed(50), 'speed not monotonic');
      assert.greater(Dispatch.edgeSpeed(50), Dispatch.edgeSpeed(0), 'speed not monotonic at the low end');
    });

    test('effective speed is clamped outside 0-100', () => {
      assert.equal(Dispatch.edgeSpeed(-40), Dispatch.edgeSpeed(0), 'negative trafficability not clamped');
      assert.equal(Dispatch.edgeSpeed(400), Dispatch.edgeSpeed(100), 'trafficability above 100 not clamped');
    });

    test('speed never reaches zero, so cost stays finite', () =>
      assert.greater(Dispatch.edgeSpeed(0), 0, 'zero speed would make every cost Infinity'));

    test('per-segment trafficability tracks the global reading', () => {
      State.data.latest.traff = 90;
      Dispatch.refreshEdges();
      const high = State.data.edgeState['R-14'].traff;
      State.data.latest.traff = 60;
      Dispatch.refreshEdges();
      assert.less(State.data.edgeState['R-14'].traff, high, 'segment did not degrade with the global reading');
    });

    test('the ford degrades faster than the road beside it', () => {
      State.data.latest.traff = 62;
      Dispatch.refreshEdges();
      assert.less(State.data.edgeState['R-14'].traff, State.data.edgeState['R-12'].traff,
        'flood risk is not differentiating segments');
    });

    test('the documented flood window (SAR 57) blocks the ford but keeps a detour', () => {
      State.data.latest.traff = 57;
      Dispatch.refreshEdges();
      assert.notOk(State.data.edgeState['R-14'].passable, 'the ford should be impassable at SAR 57');
      const r = Dispatch.buildRoute();
      assert.ok(r && !r.fallback, 'at SAR 57 a genuine detour should exist, not a fallback');
    });

    test('impassable and degraded use their configured thresholds', () => {
      State.data.latest.traff = 100;
      Dispatch.refreshEdges();
      Object.values(State.data.edgeState).forEach(s => {
        assert.equal(s.passable, s.traff > CFG.THRESH.edgeImpassable, 'passable flag disagrees with the threshold');
        assert.equal(s.degraded, s.traff <= CFG.THRESH.edgeDegraded, 'degraded flag disagrees with the threshold');
      });
    });

    test('a backhaul leg is offered from the depot', () => {
      allPassable();
      State.commit({ route: Dispatch.buildRoute() });
      const bh = Dispatch.backhaul();
      assert.ok(bh, 'no backhaul returned');
      assert.greater(bh.km, 0, 'backhaul has no distance');
    });

    test('harvest window and cold chain round-trip', () => {
      Dispatch.setHarvestWindow('EARLY');
      assert.equal(Dispatch.getHarvestWindow(), 'EARLY', 'harvest window did not stick');
      Dispatch.setColdChain(true);
      assert.equal(Dispatch.getColdChain(), true, 'cold chain did not stick');
      Dispatch.setHarvestWindow('NORMAL'); Dispatch.setColdChain(false);
    });

    test('a route to an unknown node returns null rather than throwing', () =>
      assert.equal(Dispatch.shortestPath('F2', 'NOWHERE', true), null, 'unknown destination did not return null'));
  });

  /* ========================================================== orders ======= */
  suite('logic · crop-aware order book', () => {
    const { app } = boot();
    const { Orders, State, Region, CROPS } = app;
    Region.load('ghana-eastern');

    const reset = () => State.data.orders.forEach(o => {
      o.crates = o.baseCrates; o.grade = o.baseGrade; o.status = 'confirmed';
      delete o.adjustedBy; delete o.adjustedPct;
    });

    test('a frost on the tomato plot leaves the cassava order untouched', () => {
      reset();
      const cassava = State.data.orders.find(o => o.crop === 'Cassava');
      const before = cassava.crates;
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F2']);      // F2 grows Tomato
      assert.equal(cassava.crates, before, 'cassava was cut by a frost on the tomato plot');
    });

    test('the tomato order is cut by that same frost', () => {
      reset();
      const tomato = State.data.orders.find(o => o.crop === 'Tomato');
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F2']);
      assert.less(tomato.crates, tomato.baseCrates, 'the affected crop was not cut');
    });

    test('cut size scales with the crop frost sensitivity', () => {
      reset();
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F1', 'F2', 'F3']);   // all plots
      const tomato = State.data.orders.find(o => o.crop === 'Tomato');
      const cassava = State.data.orders.find(o => o.crop === 'Cassava');
      const tomatoLoss = 1 - tomato.crates / tomato.baseCrates;
      const cassavaLoss = 1 - cassava.crates / cassava.baseCrates;
      assert.greater(tomatoLoss, cassavaLoss, 'a root crop lost as much as a fruiting crop');
      assert.close(cassavaLoss / tomatoLoss, CROPS.Cassava.frostSensitivity / CROPS.Tomato.frostSensitivity, 0.05,
        'the loss ratio does not match the configured sensitivities');
    });

    test('crates never go negative even on an extreme cut', () => {
      reset();
      Orders.adjust('FROST_EVENT', -5, 'B', ['F1', 'F2', 'F3']);
      State.data.orders.forEach(o => assert.ok(o.crates >= 0, `${o.id} went negative`));
    });

    test('an already-adjusted order is not cut twice', () => {
      reset();
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F2']);
      const tomato = State.data.orders.find(o => o.crop === 'Tomato');
      const once = tomato.crates;
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F2']);
      assert.equal(tomato.crates, once, 'the order was cut a second time');
    });

    test('adjust reports the total crates withdrawn', () => {
      reset();
      const before = Orders.total();
      const cut = Orders.adjust('FROST_EVENT', -0.28, 'B', ['F2']);
      assert.equal(cut, before - Orders.total(), 'reported cut disagrees with the order book');
    });

    test('restore reinstates every crate the same reason removed', () => {
      reset();
      const before = Orders.total();
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F1', 'F2', 'F3']);
      Orders.restore('FROST_EVENT');
      assert.equal(Orders.total(), before, 'the order book did not return to its base total');
    });

    test('restore returns the CONTRACTED grade, not a hardcoded A', () => {
      reset();
      const cassava = State.data.orders.find(o => o.id === 'ORD-4421');
      assert.equal(cassava.baseGrade, 'B', 'fixture changed: ORD-4421 should be contracted at B');
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F1']);
      Orders.restore('FROST_EVENT');
      assert.equal(cassava.grade, 'B', 'a B-grade contract was silently upgraded to A');
    });

    test('restore ignores orders adjusted for a different reason', () => {
      reset();
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F2']);
      const tomato = State.data.orders.find(o => o.crop === 'Tomato');
      const cut = tomato.crates;
      Orders.restore('SOME_OTHER_REASON');
      assert.equal(tomato.crates, cut, 'restore touched an order it did not adjust');
    });

    test('an adjustment writes an audit entry', () => {
      reset();
      State.data.orderAudit.length = 0;
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F2']);
      assert.greater(State.data.orderAudit.length, 0, 'no audit trail for an autonomous change');
    });

    test('adjusted orders are marked revised and re-graded', () => {
      reset();
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F2']);
      const tomato = State.data.orders.find(o => o.crop === 'Tomato');
      assert.equal(tomato.status, 'revised', 'status not updated');
      assert.equal(tomato.grade, 'B', 'grade not re-marked');
    });

    test('an empty affectedPlots list falls back to every plot', () => {
      reset();
      const before = Orders.total();
      Orders.adjust('FROST_EVENT', -0.28, 'B', []);
      assert.less(Orders.total(), before, 'nothing was cut when no plots were named');
    });

    test('baseTotal is unaffected by adjustments', () => {
      reset();
      const base = Orders.baseTotal();
      Orders.adjust('FROST_EVENT', -0.28, 'B', ['F1', 'F2', 'F3']);
      assert.equal(Orders.baseTotal(), base, 'the contracted total moved');
    });
  });

  /* ====================================================== hysteresis ======= */
  suite('logic · hysteresis and the rule engine', () => {
    const { app } = boot();
    const { EventEngine, State, CFG, Telemetry } = app;
    Telemetry.stop();

    const set = v => Object.assign(State.data.latest, v);
    const armed = id => State.data.alerts.has(id);
    const settle = (v, n) => { for (let i = 0; i < n; i++) { set(v); EventEngine.evaluate(); } };

    test('every rule declares arm, clear, a metric and a debounce', () =>
      EventEngine.RULES.forEach(r => {
        assert.equal(typeof r.arm, 'function', `${r.id} has no arm test`);
        assert.equal(typeof r.clear, 'function', `${r.id} has no clear test`);
        assert.ok(r.metric, `${r.id} names no metric`);
        assert.greater(r.minTicks, 0, `${r.id} has no debounce`);
      }));

    test('rule ids are unique', () => {
      const ids = EventEngine.RULES.map(r => r.id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate rule id');
    });

    test('arm and clear thresholds never coincide (there is always a gap)', () =>
      [['frostArm', 'frostClear'], ['heatArm', 'heatClear'], ['moistArm', 'moistClear'],
       ['ndviArm', 'ndviClear'], ['traffArm', 'traffClear']].forEach(([a, c]) =>
        assert.notEqual(CFG.THRESH[a], CFG.THRESH[c], `${a} and ${c} are equal, so the rule can flap`)));

    test('a nominal field arms nothing', () => {
      set({ temp: 24, moisture: 32, ndvi: 0.63, traff: 90, stress: 0.24 });
      for (let i = 0; i < 5; i++) EventEngine.evaluate();
      assert.equal(State.data.alerts.size, 0, `nominal telemetry armed ${[...State.data.alerts.keys()]}`);
    });

    test('frost arms on the first qualifying downlink', () => {
      set({ temp: 24, moisture: 32, ndvi: 0.63, traff: 90 });
      EventEngine.evaluate();
      set({ temp: -3 });
      EventEngine.evaluate();
      assert.ok(armed('FROST_EVENT'), 'frost did not arm immediately');
    });

    test('frost does NOT clear the moment temperature rises above the arm point', () => {
      // 1.0 is above frostArm (0.0) but below frostClear (2.5) -- the gap.
      settle({ temp: 1.0 }, 4);
      assert.ok(armed('FROST_EVENT'), 'frost cleared inside the hysteresis gap');
    });

    test('frost clears once temperature reaches the release threshold', () => {
      settle({ temp: CFG.THRESH.frostClear + 0.5 }, 3);
      assert.notOk(armed('FROST_EVENT'), 'frost did not clear above the release threshold');
    });

    test('a two-tick rule ignores a single dip', () => {
      set({ temp: 24, moisture: 32, ndvi: 0.63, traff: 90 });
      for (let i = 0; i < 4; i++) EventEngine.evaluate();
      assert.notOk(armed('SOIL_STRESS'), 'precondition: soil stress should be clear');
      set({ moisture: CFG.THRESH.moistArm - 3 });
      EventEngine.evaluate();                                   // one qualifying tick only
      assert.notOk(armed('SOIL_STRESS'), 'a two-tick rule armed on a single reading');
    });

    test('a two-tick rule arms on the second consecutive reading', () => {
      EventEngine.evaluate();                                   // second consecutive
      assert.ok(armed('SOIL_STRESS'), 'the rule did not arm on its second qualifying tick');
    });

    test('the debounce counter resets when a reading recovers', () => {
      set({ temp: 24, moisture: 32, ndvi: 0.63, traff: 90 });
      for (let i = 0; i < 4; i++) EventEngine.evaluate();
      set({ moisture: CFG.THRESH.moistArm - 3 }); EventEngine.evaluate();   // 1
      set({ moisture: 34 });                      EventEngine.evaluate();   // reset
      set({ moisture: CFG.THRESH.moistArm - 3 }); EventEngine.evaluate();   // 1 again
      assert.notOk(armed('SOIL_STRESS'), 'the counter did not reset on recovery');
    });

    test('a frost cascade revises the order book', () => {
      const { Orders } = app;
      State.data.orders.forEach(o => {
        o.crates = o.baseCrates; o.grade = o.baseGrade; delete o.adjustedBy;
      });
      set({ temp: 24, moisture: 32, ndvi: 0.63, traff: 90 });
      for (let i = 0; i < 4; i++) EventEngine.evaluate();
      const before = Orders.total();
      set({ temp: -4, moisture: 32, ndvi: 0.63, traff: 90 });
      EventEngine.evaluate();
      assert.less(Orders.total(), before, 'a frost did not reach the order book');
    });

    test('a frost cascade moves the harvest window', () =>
      assert.equal(app.Dispatch.getHarvestWindow(), 'EARLY', 'harvest window unchanged by a frost'));

    test('clearing the frost reinstates the crates', () => {
      const { Orders } = app;
      const base = Orders.baseTotal();
      settle({ temp: CFG.THRESH.frostClear + 1 }, 3);
      assert.notOk(armed('FROST_EVENT'), 'frost still armed');
      assert.equal(Orders.total(), base, 'crates were not reinstated on release');
      assert.equal(app.Dispatch.getHarvestWindow(), 'NORMAL', 'harvest window not restored');
    });

    test('a null reading arms nothing', () => {
      set({ temp: null, moisture: null, ndvi: null, traff: null });
      const before = State.data.alerts.size;
      EventEngine.evaluate();
      assert.equal(State.data.alerts.size, before, 'a null reading changed the advisory set');
    });

    /* The advisory keeps source and variables, not a finished sentence, so the
       card can be reread in another language later. What must hold is that both
       halves are there and still make a sentence when put together. */
    test('an armed rule records severity, label and a readable detail', () => {
      set({ temp: 24, moisture: 32, ndvi: 0.63, traff: 90 });
      for (let i = 0; i < 4; i++) EventEngine.evaluate();
      set({ temp: -5 }); EventEngine.evaluate();
      const a = State.data.alerts.get('FROST_EVENT');
      assert.ok(a, 'no advisory recorded');
      assert.equal(a.severity, 'critical', 'wrong severity');
      assert.ok(a.detailKey && a.vars, 'the advisory kept no source to translate');
      const said = app.I18n.t(a.detailKey, a.vars);
      assert.greater(said.length, 10, 'no human-readable detail');
      assert.notIncludes(said, '{', 'a placeholder reached the card unfilled');
      settle({ temp: 20 }, 3);
    });
  });

  /* ========================================================= scoring ======= */
  suite('logic · readiness scoring', () => {
    const { app } = boot();
    const { Scoring, State, CFG, Telemetry } = app;
    Telemetry.stop();

    const score = v => {
      Object.assign(State.data.latest, v);
      Scoring.recompute();
      return State.data.readiness;
    };
    const nominal = { moisture: 32, temp: 22, ndvi: 0.7, traff: 92, stress: 0.2 };

    test('readiness is an integer within 0-100', () => {
      const r = score(nominal);
      assert.between(r, 0, 100, 'out of range');
      assert.equal(r, Math.round(r), 'not an integer');
    });

    test('nominal conditions score high', () => assert.greater(score(nominal), 80, 'nominal field scored low'));

    test('a frozen field scores far lower than a temperate one', () =>
      assert.less(score({ ...nominal, temp: -5 }), score(nominal) - 25, 'frost barely moved readiness'));

    test('readiness declines gradually as heat approaches its threshold', () => {
      // The bug this replaced: readiness sat at 100 until 34.9°C then cliffed.
      const a = score({ ...nominal, temp: 30 });
      const b = score({ ...nominal, temp: 33 });
      const c = score({ ...nominal, temp: 34.9 });
      assert.greater(a, b, 'no decline between 30°C and 33°C');
      assert.greater(b, c, 'no decline between 33°C and 34.9°C');
    });

    test('there is no cliff at the heat threshold', () => {
      const just = score({ ...nominal, temp: CFG.THRESH.heatArm - 0.1 });
      const over = score({ ...nominal, temp: CFG.THRESH.heatArm + 0.1 });
      assert.less(just - over, 12, `readiness dropped ${just - over} points across 0.2°C`);
    });

    test('the temperature curve is continuous at the frost threshold', () => {
      const just = score({ ...nominal, temp: CFG.THRESH.frostArm + 0.1 });
      const under = score({ ...nominal, temp: CFG.THRESH.frostArm - 0.1 });
      assert.less(Math.abs(just - under), 8, 'discontinuity at the frost floor');
    });

    test('dry soil lowers readiness', () =>
      assert.less(score({ ...nominal, moisture: 11 }), score(nominal), 'drought did not move the score'));

    test('impassable roads lower readiness', () =>
      assert.less(score({ ...nominal, traff: 30 }), score(nominal), 'road state did not move the score'));

    test('poor canopy lowers readiness', () =>
      assert.less(score({ ...nominal, ndvi: 0.2 }), score(nominal), 'NDVI did not move the score'));

    test('the worst case floors at or near zero', () =>
      assert.less(score({ moisture: 5, temp: -8, ndvi: 0.05, traff: 0, stress: 1 }), 6, 'worst case still scored high'));

    test('an incomplete field leaves the last score untouched', () => {
      const before = score(nominal);
      Object.assign(State.data.latest, { moisture: null });
      Scoring.recompute();
      assert.equal(State.data.readiness, before, 'scored on incomplete telemetry');
    });

    test('posture escalates to the worst active advisory', () => {
      Object.assign(State.data.latest, nominal);
      State.data.alerts.clear();
      State.data.alerts.set('X', { severity: 'warning' });
      Scoring.recompute();
      assert.equal(State.data.posture, 'warning', 'posture ignored a warning');
      State.data.alerts.set('Y', { severity: 'critical' });
      Scoring.recompute();
      assert.equal(State.data.posture, 'critical', 'a critical advisory did not dominate');
      State.data.alerts.clear();
      Scoring.recompute();
      assert.equal(State.data.posture, 'good', 'posture did not return to good');
    });
  });

  /* ======================================================= telemetry ======= */
  suite('logic · telemetry and downscaling', () => {
    const { app } = boot();
    const { Telemetry, State, METRICS, PLOTS, Region, SOURCES } = app;
    Telemetry.stop();
    Region.load('ghana-eastern');
    Telemetry.seedHistory();

    test('every metric seeds a history', () =>
      Object.keys(METRICS).forEach(k =>
        assert.greater(State.data.series[k].length, 0, `${k} has no history`)));

    test('every seeded reading is inside its declared bounds', () =>
      Object.keys(METRICS).forEach(k =>
        State.data.series[k].forEach(p =>
          assert.between(p.v, METRICS[k].min, METRICS[k].max, `${k} escaped its bounds`))));

    test('history is ordered oldest to newest', () =>
      Object.keys(METRICS).forEach(k => {
        const s = State.data.series[k];
        for (let i = 1; i < s.length; i++) assert.ok(s[i].t >= s[i - 1].t, `${k} history is out of order`);
      }));

    test('per-plot readings exist for every per-plot metric', () =>
      PLOTS.forEach(p => Object.keys(METRICS).filter(k => METRICS[k].perPlot).forEach(k =>
        assert.ok(State.data.plots[p] && State.data.plots[p][k], `${p} has no ${k} reading`))));

    test('trafficability is field-level, never per plot', () => {
      assert.notOk(METRICS.traff.perPlot, 'trafficability is a road property, not a plot property');
      PLOTS.forEach(p => assert.notOk(State.data.plots[p] && State.data.plots[p].traff,
        `${p} has a per-plot trafficability reading`));
    });

    test('all three plots share ONE SMAP pixel at 9 km', () => {
      const ids = new Set(PLOTS.map(p => State.data.plots[p].moisture.pixelId));
      assert.equal(ids.size, 1, `expected one shared SMAP pixel, got ${ids.size}`);
    });

    test('each plot gets its OWN Sentinel-2 pixel at 10 m', () => {
      const ids = new Set(PLOTS.map(p => State.data.plots[p].ndvi.pixelId));
      assert.equal(ids.size, PLOTS.length, 'plots are sharing a 10 m pixel');
    });

    test('soil moisture is labelled downscaled, NDVI is not', () => {
      assert.ok(State.data.plots.F1.moisture.downscaled, 'a 9 km estimate is not flagged as downscaled');
      assert.notOk(State.data.plots.F1.ndvi.downscaled, 'a 10 m measurement is flagged as downscaled');
    });

    test('a downscaled estimate carries lower confidence than a measurement', () =>
      assert.less(State.data.plots.F1.moisture.confidence, State.data.plots.F1.ndvi.confidence,
        'an estimate is reported as confidently as a measurement'));

    test('plot offsets are fixed, not independently random', () => {
      // Two plots in one pixel must keep a CONSTANT difference across downlinks,
      // otherwise the UI implies three independent measurements.
      const d1 = State.data.plots.F1.moisture.v - State.data.plots.F2.moisture.v;
      Telemetry.seedHistory();
      const d2 = State.data.plots.F1.moisture.v - State.data.plots.F2.moisture.v;
      assert.close(d1, d2, 0.001, 'the gap between two plots in one pixel drifted');
    });

    test('pixelPeers finds the plots sharing a coarse pixel', () => {
      const peers = app.Telemetry.pixelPeers ? app.Telemetry.pixelPeers('F1', 'moisture') : null;
      if (peers === null) return;                       // not exported; covered by the pixelId checks
      assert.equal(peers.length, PLOTS.length - 1, 'coarse-pixel peers not detected');
    });

    test('link state exists for every declared source', () =>
      Object.keys(SOURCES).forEach(id =>
        assert.ok(State.data.links[id], `${id} has no link state`)));

    test('each source declares a cadence, latency and loss rate', () =>
      Object.keys(SOURCES).forEach(id => {
        assert.greater(SOURCES[id].cadence, 0, `${id} cadence`);
        assert.greater(SOURCES[id].latency, 0, `${id} latency`);
        assert.between(SOURCES[id].loss, 0, 1, `${id} loss rate`);
      }));

    test('every metric is carried by a declared source', () =>
      Object.keys(METRICS).forEach(k =>
        assert.ok(SOURCES[METRICS[k].src], `${k} names unknown source ${METRICS[k].src}`)));

    test('every source carries at least one metric that exists', () =>
      Object.keys(SOURCES).forEach(id =>
        SOURCES[id].metrics.forEach(k => assert.ok(METRICS[k], `${id} carries unknown metric ${k}`))));

    test('an injected excursion pulls the reading toward its target', async () => {
      const h2 = boot();
      h2.app.Telemetry.seedHistory();
      const start = h2.app.State.data.latest.temp;
      h2.app.Telemetry.inject('temp', -4, 8, true);
      h2.app.Telemetry.start();
      await h2.advance(40000);
      assert.less(h2.app.State.data.latest.temp, start, 'the injection did not move the reading');
    });

    test('the walk stays inside bounds across a long run', async () => {
      const h3 = boot({ seed: 7 });
      h3.app.Telemetry.start();
      await h3.advance(120000);
      Object.keys(h3.app.METRICS).forEach(k => {
        const v = h3.app.State.data.latest[k];
        if (v === null) return;
        assert.between(v, h3.app.METRICS[k].min, h3.app.METRICS[k].max, `${k} escaped its bounds over 120 s`);
      });
    });

    test('a paused feed stops changing the readings', async () => {
      const h4 = boot({ seed: 11 });
      h4.app.Telemetry.seedHistory();
      h4.app.Telemetry.start();
      await h4.advance(20000);
      h4.app.State.data.paused = true;
      const held = { ...h4.app.State.data.latest };
      await h4.advance(30000);
      Object.keys(held).forEach(k =>
        assert.equal(h4.app.State.data.latest[k], held[k], `${k} moved while the feed was paused`));
    });
  });

  /* =================================================== state / persist ===== */
  suite('logic · state and persistence', () => {
    test('a session survives a save and restore', () => {
      const h = boot();
      h.app.State.data.role = 'DRIVER';
      h.app.State.data.readiness = 42;
      h.app.State.save();
      const raw = [...h.storage.values()][0];
      assert.ok(raw && raw.length, 'nothing was written to localStorage');

      const h2 = boot({ storage: Object.fromEntries(h.storage) });
      assert.equal(h2.app.State.data.role, 'DRIVER', 'role was not restored');
    });

    test('a corrupt store does not stop the app booting', () => {
      const h = boot({ storage: { 'aura-agrinet-v1': '{not json' } });
      assert.ok(h.app.State.data.regionId, 'a corrupt store broke the boot');
      assert.equal(h.errors.length, 0, `boot logged errors: ${h.errors[0]}`);
    });

    test('a ?role= deep link overrides the stored role', () => {
      const h = boot({ search: '?role=BUYER' });
      assert.equal(h.app.State.data.role, 'BUYER', 'the manifest shortcut did not take effect');
    });

    test('commit emits the event it is given', () => {
      const h = boot();
      let seen = null;
      h.app.State.on('score', p => { seen = p === undefined ? 'fired' : p; });
      h.app.State.commit({ readiness: 55 }, 'score');
      assert.ok(seen !== null, 'commit did not emit');
      assert.equal(h.app.State.data.readiness, 55, 'commit did not apply the patch');
    });

    test('listeners for one event never receive another', () => {
      const h = boot();
      let wrong = 0;
      h.app.State.on('route', () => wrong++);
      h.app.State.emit('alerts');
      assert.equal(wrong, 0, 'an event leaked across channels');
    });

    test('a throwing listener does not break the emitter', () => {
      const h = boot();
      let after = 0;
      h.app.State.on('log', () => { throw new Error('boom'); });
      h.app.State.on('log', () => after++);
      h.app.Log.add('info', 'test', 'detail');
      assert.equal(after, 1, 'a throwing listener stopped the ones after it');
    });

    test('the event log is capped', () => {
      const h = boot();
      for (let i = 0; i < h.app.CFG.MAX_LOG + 25; i++) h.app.Log.add('info', 'row ' + i, 'x');
      assert.ok(h.app.State.data.log.length <= h.app.CFG.MAX_LOG, 'the log grew past its cap');
    });

    test('the newest log entry is first', () => {
      const h = boot();
      h.app.Log.add('info', 'oldest', 'x');
      h.app.Log.add('info', 'newest', 'x');
      assert.equal(h.app.State.data.log[0].title, 'newest', 'the log is not newest-first');
    });
  });

  /* ================================================== intent matcher ======= */
  suite('logic · agent intent matching', () => {
    const { app } = boot();
    const { Console, Views } = app;

    const cases = [
      ['soil moisture?', 'moisture'], ['how wet is the soil', 'moisture'],
      ['frost risk today?', 'frost'], ['is it going to freeze', 'frost'],
      ['crop health', 'ndvi'], ['ndvi please', 'ndvi'],
      ['delivery route', 'route'], ['route check', 'route'],
      ['any roads blocked?', 'route'], ['my order', 'order'],
      ['backhaul options', 'backhaul'], ['full status', 'status'],
    ];
    cases.forEach(([text, expected]) => {
      test(`"${text}" matches the ${expected} intent`, () =>
        assert.equal(Console.match(text), expected, 'wrong intent'));
    });

    /* A reply is a segment list, not a finished sentence, so it is assembled the
       way the chat assembles it before being judged. */
    const said = r => (r && r.text) ? Views.msgText({ text: r.text }) : '';

    test('an unmatched question falls back rather than guessing', () => {
      const intent = Console.match('what is the airspeed velocity of an unladen swallow');
      const r = Console.reply(intent, 'FARMER');
      assert.ok(said(r).length > 20, 'no fallback reply');
    });

    /* Three of these buttons shipped sending text the matcher did not recognise.
       Every quick reply must resolve to a real intent, for every persona. */
    Object.keys(Views.QUICK).forEach(persona => {
      Views.QUICK[persona].forEach(q => {
        test(`quick reply "${q}" (${persona}) resolves to a real intent`, () => {
          const intent = Console.match(q);
          assert.ok(intent, `"${q}" matched nothing`);
          const r = Console.reply(intent, persona);
          assert.ok(said(r), `"${q}" produced no reply for ${persona}`);
        });
      });
    });

    test('every intent has a reply for every persona', () => {
      const intents = [...new Set(cases.map(c => c[1]))];
      ['FARMER', 'BUYER', 'DRIVER'].forEach(p =>
        intents.forEach(i => {
          const r = Console.reply(i, p);
          assert.ok(said(r), `intent ${i} has no reply for ${p}`);
        }));
    });
  });
};
