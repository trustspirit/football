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

test('every player has pace / physical / kicking skills in range', () => {
  for (const p of global.PLAYERS) {
    for (const k of ['pac', 'phy', 'fk']) assert.ok(p[k] >= 30 && p[k] <= 99, `${p.id}.${k}=${p[k]}`);
  }
});

test('fouls, cards and set pieces happen at realistic rates', () => {
  const n = 200;
  const t = { fouls: 0, yellows: 0, reds: 0, corners: 0, freekicks: 0, penalties: 0 };
  for (let s = 1; s <= n; s++) {
    const r = simulate(strong, weaker, s);
    for (const side of ['home', 'away']) for (const k of Object.keys(t)) t[k] += r.stats[side][k];
  }
  const per = (k) => t[k] / n;
  assert.ok(per('fouls') > 6 && per('fouls') < 30, `fouls ${per('fouls')}`);
  assert.ok(per('yellows') > 1 && per('yellows') < 7, `yellows ${per('yellows')}`);
  assert.ok(per('reds') < 1, `reds ${per('reds')}`);
  assert.ok(per('corners') > 3 && per('corners') < 14, `corners ${per('corners')}`);
  assert.ok(per('penalties') > 0.05 && per('penalties') < 0.8, `penalties ${per('penalties')}`);
});

test('a sent-off player takes no further part', () => {
  for (let s = 1; s <= 400; s++) {
    const r = simulate(strong, weaker, s);
    const reds = r.events.filter((e) => e.type === 'foul' && (e.card === 'red' || e.card === 'second-yellow'));
    if (!reds.length) continue;
    const red = reds[0];
    const after = r.events.slice(r.events.indexOf(red) + 1);
    const involved = after.some((e) => e.side === red.side && [e.from, e.to, e.holder].includes(red.by));
    assert.ok(!involved, `seed ${s}: player ${red.by} acted after a red card`);
    return;
  }
  assert.fail('no red card in 400 matches');
});

test('every set-piece event is followed by its delivery or shot', () => {
  const r = simulate(strong, weaker, 11, { home: { mentality: 'attacking', style: 'direct', press: 'high' } });
  r.events.forEach((e, i) => {
    if (e.type === 'penalty') assert.equal(r.events[i + 1].kind, 'penalty');
    if (e.type === 'corner') assert.equal(r.events[i + 1].kind, 'corner');
  });
});

test('tactics are accepted and change the match', () => {
  const a = simulate(strong, weaker, 5);
  const b = simulate(strong, weaker, 5, { home: { mentality: 'attacking', style: 'possession', press: 'high' } });
  assert.notDeepEqual(a.events, b.events);
});

test('every foul is followed by its free kick or penalty, and throw-ins by a throw', () => {
  for (let s = 1; s <= 150; s++) {
    const ev = simulate(strong, weaker, s).events;
    ev.forEach((e, i) => {
      if (e.type === 'foul') assert.ok(['freekick', 'penalty'].includes(ev[i + 1].type), `seed ${s}: foul then ${ev[i + 1].type}`);
      if (e.type === 'throwin') assert.equal(ev[i + 1].kind, 'throw', `seed ${s}`);
    });
  }
});

test('stoppage time is announced in both halves and played', () => {
  const r = simulate(strong, weaker, 21);
  const added = r.events.filter((e) => e.type === 'added');
  assert.equal(added.length, 2);
  assert.equal(added[0].minute, 45);
  assert.equal(added[1].minute, 90);
  const end = r.events.at(-1);
  assert.equal(end.minute, 90);
  assert.ok(end.plus >= 1, `end at 90+${end.plus}`);
  // no event before the break is labelled as second-half time
  const half = r.events.findIndex((e) => e.type === 'half');
  assert.ok(r.events.slice(0, half).every((e) => e.minute === undefined || e.minute <= 45));
});

test('stamina option: tired players are substituted from the bench (max 5)', () => {
  const bench = { home: ['alisson', 'dias', 'pedri', 'kane', 'salah'].map((id) => P[id]), away: ['raya', 'gabriel', 'odegaard', 'saka', 'kvara'].map((id) => P[id]) };
  let total = 0;
  for (let s = 1; s <= 40; s++) {
    const r = simulate(strong, weaker, s, null, { stamina: true, bench });
    const subs = r.events.filter((e) => e.type === 'sub');
    total += subs.length;
    for (const side of ['home', 'away']) assert.ok(subs.filter((e) => e.side === side).length <= 5);
    subs.forEach((e) => assert.ok(e.minute >= 58));
  }
  assert.ok(total / 40 >= 2, `avg subs ${total / 40}`);
  // the caller's lineup is never mutated
  assert.equal(strong[9].player.id, 'haaland');
  assert.equal(strong[9].energy, undefined);
  // without the option there are no subs
  assert.equal(simulate(strong, weaker, 3, null, { bench }).events.filter((e) => e.type === 'sub').length, 0);
});

test('ratings: everyone who played is rated 3-10, goals are credited, there is a man of the match', () => {
  const bench = { home: ['pedri', 'kane'].map((id) => P[id]), away: ['saka'].map((id) => P[id]) };
  for (let s = 1; s <= 30; s++) {
    const r = simulate(strong, weaker, s, null, { stamina: true, bench });
    const { players, mom } = r.ratings;
    assert.ok(players.length >= 22);
    players.forEach((p) => assert.ok(p.r >= 3 && p.r <= 10, `${p.id} ${p.r}`));
    assert.ok(players.some((p) => p.id === mom));
    r.events.filter((e) => e.type === 'goal').forEach((g) => assert.ok(P[g.pid], 'goal has scorer id'));
    const goals = players.reduce((n, p) => n + p.goals, 0);
    assert.equal(goals, r.score.home + r.score.away);
  }
});
