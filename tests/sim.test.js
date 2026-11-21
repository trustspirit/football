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

test('dribbles: good dribblers take players on more often, failures lose the ball', () => {
  global.PLAYERS.forEach((p) => assert.ok(p.dri >= 25 && p.dri <= 99, `${p.id}.dri=${p.dri}`));
  const winger = lineup('4-3-3', ['courtois', 'hakimi', 'vandijk', 'saliba', 'taa', 'rodri', 'bellingham', 'debruyne', 'yamal', 'haaland', 'vinicius']);
  let byStars = 0, byDefs = 0;
  for (let s = 1; s <= 200; s++) {
    const ev = simulate(winger, weaker, s).events;
    ev.forEach((e, i) => {
      if (e.type !== 'dribble' || e.side !== 'home') return;
      if (e.from === 8 || e.from === 10) byStars++;
      if (winger[e.from].slot.role === 'DEF') byDefs++;
      // the next event with a team (skipping 'added' / 'half' boards) belongs to the tackler's side
      const nx = ev.slice(i + 1).find((x) => x.side);
      if (!e.ok && nx && !['half', 'kickoff'].includes(nx.type)) assert.equal(nx.side, 'away', 'a lost dribble gives the ball away');
    });
  }
  assert.ok(byStars > byDefs * 2, `stars ${byStars} vs defenders ${byDefs}`);
});

const OPEN_SHOTS = new Set(['shot', 'long']);
const isShot = (e) => ['goal', 'save', 'miss'].includes(e.type);

test('every player has a shooting skill in range', () => {
  global.PLAYERS.forEach((p) => assert.ok(p.sho >= 20 && p.sho <= 99, `${p.id}.sho=${p.sho}`));
});

test('open-play shots come from the attacking half, never from deep', () => {
  let n = 0;
  for (let s = 1; s <= 150; s++) {
    simulate(strong, weaker, s).events.filter((e) => isShot(e) && OPEN_SHOTS.has(e.kind)).forEach((e) => {
      n++;
      assert.ok(e.x >= 50, `seed ${s}: ${e.kind} shot from x=${e.x}`);
    });
  }
  assert.ok(n > 1000);
});

test('attacks keep moving forward: few passes go back from the final third', () => {
  let fromAtt = 0; let back = 0; let backDeep = 0;
  for (let s = 1; s <= 150; s++) {
    simulate(strong, weaker, s).events.forEach((e) => {
      if (e.type !== 'pass' || e.kind === 'throw') return;
      const L = e.side === 'home' ? strong : weaker;
      const fx = L[e.from].slot.x; const tx = L[e.to].slot.x;
      if (fx < 55) return;
      fromAtt++;
      if (tx < fx - 5) back++;
      if (tx < 30) backDeep++;
    });
  }
  assert.ok(back / fromAtt < 0.4, `backward ${(100 * back / fromAtt).toFixed(1)}%`);
  assert.ok(backDeep / fromAtt < 0.06, `back to the defence ${(100 * backDeep / fromAtt).toFixed(1)}%`);
});

test('shooting skill matters: a better finisher scores more from the same slot', () => {
  const withStriker = (sho) => strong.map((e, i) => (i === 9 ? { ...e, player: { ...e.player, sho } } : e));
  const goalsBy = (lu) => {
    let g = 0;
    for (let s = 1; s <= 300; s++) g += simulate(lu, weaker, s).events.filter((e) => e.type === 'goal' && e.side === 'home' && e.from === 9).length;
    return g;
  };
  const good = goalsBy(withStriker(95));
  const poor = goalsBy(withStriker(55));
  assert.ok(good > poor * 1.4, `sho 95: ${good} goals vs sho 55: ${poor}`);
});

test('in on goal after a through ball: shoot or take the man on, rarely pass back', () => {
  let n = 0; let decisive = 0; let longBack = 0; let fwdPasses = 0;
  for (let s = 1; s <= 150; s++) {
    const ev = simulate(strong, weaker, s).events;
    ev.forEach((e, i) => {
      const L = e.side === 'home' ? strong : weaker;
      if (e.type === 'pass' && e.kind !== 'throw' && L[e.from].slot.x >= 70) {
        fwdPasses++;
        if (L[e.from].slot.x - L[e.to].slot.x > 30) longBack++;
      }
      if (e.type !== 'pass' || e.kind !== 'through' || L[e.to].slot.x < 60) return;
      const nx = ev[i + 1];
      if (!nx || nx.type === 'foul' || nx.type === 'added' || nx.type === 'half' || nx.type === 'end') return;
      n++;
      if (isShot(nx) || nx.type === 'dribble') decisive++;
    });
  }
  assert.ok(decisive / n > 0.6, `shot/dribble after a through ball ${(100 * decisive / n).toFixed(1)}%`);
  assert.ok(longBack / fwdPasses < 0.03, `long back passes from forwards ${(100 * longBack / fwdPasses).toFixed(1)}%`);
});

test('wing play: wingers run down the line, then cross or cut back into the box', () => {
  let runs = 0; let thenDelivery = 0; let crossGoals = 0; let headers = 0; let cutbacks = 0;
  const N = 150;
  for (let s = 1; s <= N; s++) {
    const ev = simulate(strong, weaker, s).events;
    ev.forEach((e, i) => {
      if (e.type === 'dribble' && e.ok && e.wing) {
        const nx = ev.slice(i + 1).find((x) => x.type !== 'foul' && x.type !== 'freekick');
        runs++;
        if (nx && (nx.type === 'pass' || nx.type === 'intercept') && (nx.kind === 'cross' || nx.kind === 'cutback')) thenDelivery++;
      }
      if ((e.type === 'pass' || e.type === 'intercept') && e.kind === 'cutback') cutbacks++;
      if (e.type === 'goal' && e.kind === 'header') headers++;
      const pv = ev[i - 1];
      if (e.type === 'goal' && pv && pv.type === 'pass' && (pv.kind === 'cross' || pv.kind === 'cutback')) crossGoals++;
    });
  }
  assert.ok(runs / N >= 2, `wing runs per match ${runs / N}`);
  assert.ok(thenDelivery / runs > 0.5, `delivery after a wing run ${(100 * thenDelivery / runs).toFixed(1)}%`);
  assert.ok(cutbacks / N >= 0.6, `cut-back attempts per match ${cutbacks / N}`);
  assert.ok(crossGoals / N >= 0.3, `goals from crosses / cut-backs per match ${crossGoals / N}`);
  assert.ok(headers / N >= 0.15, `headed goals per match ${headers / N}`);
});

test('free-kick skill decides direct free kicks, shooting skill decides open-play shots', () => {
  // the best free-kick taker on the pitch takes them: compare a specialist with a poor taker
  const withTaker = (fk) => strong.map((e, i) => (i === 7 ? { ...e, player: { ...e.player, fk } } : e));
  const fkGoals = (lu) => {
    let g = 0;
    for (let s = 1; s <= 600; s++) g += simulate(lu, weaker, s).events.filter((e) => e.type === 'goal' && e.side === 'home' && e.kind === 'freekick').length;
    return g;
  };
  const specialist = fkGoals(withTaker(99));
  const poor = fkGoals(withTaker(60).map((e) => ({ ...e, player: { ...e.player, fk: Math.min(e.player.fk, 60) } })));
  assert.ok(specialist > poor * 1.5, `fk 99: ${specialist} free-kick goals vs all takers <= 60: ${poor}`);
});

test('nobody shoots straight from the kick-off', () => {
  for (let s = 1; s <= 300; s++) {
    const ev = simulate(strong, weaker, s).events;
    ev.forEach((e, i) => {
      if (e.type === 'kickoff') assert.ok(!isShot(ev[i + 1] || {}), `seed ${s}: shot right after kick-off at ${e.minute}'`);
    });
  }
});
