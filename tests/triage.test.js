/* Triage classification.

   The deck's whole claim is that it ranks correctly. A card in the wrong group
   is worse than no ranking at all: "Clear" is a promise, and a frost sorted
   under it is a lie the reader has no reason to go and check.

   None of this touches the DOM, which is the point of keeping the ranking in a
   module of its own. */
'use strict';

const { boot } = require('./harness');

module.exports = ({ suite, test, assert }) => {

  suite('triage · tone maps to a group', () => {
    const { app } = boot();
    const { Triage } = app;

    test('act is Needs you', () => assert.equal(Triage.groupOf('act'), 'act'));
    test('warn is Watching',  () => assert.equal(Triage.groupOf('warn'), 'warn'));
    test('ok is Clear',       () => assert.equal(Triage.groupOf('ok'), 'ok'));
    test('an unknown tone falls to Clear rather than vanishing', () =>
      assert.equal(Triage.groupOf('nonsense'), 'ok'));
  });

  suite('triage · each call lands in the right group', () => {
    const { app } = boot();
    const { Triage } = app;

    const cases = [
      ['water',   { call: 'irrigate' },                'act'],
      ['water',   { call: 'monitor' },                 'warn'],
      ['water',   { call: 'hold' },                    'ok'],
      ['thermal', { verdict: 'frost' },                'act'],
      ['thermal', { verdict: 'heat' },                 'warn'],
      ['thermal', { verdict: 'marginal' },             'warn'],
      ['thermal', { verdict: 'clear' },                'ok'],
      ['spray',   { nextWindow: null },                'act'],
      ['spray',   { nextWindow: { start: 6, len: 5 } },'warn'],
      ['spray',   { nextWindow: { start: 0, len: 5 } },'ok'],
      ['traffic', { call: 'blocked' },                 'act'],
      ['traffic', { call: 'degrading' },               'warn'],
      ['traffic', { call: 'clear' },                   'ok'],
      ['gdd',     { rate: 14.2 },                      'ok'],
    ];

    cases.forEach(([id, model, want]) => {
      test(`${id} ${JSON.stringify(model)} is ${want}`, () =>
        assert.equal(Triage.toneOf(id, model), want));
    });

    test('a missing model is Clear rather than a crash', () =>
      assert.equal(Triage.toneOf('water', null), 'ok'));
  });

  suite('triage · an armed advisory outranks its card', () => {
    const { app } = boot();
    const { Triage } = app;

    test('a critical alert pins its card to Needs you', () => {
      const alerts = new Map([['FROST_EVENT', { id: 'FROST_EVENT', severity: 'critical' }]]);
      assert.equal(Triage.toneOf('thermal', { verdict: 'clear' }, alerts), 'act');
    });

    test('a serious alert also pins to Needs you', () => {
      const alerts = new Map([['HEATWAVE', { id: 'HEATWAVE', severity: 'serious' }]]);
      assert.equal(Triage.toneOf('thermal', { verdict: 'clear' }, alerts), 'act');
    });

    test('a warning alert lifts its card to Watching', () => {
      const alerts = new Map([['SOIL_STRESS', { id: 'SOIL_STRESS', severity: 'warning' }]]);
      assert.equal(Triage.toneOf('water', { call: 'hold' }, alerts), 'warn');
    });

    test('an alert never demotes a card', () => {
      const alerts = new Map([['SOIL_STRESS', { id: 'SOIL_STRESS', severity: 'warning' }]]);
      assert.equal(Triage.toneOf('water', { call: 'irrigate' }, alerts), 'act');
    });

    test('an alert for another card leaves this one alone', () => {
      const alerts = new Map([['FLOOD_SATURATION', { id: 'FLOOD_SATURATION', severity: 'critical' }]]);
      assert.equal(Triage.toneOf('water', { call: 'hold' }, alerts), 'ok');
    });

    test('a released rule does not promote anything', () => {
      const alerts = new Map([['SOIL_STRESS', { id: 'SOIL_STRESS', severity: 'good' }]]);
      assert.equal(Triage.toneOf('water', { call: 'hold' }, alerts), 'ok');
    });

    test('every claimed rule id is a rule the engine can actually arm', () => {
      const armable = app.EventEngine.RULES.map(r => r.id);
      Object.keys(Triage.CLAIMS).forEach(card =>
        Triage.CLAIMS[card].forEach(id =>
          assert.includes(armable, id,
            `${card} claims ${id}, which is not a rule — the claim can never fire`)));
    });
  });

  suite('triage · ordering', () => {
    const { app } = boot();
    const { Triage } = app;

    test('groups come out act, then warn, then ok', () => {
      const items = Triage.order([
        { id: 'gdd',     tone: 'ok',   deadline: 700 },
        { id: 'spray',   tone: 'act',  deadline: 0 },
        { id: 'traffic', tone: 'warn', deadline: 24 },
      ]);
      assert.deepEqual(items.map(i => i.id), ['spray', 'traffic', 'gdd']);
    });

    test('inside a group the soonest deadline sorts first', () => {
      const items = Triage.order([
        { id: 'water',   tone: 'act', deadline: 48 },
        { id: 'spray',   tone: 'act', deadline: 0 },
        { id: 'thermal', tone: 'act', deadline: 12 },
      ]);
      assert.deepEqual(items.map(i => i.id), ['spray', 'thermal', 'water']);
    });

    test('ordering is stable when deadlines tie', () => {
      const items = Triage.order([
        { id: 'water', tone: 'ok', deadline: 72 },
        { id: 'gdd',   tone: 'ok', deadline: 72 },
      ]);
      assert.deepEqual(items.map(i => i.id), ['water', 'gdd']);
    });

    test('ordering does not mutate its input', () => {
      const input = [
        { id: 'gdd',   tone: 'ok',  deadline: 700 },
        { id: 'spray', tone: 'act', deadline: 0 },
      ];
      Triage.order(input);
      assert.equal(input[0].id, 'gdd', 'order() sorted the caller\'s array in place');
    });
  });

  suite('triage · deadlines', () => {
    const { app } = boot();
    const { Triage } = app;

    test('an irrigation call bites now', () =>
      assert.equal(Triage.deadlineOf('water', { call: 'irrigate' }), 0));

    test('a frost bites when the frost does', () =>
      assert.equal(Triage.deadlineOf('thermal', { firstFrostIn: 9, firstHeatIn: null }), 9));

    test('a heat event bites when there is no frost to bite first', () =>
      assert.equal(Triage.deadlineOf('thermal', { firstFrostIn: null, firstHeatIn: 30 }), 30));

    test('a spray window bites when it opens', () =>
      assert.equal(Triage.deadlineOf('spray', { nextWindow: { start: 6, len: 5 } }), 6));

    test('no spray window at all bites now', () =>
      assert.equal(Triage.deadlineOf('spray', { nextWindow: null }), 0));

    test('a blocked road bites now', () =>
      assert.equal(Triage.deadlineOf('traffic', { call: 'blocked' }), 0));

    test('maturity bites in days, converted to hours', () =>
      assert.equal(Triage.deadlineOf('gdd', { daysAtRate: 31 }), 744));

    test('a missing model sorts last rather than first', () =>
      assert.greater(Triage.deadlineOf('water', null), 100));
  });

  suite('triage · counts', () => {
    const { app } = boot();
    const { Triage } = app;

    test('counts report each group', () => {
      const c = Triage.counts([{ tone: 'act' }, { tone: 'warn' }, { tone: 'ok' }, { tone: 'ok' }]);
      assert.equal(c.act, 1);
      assert.equal(c.warn, 1);
      assert.equal(c.ok, 2);
    });

    test('an empty deck counts zero everywhere', () => {
      const c = Triage.counts([]);
      assert.equal(c.act, 0);
      assert.equal(c.warn, 0);
      assert.equal(c.ok, 0);
    });
  });
};
