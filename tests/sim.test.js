// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../js/players.js');
require('../js/formations.js');
const { simulate } = require('../js/sim.js');

const P = global.PLAYER_BY_ID;
const lineup = (formation, ids) => global.FORMATIONS[formation].map((slot, i) => ({ player: P[ids[i]], slot }));
const strong = lineup('4-3-3', ['courtois', 'hakimi', 'vandijk', 'saliba', 'taa', 'rodri', 'bellingham', 'debruyne', 'yamal', 'haaland', 'mbappe']);
const weaker = lineup('4-4-2', ['oblak', 'theo', 'kimminjae', 'bastoni', 'davies', 'leekangin', 'rice', 'dejong', 'bernardo', 'leao', 'son']);

test('player data is complete and unique', () => {
  const ids = global.PLAYERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of global.PLAYERS) {
    assert.ok(p.ko && p.short && p.wiki, `missing names for ${p.id}`);
    assert.ok(['GK', 'DEF', 'MID', 'FWD'].includes(p.pos));
  }
});

test('every formation has 11 slots with exactly one GK', () => {
  for (const [name, slots] of Object.entries(global.FORMATIONS)) {
    assert.equal(slots.length, 11, name);
    assert.equal(slots.filter((s) => s.role === 'GK').length, 1, name);
  }
});

test('simulation is deterministic for a given seed', () => {
  assert.deepEqual(simulate(strong, weaker, 42), simulate(strong, weaker, 42));
});

test('score matches goal events and the match ends at 90', () => {
  const r = simulate(strong, weaker, 7);
  const goals = r.events.filter((e) => e.type === 'goal');
  assert.equal(goals.filter((g) => g.side === 'home').length, r.score.home);
  assert.equal(goals.filter((g) => g.side === 'away').length, r.score.away);
  assert.equal(r.events.at(-1).type, 'end');
});

test('scorelines are realistic and the stronger team wins more often', () => {
  let goals = 0, wins = 0, losses = 0;
  const n = 300;
  for (let s = 1; s <= n; s++) {
    const r = simulate(strong, weaker, s);
    goals += r.score.home + r.score.away;
    if (r.score.home > r.score.away) wins++;
    if (r.score.home < r.score.away) losses++;
  }
  const avg = goals / n;
  assert.ok(avg > 1.5 && avg < 5, `avg goals per match ${avg}`);
  assert.ok(wins > losses, `wins ${wins} vs losses ${losses}`);
});

test('players can be placed out of position (same player allowed on both teams)', () => {
  const allForwards = lineup('4-3-3', ['messi', 'mbappe', 'haaland', 'kane', 'salah', 'yamal', 'vinicius', 'son', 'dembele', 'raphinha', 'lewandowski']);
  const r = simulate(allForwards, allForwards, 3);
  assert.equal(r.events.at(-1).type, 'end');
});
