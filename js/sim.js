// Match engine: produces a deterministic list of events from two lineups + seed (+ tactics).
// A lineup is [{ player, slot: { role, x, y } }, ...] (11 entries).
//
// What shapes the result:
//  - Player skills: sho (shooting), fk (free kicks / set-piece delivery), att, dri, pas, def,
//    pac (pace), phy (aerial/strength).
//  - Out-of-position penalty, sent-off players (10 vs 11), line strength by formation.
//  - Tactics per team: mentality, style, press.
//  - Set pieces: fouls -> free kicks / penalties (+ yellow/red cards), corners from
//    parries, deflections and clearances.
(function (root) {
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const other = (side) => (side === 'home' ? 'away' : 'home');

  const TACTIC_DEFAULT = { mentality: 'balanced', style: 'balanced', press: 'mid' };
  const LINE_NORM = { DEF: 4, MID: 3.5, FWD: 2.5 };
  const AERIAL = new Set(['long', 'switch', 'cross', 'punt', 'corner', 'fkcross']);

  const PASS_MOD = {
    short: 0.03, cutback: 0.02, through: -0.08, long: -0.1, switch: -0.06, cross: -0.12, punt: -0.2, corner: -0.05, fkcross: -0.05,
  };
  const SHOT_MOD = {
    shot: { on: 0.06, goal: 0.06 },
    long: { on: -0.1, goal: -0.12 },
    header: { on: 0.04, goal: 0.09 },
    freekick: { on: -0.12, goal: -0.1 },
  };
  const MENTALITY = {
    defensive: { shoot: 0.85, forward: 0.85, defLine: 3 },
    balanced: { shoot: 1, forward: 1, defLine: 0 },
    attacking: { shoot: 1.15, forward: 1.3, defLine: -3 },
  };
  const STYLE = {
    possession: { short: 0.04, long: 0.5, through: 0.8, cross: 0.8 },
    balanced: { short: 0, long: 1, through: 1, cross: 1 },
    direct: { short: 0, long: 1.6, through: 1.1, cross: 1.4, aerial: 0.05 },
    counter: { short: 0, long: 1.1, through: 1.2, cross: 1 },
  };
  const PRESS = {
    low: { ownHalf: 0.03, foul: 0.8, fwdLine: -6 },
    mid: { ownHalf: 0, foul: 1, fwdLine: 0 },
    high: { ownHalf: -0.06, foul: 1.35, fwdLine: 6 },
  };

  // Tiredness (only with the stamina option): 100 energy = full strength, 0 = 75 %.
  const fatigue = (entry) => (entry.energy == null ? 1 : 0.75 + 0.25 * (entry.energy / 100));

  // A player out of their natural role loses effectiveness (technical stats only).
  function eff(entry, stat) {
    const { player, slot } = entry;
    const v = (player[stat] ?? (stat === 'dri' ? 60 : 70)) * fatigue(entry);
    if (stat === 'pac' || stat === 'phy' || stat === 'fk') return v;
    if (player.pos === slot.role) return v;
    if (player.pos === 'GK' || slot.role === 'GK') return v * 0.5;
    return v * 0.88;
  }

  // ---------- player ratings (6.0 base, like a newspaper match report) ----------
  // Walks the event list, tracking who is in each lineup index (substitutions change it),
  // and tags goal / card events with player ids so names stay right after subs.
  function rateMatch(events, startIds, score) {
    const ids = { home: [...startIds.home], away: [...startIds.away] };
    const R = {};
    const touch = (side, i) => {
      const id = ids[side][i];
      if (!R[id]) R[id] = { id, side, r: 6.0, goals: 0, assists: 0, saves: 0, cards: '', subIn: null, subOut: null };
      return R[id];
    };
    ['home', 'away'].forEach((s) => ids[s].forEach((_, i) => touch(s, i)));
    const opp = (s) => (s === 'home' ? 'away' : 'home');
    const gkIndex = { home: startIds.gk.home, away: startIds.gk.away };
    const SHOTS = new Set(['goal', 'save', 'miss']);
    events.forEach((e, n) => {
      switch (e.type) {
        case 'pass': {
          const passer = touch(e.side, e.from);
          passer.r += e.kind === 'through' || e.kind === 'cross' ? 0.08 : 0.03;
          // key pass: the receiver shoots next
          const nx = events[n + 1];
          if (nx && SHOTS.has(nx.type) && nx.side === e.side && nx.from === e.to) passer.r += 0.2;
          break;
        }
        case 'intercept':
          touch(opp(e.side), e.by).r += 0.12;
          touch(e.side, e.from).r -= 0.03;
          break;
        case 'goal': {
          e.pid = ids[e.side][e.from];
          const g = touch(e.side, e.from); g.r += 1.0; g.goals++;
          if (e.assist != null) { e.apid = ids[e.side][e.assist]; const a = touch(e.side, e.assist); a.r += 0.55; a.assists++; }
          touch(opp(e.side), gkIndex[opp(e.side)]).r -= 0.3;
          break;
        }
        case 'save': {
          const k = touch(opp(e.side), e.keeper); k.r += 0.2; k.saves++;
          touch(e.side, e.from).r += 0.05;
          break;
        }
        case 'miss': touch(e.side, e.from).r -= 0.05; break;
        case 'dribble':
          if (e.ok) { touch(e.side, e.from).r += 0.1; touch(opp(e.side), e.by).r -= 0.04; }
          else { touch(e.side, e.from).r -= 0.04; touch(opp(e.side), e.by).r += 0.1; }
          break;
        case 'foul': {
          e.pid = ids[e.side][e.by];
          const f = touch(e.side, e.by);
          f.r -= 0.05;
          touch(e.victimSide, e.on).r += 0.05;
          if (e.card === 'yellow') { f.r -= 0.3; f.cards += 'Y'; }
          if (e.card === 'second-yellow') { f.r -= 1.2; f.cards += 'YR'; }
          if (e.card === 'red') { f.r -= 1.5; f.cards += 'R'; }
          break;
        }
        case 'sub': {
          touch(e.side, e.i).subOut = e.minute;
          ids[e.side][e.i] = e.in;
          touch(e.side, e.i).subIn = e.minute;
          break;
        }
        default: break;
      }
    });
    // team result and clean sheets
    Object.values(R).forEach((p) => {
      const gf = score[p.side];
      const ga = score[opp(p.side)];
      // the result counts in proportion to minutes played (a late sub barely shares it)
      const played = Math.max(0, (p.subOut ?? 90) - (p.subIn ?? 0)) / 90;
      p.r += (gf > ga ? 0.3 : gf < ga ? -0.25 : 0) * played;
      const pl = PLAYER_LOOKUP(p.id);
      if (ga === 0 && pl && (pl.pos === 'GK' || pl.pos === 'DEF')) p.r += (pl.pos === 'GK' ? 0.4 : 0.3) * played;
      p.r = Math.round(clamp(p.r, 3, 10) * 10) / 10;
    });
    const list = Object.values(R);
    const mom = list.slice().sort((a, b) => b.r - a.r || (score[b.side] - score[opp(b.side)]) - (score[a.side] - score[opp(a.side)]))[0];
    return { players: list, mom: mom && mom.id };
  }
  const PLAYER_LOOKUP = (id) => (root.PLAYER_BY_ID ? root.PLAYER_BY_ID[id] : null);

  function pickWeighted(rng, items, weight) {
    const ws = items.map(weight);
    let r = rng() * ws.reduce((a, b) => a + b, 0);
    for (let i = 0; i < items.length; i++) {
      r -= ws[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  function newStats() {
    return {
      passes: 0, completed: 0, shots: 0, onTarget: 0, goals: 0,
      fouls: 0, yellows: 0, reds: 0, corners: 0, freekicks: 0, penalties: 0, throwins: 0,
      dribbles: 0, dribblesWon: 0,
    };
  }

  // opts: { stamina: bool, bench: { home: [player], away: [player] } }
  function simulate(home, away, seed, tactics, opts = {}) {
    const rng = mulberry32(seed >>> 0);
    const stamina = !!opts.stamina;
    // Entries are copied: energy and substitutions must not leak into the caller's lineup.
    const prep = (lineup) => lineup.map((e) => ({ ...e, energy: stamina ? 100 : null }));
    const T = {
      home: { lineup: prep(home), tac: { ...TACTIC_DEFAULT, ...(tactics && tactics.home) }, off: new Set(), booked: new Set(),
        bench: stamina ? [...((opts.bench && opts.bench.home) || [])].filter(Boolean) : [], subs: 0 },
      away: { lineup: prep(away), tac: { ...TACTIC_DEFAULT, ...(tactics && tactics.away) }, off: new Set(), booked: new Set(),
        bench: stamina ? [...((opts.bench && opts.bench.away) || [])].filter(Boolean) : [], subs: 0 },
    };
    const startIds = {
      home: T.home.lineup.map((e) => e.player.id),
      away: T.away.lineup.map((e) => e.player.id),
      gk: {
        home: Math.max(0, T.home.lineup.findIndex((e) => e.slot.role === 'GK')),
        away: Math.max(0, T.away.lineup.findIndex((e) => e.slot.role === 'GK')),
      },
    };
    const stats = { home: newStats(), away: newStats() };
    const score = { home: 0, away: 0 };
    const events = [];
    let minute = 0;
    let secondHalf = false;
    let side = 'home';
    let holder = 0;
    let lastPasser = null;
    let fromCross = false;
    let setPiece = null;      // { type: 'freekick'|'penalty'|'corner', side, x, y, direct }
    let counterLeft = 0;      // passes left in a counter-attack
    let space = 0;            // bonus after beating a high press
    let carry = { key: null, adv: 0, n: 0 }; // ground gained by the current ball carrier's dribbles
    let chance = false;       // clear chance: in behind / beat the man in the box / arriving late
    let wingRun = false;      // just went down the line on the flank: look to cross

    // ---------- helpers ----------
    const active = (s) => T[s].lineup.map((e, i) => ({ e, i })).filter((o) => !T[s].off.has(o.i));
    const gkOf = (s) => {
      const a = active(s);
      const g = a.find((o) => o.e.slot.role === 'GK') || a.slice().sort((p, q) => p.e.slot.x - q.e.slot.x)[0];
      return g.i;
    };
    const kickoffTaker = (s) => {
      let best = gkOf(s);
      let bestScore = -Infinity;
      active(s).forEach(({ e, i }) => {
        const sc = e.slot.x - Math.abs(e.slot.y - 50) * 0.6;
        if (sc > bestScore) { bestScore = sc; best = i; }
      });
      return best;
    };
    const bestBy = (s, fn, filter = () => true) => {
      let best = null;
      let bv = -Infinity;
      active(s).filter((o) => filter(o.e)).forEach((o) => {
        const v = fn(o.e);
        if (v > bv) { bv = v; best = o.i; }
      });
      return best ?? gkOf(s);
    };
    // Opponent nearest to a point given in the attacking team's coordinates.
    const nearestOpponent = (oppSide, x, y, filter = () => true) => {
      let best = gkOf(oppSide);
      let bestD = Infinity;
      active(oppSide).filter((o) => filter(o.e)).forEach(({ e, i }) => {
        const d = (100 - e.slot.x - x) ** 2 + (100 - e.slot.y - y) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };
    // Strength of the opponent line guarding zone x: average defending, scaled by how
    // many players are in it (formation balance) and by their tactics.
    const pressure = (oppSide, x) => {
      const role = x >= 60 ? 'DEF' : x >= 30 ? 'MID' : 'FWD';
      const line = active(oppSide).filter((o) => o.e.slot.role === role);
      const tac = T[oppSide].tac;
      if (!line.length) return 45;
      const avg = line.reduce((s, o) => s + eff(o.e, 'def'), 0) / line.length;
      let p = avg * Math.pow(line.length / LINE_NORM[role], 0.15);
      if (role === 'DEF') p += MENTALITY[tac.mentality].defLine;
      if (role === 'FWD') p += PRESS[tac.press].fwdLine;
      return p;
    };
    const hasFullbacks = (s) => active(s).some((o) => o.e.slot.role === 'DEF' && (o.e.slot.y <= 25 || o.e.slot.y >= 75));
    const menDown = (s) => T[s].off.size;

    const restart = (s, idx, type) => {
      carry = { key: null, adv: 0, n: 0 };
      side = s; holder = idx; lastPasser = null; fromCross = false; counterLeft = 0; space = 0; chance = false; wingRun = false;
      // the kick-off is taken on the halfway line, not from the forward's usual spot
      if (type === 'kickoff') carry = { key: s + idx, adv: 50 - T[s].lineup[idx].slot.x, n: 2 };
      events.push({ type, side, holder, minute: Math.floor(minute) });
    };
    const turnover = (newSide, idx) => {
      carry = { key: null, adv: 0, n: 0 };
      side = newSide; holder = idx; lastPasser = null; fromCross = false; space = 0; chance = false; wingRun = false;
      const tac = T[newSide].tac;
      const oppAttacking = T[other(newSide)].tac.mentality === 'attacking';
      counterLeft = tac.style === 'counter' ? 3 : oppAttacking ? 2 : 0;
    };

    // ---------- shots ----------
    // x: depth the shot is taken from (team frame), recorded on the event.
    function shoot(kind, idx, edge = false, x = null) {
      const team = T[side];
      const oppSide = other(side);
      const sh = team.lineup[idx];
      const st = stats[side];
      minute += 0.4;
      st.shots++;
      const gkIdx = gkOf(oppSide);
      const gk = eff(T[oppSide].lineup[gkIdx], 'def');
      // shooting skill drives every kind of shot; power (fk) and heading (phy) mix in
      const sho = eff(sh, 'sho');
      let a = 0.75 * sho + 0.25 * eff(sh, 'att');
      if (kind === 'long') a = 0.6 * sho + 0.4 * sh.player.fk;
      if (kind === 'header') a = 0.4 * sho + 0.6 * sh.player.phy;
      if (kind === 'freekick') a = 0.15 * sho + 0.85 * sh.player.fk; // free-kick specialists
      if (kind === 'penalty') a = 0.6 * sho + 0.4 * sh.player.fk;

      let onTarget;
      let pGoal;
      if (kind === 'penalty') {
        // ~78 % scored overall: ~5 % off target, the rest mostly beats the keeper
        onTarget = clamp(0.93 + (a - 80) / 250, 0.85, 0.97);
        pGoal = clamp(0.83 + (a - gk) / 140, 0.65, 0.93);
      } else {
        const mod = SHOT_MOD[kind];
        const range = edge ? 0.03 : 0;
        onTarget = clamp(0.17 + (a - 70) / 90 + mod.on - range, 0.1, 0.6);
        pGoal = clamp(0.2 + (a - gk) / 110 + mod.goal - range + menDown(oppSide) * 0.03, 0.04, 0.5);
      }
      const spot = x ?? (kind === 'penalty' ? 89 : kind === 'header' ? 90 : 70);
      const base = { side, from: idx, kind, x: Math.round(spot), minute: Math.floor(minute), aimY: 38 + rng() * 24 };

      if (rng() >= onTarget) {
        const over = rng() < (kind === 'shot' || kind === 'penalty' ? 0.3 : 0.5);
        const aimY = over ? 40 + rng() * 20 : rng() < 0.5 ? 30 + rng() * 7 : 63 + rng() * 7;
        const deflected = kind !== 'penalty' && rng() < (kind === 'freekick' ? 0.3 : 0.22);
        events.push({ ...base, type: 'miss', aimY, over: over && !deflected, deflected });
        if (deflected) setPiece = { type: 'corner', side };
        else restart(oppSide, gkIdx, 'goalkick');
        return;
      }
      st.onTarget++;
      if (rng() < pGoal) {
        st.goals++;
        score[side]++;
        events.push({ ...base, type: 'goal', assist: kind === 'penalty' || kind === 'freekick' ? null : lastPasser, score: { ...score } });
        restart(oppSide, kickoffTaker(oppSide), 'kickoff');
      } else {
        const caught = rng() < 0.55;
        events.push({ ...base, type: 'save', keeper: gkIdx, caught });
        if (!caught && rng() < 0.5) setPiece = { type: 'corner', side };
        else restart(oppSide, gkIdx, 'gkball');
      }
    }

    // ---------- fouls ----------
    function maybeFoul(victimIdx, t) {
      const oppSide = other(side);
      const victim = T[side].lineup[victimIdx].player;
      const flair = 0.75 + (victim.pac + victim.att) / 400;
      const zone = t.x >= 60 ? 1.2 : 1;
      const pf = 0.075 * PRESS[T[oppSide].tac.press].foul * flair * zone;
      if (rng() >= pf) return false;

      minute += 0.6;
      const by = nearestOpponent(oppSide, t.x, t.y, (e) => e.slot.role !== 'GK');
      const fouler = T[oppSide].lineup[by];
      const os = stats[oppSide];
      os.fouls++;
      let card = null;
      const r = rng();
      const yellowP = 0.2 + (t.x >= 70 ? 0.08 : 0);
      if (r < 0.012) card = 'red';
      else if (r < 0.012 + yellowP) card = T[oppSide].booked.has(by) ? 'second-yellow' : 'yellow';
      if (fouler.slot.role === 'GK' && card === 'red') card = 'yellow';
      if (card === 'yellow') { T[oppSide].booked.add(by); os.yellows++; }
      if (card === 'red' || card === 'second-yellow') {
        if (card === 'second-yellow') os.yellows++;
        os.reds++;
        T[oppSide].off.add(by);
      }
      events.push({ type: 'foul', side: oppSide, by, on: victimIdx, victimSide: side, card, x: t.x, y: t.y, minute: Math.floor(minute) });

      // forwards' slots sit at x ~70-76: treat fouls there as in/around the box
      const inBox = t.x >= 68 && Math.abs(t.y - 50) < 30;
      if (inBox && rng() < 0.12) setPiece = { type: 'penalty', side };
      else {
        const x = inBox ? 68 : t.x;
        const central = Math.abs(t.y - 50) < 28;
        setPiece = { type: 'freekick', side, x, y: t.y, direct: x >= 66 && central && rng() < 0.6 };
      }
      return true;
    }

    // Aerial delivery into the box (corner / free-kick cross).
    function deliver(kind, takerIdx) {
      const oppSide = other(side);
      const taker = T[side].lineup[takerIdx].player;
      const targets = active(side).filter((o) => o.i !== takerIdx && o.e.slot.role !== 'GK');
      const tgt = pickWeighted(rng, targets, (o) => Math.pow(o.e.player.phy / 70, 3) * (o.e.slot.role === 'FWD' ? 1.4 : 1));
      const marker = bestBy(oppSide, (e) => e.player.phy, (e) => e.slot.role !== 'GK');
      const markerPhy = T[oppSide].lineup[marker].player.phy;
      const p = clamp(0.45 + (taker.fk - 75) / 150 + (tgt.e.player.phy - markerPhy) / 120 + PASS_MOD[kind], 0.2, 0.75);
      stats[side].passes++;
      minute += 0.3;
      if (rng() < p) {
        stats[side].completed++;
        events.push({ type: 'pass', kind, side, from: takerIdx, to: tgt.i, minute: Math.floor(minute) });
        lastPasser = takerIdx;
        holder = tgt.i;
        fromCross = true;
      } else {
        const keeperClaims = rng() < 0.3;
        const by = keeperClaims ? gkOf(oppSide) : marker;
        events.push({ type: 'intercept', kind, side, from: takerIdx, to: tgt.i, by, minute: Math.floor(minute) });
        if (!keeperClaims && rng() < 0.2) { setPiece = { type: 'corner', side }; return; }
        turnover(oppSide, by);
      }
    }

    function playSetPiece(sp) {
      side = sp.side;
      lastPasser = null;
      fromCross = false;
      const st = stats[side];
      if (sp.type === 'penalty') {
        st.penalties++;
        const taker = bestBy(side, (e) => 0.6 * e.player.att + 0.4 * e.player.fk, (e) => e.slot.role !== 'GK');
        events.push({ type: 'penalty', side, holder: taker, minute: Math.floor(minute) });
        holder = taker;
        shoot('penalty', taker);
        return;
      }
      if (sp.type === 'throwin') {
        // Taken by the nearest outfield player; thrown to a nearby team-mate.
        st.throwins++;
        const own = (o) => o.e.slot.role !== 'GK';
        const near = (o) => (o.e.slot.x - sp.x) ** 2 + (o.e.slot.y - sp.y) ** 2;
        const pool = active(side).filter(own).sort((a, b) => near(a) - near(b));
        const taker = pool[0].i;
        events.push({ type: 'throwin', side, holder: taker, x: sp.x, y: sp.y, minute: Math.floor(minute) });
        const to = pool[1 + Math.floor(rng() * Math.min(3, pool.length - 1))] || pool[0];
        minute += 0.3 + rng() * 0.2;
        if (rng() < 0.88) {
          events.push({ type: 'pass', kind: 'throw', side, from: taker, to: to.i, minute: Math.floor(minute) });
          lastPasser = taker;
          holder = to.i;
        } else {
          const by = nearestOpponent(other(side), 100 - to.e.slot.x, 100 - to.e.slot.y, (e) => e.slot.role !== 'GK');
          events.push({ type: 'intercept', kind: 'throw', side, from: taker, to: to.i, by, minute: Math.floor(minute) });
          turnover(other(side), by);
        }
        return;
      }
      if (sp.type === 'corner') {
        st.corners++;
        const taker = bestBy(side, (e) => e.player.fk, (e) => e.slot.role !== 'GK');
        events.push({ type: 'corner', side, holder: taker, top: rng() < 0.5, minute: Math.floor(minute) });
        holder = taker;
        deliver('corner', taker);
        return;
      }
      // free kick
      st.freekicks++;
      const taker = bestBy(side, (e) => e.player.fk, (e) => e.slot.role !== 'GK');
      events.push({ type: 'freekick', side, holder: taker, x: sp.x, y: sp.y, direct: sp.direct, minute: Math.floor(minute) });
      holder = taker;
      if (sp.direct) shoot('freekick', taker, false, sp.x);
      else if (sp.x >= 55) deliver('fkcross', taker);
      // otherwise: taken short, play continues from the taker
    }

    // ---------- stamina & substitutions (option) ----------
    let lastMin = 0;
    const tire = () => {
      const dt = minute - lastMin;
      lastMin = minute;
      if (!stamina || dt <= 0) return;
      ['home', 'away'].forEach((s) => {
        const pressMul = T[s].tac.press === 'high' ? 1.2 : T[s].tac.press === 'low' ? 0.85 : 1;
        active(s).forEach(({ e }) => {
          const rate = e.slot.role === 'GK' ? 0.12 : Math.max(0.2, 0.56 - (e.player.phy - 70) / 300);
          e.energy = Math.max(0, e.energy - dt * rate * pressMul);
        });
      });
    };
    // From the hour mark, a tired outfield player (not on the ball) may be replaced,
    // preferably by a bench player of the same position. Max 5 substitutions.
    const trySubs = () => {
      if (!stamina || minute < 58) return;
      ['home', 'away'].forEach((s) => {
        const t = T[s];
        if (!t.bench.length || t.subs >= 5) return;
        const tired = active(s)
          .filter((o) => o.e.slot.role !== 'GK' && o.e.energy < 78 && !(s === side && o.i === holder))
          .sort((a, b) => a.e.energy - b.e.energy)[0];
        if (!tired || rng() > 0.06) return;
        let bi = t.bench.findIndex((p) => p.pos === tired.e.slot.role);
        if (bi < 0) bi = t.bench.findIndex((p) => p.pos !== 'GK');
        if (bi < 0) return;
        const inP = t.bench.splice(bi, 1)[0];
        const outP = tired.e.player;
        t.lineup[tired.i] = { player: inP, slot: tired.e.slot, energy: 100 };
        t.booked.delete(tired.i); // the booking leaves with the player
        t.subs++;
        events.push({ type: 'sub', side: s, i: tired.i, out: outP.id, in: inP.id, minute: Math.floor(minute) });
      });
    };

    restart('home', kickoffTaker('home'), 'kickoff');
    let added1 = null;
    let added2 = null;

    for (;;) {
      tire();
      // a free kick / penalty / corner already awarded is always taken, even on the whistle
      if (setPiece) {
        const sp = setPiece;
        setPiece = null;
        playSetPiece(sp);
        continue;
      }
      if (!secondHalf) {
        // stoppage time is announced at 45' and played before the break
        if (added1 === null && minute >= 45) {
          added1 = 1 + Math.floor(rng() * 3);
          events.push({ type: 'added', minute: 45, extra: added1 });
        }
        if (added1 !== null && minute >= 45 + added1) {
          secondHalf = true;
          minute = 45;
          lastMin = 45;
          events.push({ type: 'half', minute: 45 });
          if (stamina) ['home', 'away'].forEach((s) => T[s].lineup.forEach((e) => { e.energy = Math.min(100, e.energy + 10); }));
          restart('away', kickoffTaker('away'), 'kickoff');
        }
      } else {
        if (added2 === null && minute >= 90) {
          const busy = stats.home.reds + stats.away.reds + Math.floor((T.home.subs + T.away.subs) / 3) + Math.floor((score.home + score.away) / 3);
          added2 = Math.min(7, 2 + Math.floor(rng() * 3) + busy);
          events.push({ type: 'added', minute: 90, extra: added2 });
        }
        if (added2 !== null && minute >= 90 + added2) break;
        trySubs();
      }

      const oppSide = other(side);
      const team = T[side];
      const h = team.lineup[holder];
      const carried = carry.key === side + holder ? carry : { adv: 0, n: 0 };
      const depth = Math.min(92, h.slot.x + carried.adv);
      const isGK = h.slot.role === 'GK';
      const men = MENTALITY[team.tac.mentality];
      const sty = STYLE[team.tac.style];

      // --- Shot decision -------------------------------------------------
      // Only from the attacking half, more often the closer to goal, and good shooters
      // pull the trigger more readily (poor ones look for a pass instead).
      let shotKind = null;
      let edge = false; // shot from the edge of the box (attacking midfielders)
      const shooter = clamp((eff(h, 'sho') - 55) / 30, 0.3, 1.45); // sho 85 -> 1
      const longRange = clamp((0.6 * eff(h, 'sho') + 0.4 * h.player.fk - 68) / 18, 0.15, 1.4);
      const onGoal = chance && !isGK && depth >= 60;
      chance = false;
      if (fromCross) {
        // met in the air: strong players head it, good finishers may volley or control and shoot
        const r = rng();
        const pHead = clamp(0.32 + (h.player.phy - 70) / 70, 0.18, 0.62);
        if (r < pHead) shotKind = 'header';
        else if (r < pHead + 0.22 * shooter) shotKind = 'shot';
      }
      else if (onGoal) { if (rng() < clamp(0.6 * men.shoot * shooter, 0.35, 0.85)) shotKind = 'shot'; }
      else if (depth >= 70) { if (rng() < 0.15 * men.shoot * shooter) shotKind = 'shot'; }
      else if (depth >= 58 && h.slot.role !== 'DEF') { if (rng() < 0.08 * men.shoot * shooter) { shotKind = 'shot'; edge = true; } }
      else if (depth >= 54 && (h.slot.role === 'MID' || h.slot.role === 'FWD')) {
        if (rng() < 0.04 * men.shoot * longRange) shotKind = 'long';
      }
      const crossShot = fromCross;
      fromCross = false;
      if (shotKind) { shoot(shotKind, holder, edge, shotKind === 'header' || crossShot ? 88 : depth); continue; }

      // --- Wing play: a wide player runs down the line to get to the byline ------
      const onFlank = Math.abs(h.slot.y - 50) >= 30; // real wide players (wingers, full-backs, wide mids)
      const wasWingRun = wingRun;
      wingRun = false;
      if (!isGK && onFlank && !onGoal && depth >= 45 && depth < 82 && carried.n < 2) {
        const fullback = h.slot.role === 'DEF';
        const styleMul = { possession: 0.8, balanced: 1, counter: 1.2, direct: 1.2 }[team.tac.style] || 1;
        const pRun = clamp((eff(h, 'pac') - 68) / 90 + ((h.player.dri ?? 60) - 70) / 150, 0.04, 0.32) * styleMul * (fullback ? 0.45 : 1);
        if (rng() < pRun) {
          const by = nearestOpponent(oppSide, depth + 6, h.slot.y, (e) => e.slot.role !== 'GK');
          const m = T[oppSide].lineup[by];
          // a race down the line: pace first, then dribbling against the full-back
          const pWin = clamp(0.5 + (eff(h, 'pac') - eff(m, 'pac')) / 70 + (eff(h, 'dri') - eff(m, 'def')) / 140, 0.25, 0.85);
          minute += 0.25 + rng() * 0.2;
          stats[side].dribbles++;
          if (rng() < pWin) {
            stats[side].dribblesWon++;
            const adv = 10 + rng() * 8;
            events.push({ type: 'dribble', side, from: holder, by, ok: true, wing: true, minute: Math.floor(minute) });
            carry = { key: side + holder, adv: carried.adv + adv, n: 2 };
            wingRun = true;
            maybeFoul(holder, { x: Math.min(92, depth + adv), y: h.slot.y });
          } else {
            events.push({ type: 'dribble', side, from: holder, by, ok: false, wing: true, minute: Math.floor(minute) });
            turnover(oppSide, by);
          }
          continue;
        }
      }

      // --- Dribble: good dribblers sometimes take a defender on ----------------
      // Success gains ground (and maybe a foul); failure loses the ball to the tackler.
      if (!isGK && depth >= 30 && carried.n < 2) {
        const styleMul = { possession: 1, balanced: 1, counter: 1.3, direct: 0.7 }[team.tac.style] || 1;
        let pTry = clamp(((h.player.dri ?? 60) - 70) / 100, 0, 0.24) * styleMul * (h.slot.role === 'DEF' ? 0.4 : 1);
        if (onGoal) pTry = clamp(0.45 + ((h.player.dri ?? 60) - 75) / 60, 0.3, 0.75);
        if (rng() < pTry) {
          const by = nearestOpponent(oppSide, depth + 6, h.slot.y, (e) => e.slot.role !== 'GK');
          const m = T[oppSide].lineup[by];
          const pWin = clamp(0.52 + (eff(h, 'dri') - eff(m, 'def')) / 90 + (eff(h, 'pac') - eff(m, 'pac')) / 250, 0.25, 0.85);
          minute += 0.2 + rng() * 0.15;
          stats[side].dribbles++;
          if (rng() < pWin) {
            stats[side].dribblesWon++;
            const adv = 6 + rng() * 8;
            events.push({ type: 'dribble', side, from: holder, by, ok: true, minute: Math.floor(minute) });
            carry = { key: side + holder, adv: carried.adv + adv, n: carried.n + 1 };
            space = Math.max(space, 0.04);
            chance = depth + adv >= 68; // beat the defender in or near the box
            maybeFoul(holder, { x: Math.min(92, depth + adv), y: h.slot.y });
          } else {
            events.push({ type: 'dribble', side, from: holder, by, ok: false, minute: Math.floor(minute) });
            turnover(oppSide, by);
          }
          continue;
        }
      }

      // --- Delivery from the flank: cross (to the strongest in the air) or cut-back --
      const boxRunners = active(side).filter((o) => o.i !== holder && o.e.slot.role !== 'GK'
        && (o.e.slot.role === 'FWD' || (o.e.slot.role === 'MID' && Math.abs(o.e.slot.y - 50) < 30)));
      if (!isGK && onFlank && boxRunners.length && (wasWingRun || depth >= 70)
        && rng() < (wasWingRun ? 0.85 : 0.35) * Math.min(1.3, sty.cross)) {
        const byline = depth >= 72;
        const kind = byline && rng() < 0.6 ? 'cutback' : 'cross';
        const tgt = pickWeighted(rng, boxRunners, (o) => (kind === 'cross'
          ? Math.pow(o.e.player.phy / 70, 3) * (o.e.slot.role === 'FWD' ? 1.5 : 0.8)
          : (o.e.slot.role === 'MID' ? 1.4 : 1) * Math.pow(eff(o.e, 'sho') / 75, 2)));
        const markerIdx = nearestOpponent(oppSide, 76, tgt.e.slot.y, (e) => e.slot.role !== 'GK');
        const marker = T[oppSide].lineup[markerIdx].player;
        const deliverer = 0.5 * eff(h, 'pas') + 0.5 * h.player.fk;
        let p = 0.6 + (deliverer - pressure(oppSide, 75)) / 140 + PASS_MOD[kind] + (wasWingRun ? 0.1 : 0);
        p += kind === 'cross' ? (tgt.e.player.phy - marker.phy) / 120 + (sty.aerial || 0) + (hasFullbacks(oppSide) ? 0 : 0.08)
          : (eff(tgt.e, 'pac') - marker.pac) / 200;
        stats[side].passes++;
        minute += 0.35 + rng() * 0.2;
        if (rng() < clamp(p, 0.3, 0.85)) {
          stats[side].completed++;
          events.push({ type: 'pass', kind, side, from: holder, to: tgt.i, minute: Math.floor(minute) });
          lastPasser = holder;
          holder = tgt.i;
          if (kind === 'cross') { carry = { key: null, adv: 0, n: 0 }; fromCross = true; }
          else { carry = { key: side + tgt.i, adv: Math.max(0, 74 - tgt.e.slot.x), n: 2 }; chance = true; }
        } else {
          const keeper = kind === 'cross' && rng() < 0.3;
          const by = keeper ? gkOf(oppSide) : markerIdx;
          events.push({ type: 'intercept', kind, side, from: holder, to: tgt.i, by, minute: Math.floor(minute) });
          if (!keeper && rng() < (kind === 'cross' ? 0.35 : 0.2)) { setPiece = { type: 'corner', side }; continue; }
          turnover(oppSide, by);
        }
        continue;
      }

      // --- Pass ------------------------------------------------------------
      const wide = Math.abs(h.slot.y - 50) >= 28 && depth >= 55;
      const goLong = isGK && rng() < 0.4 + (team.tac.style === 'direct' ? 0.25 : team.tac.style === 'possession' ? -0.25 : 0);
      const countering = counterLeft > 0;
      const candidates = active(side)
        .filter((o) => o.i !== holder && o.e.slot.role !== 'GK')
        .filter((o) => !goLong || o.e.slot.x >= 40);
      const target = pickWeighted(rng, candidates, (o) => {
        const forward = o.e.slot.x - depth;
        const dist = Math.hypot(forward, o.e.slot.y - h.slot.y);
        // backward passes are short lay-offs, rarely a long ball back to the defence,
        // and the further up the pitch the holder is, the less he looks back
        const back = -forward;
        const lookBack = depth >= 55 ? 0.22 : 0.35;
        const maxBack = onGoal ? 15 : depth >= 62 ? 30 : Infinity;
        const progress = forward > -5 ? 1 + (forward / 18) * men.forward * (countering ? 1.5 : 1)
          : back > maxBack ? 0 : lookBack * Math.exp(-Math.max(0, back - 5) / 18);
        const reach = dist > 50 && !goLong ? 0.25 : 1;
        const inBox = o.e.slot.role === 'FWD' || (o.e.slot.role === 'MID' && o.e.slot.x >= 55 && Math.abs(o.e.slot.y - 50) < 20);
        const boxBias = wide && inBox ? 2 : 1;
        return progress === 0 ? 1e-6 : Math.max(0.005, progress * reach * boxBias);
      });

      const t = target.e.slot;
      const dx = t.x - depth;
      const dy = t.y - h.slot.y;
      const dist = Math.hypot(dx, dy);
      let kind = 'short';
      if (isGK) kind = goLong ? 'punt' : 'short';
      else if (wide && t.x >= 55 && Math.abs(t.y - 50) < 30 && rng() < 0.5 * sty.cross) kind = 'cross';
      else if (Math.abs(dy) >= 55 && dist >= 50 && rng() < 0.5 * sty.long) kind = 'switch';
      else if (dx >= 30 && dist >= 38 && rng() < Math.min(0.95, 0.6 * sty.long * (countering ? 1.3 : 1))) kind = 'long';
      else if (dx >= 10 && t.x >= 55 && rng() < Math.min(0.9, 0.4 * sty.through * (countering ? 1.8 : 1))) kind = 'through';

      const passer = AERIAL.has(kind) ? 0.6 * eff(h, 'pas') + 0.4 * h.player.fk : eff(h, 'pas');
      let p = 0.82 + (passer - pressure(oppSide, t.x)) / 140 + PASS_MOD[kind];
      if (kind === 'short') p += sty.short;
      if (t.x >= 60 && kind !== 'cross') p -= 0.1;
      if (t.x < 45) p += PRESS[T[oppSide].tac.press].ownHalf;
      if (countering) p += 0.05;
      p += space;
      p += menDown(oppSide) * 0.03 - menDown(side) * 0.02;
      // pace and aerial battles against the nearest marker
      const markerIdx = nearestOpponent(oppSide, t.x, t.y, (e) => e.slot.role !== 'GK');
      const marker = T[oppSide].lineup[markerIdx].player;
      if (kind === 'through') p += (target.e.player.pac - marker.pac) / 120;
      if (AERIAL.has(kind)) p += (target.e.player.phy - marker.phy) / 120 + (sty.aerial || 0);
      if (kind === 'cross' && !hasFullbacks(oppSide)) p += 0.08;
      const pSuccess = clamp(p, 0.35, 0.96);

      stats[side].passes++;
      minute += 0.28 + rng() * 0.22 + (kind === 'short' || kind === 'through' ? 0 : 0.1);
      if (counterLeft > 0) counterLeft--;

      if (rng() < pSuccess) {
        stats[side].completed++;
        events.push({ type: 'pass', kind, side, from: holder, to: target.i, minute: Math.floor(minute) });
        space = depth < 45 && t.x >= 45 && T[oppSide].tac.press === 'high' ? 0.05 : 0;
        lastPasser = holder;
        holder = target.i;
        carry = { key: null, adv: 0, n: 0 };
        // cut-back / lay-off from the final third: a midfielder arriving late into the box
        // takes it there (the better the attacker, the more often he makes the run)
        if (!isGK && depth >= 62 && target.e.slot.role === 'MID' && t.x < 70 && kind === 'short'
          && rng() < 0.45 * clamp((eff(target.e, 'att') - 60) / 30, 0.2, 1.2)) {
          carry = { key: side + target.i, adv: 72 - t.x, n: 2 };
          chance = true;
        }
        // a through ball into the final third puts the runner in behind the line
        if (kind === 'through' && t.x >= 60) {
          carry = { key: side + target.i, adv: Math.max(0, 76 - t.x), n: 1 };
          chance = true;
        }
        fromCross = kind === 'cross';
        maybeFoul(target.i, t);
      } else {
        const by = AERIAL.has(kind) ? markerIdx : nearestOpponent(oppSide, t.x, t.y);
        events.push({ type: 'intercept', kind, side, from: holder, to: target.i, by, minute: Math.floor(minute) });
        // a cross cleared behind -> corner
        if (kind === 'cross' && rng() < 0.3) { setPiece = { type: 'corner', side }; continue; }
        // knocked out over the touchline -> throw-in to the defending side
        const pOut = (kind === 'long' || kind === 'switch' || kind === 'punt') ? 0.3 : Math.abs(t.y - 50) >= 25 ? 0.2 : 0.06;
        const byGK = T[oppSide].lineup[by].slot.role === 'GK';
        if (!byGK && rng() < pOut) {
          events[events.length - 1].out = true;
          // spot in the throwing team's own frame (depth/width 0..100)
          setPiece = { type: 'throwin', side: oppSide, x: clamp(100 - t.x, 3, 97), y: t.y >= 50 ? 0 : 100 };
          continue;
        }
        turnover(oppSide, by);
      }
    }

    if (setPiece) { const sp = setPiece; setPiece = null; playSetPiece(sp); }
    events.push({ type: 'end', minute: Math.floor(minute), score: { ...score } });

    // Minutes in stoppage time are shown as 45+2 / 90+3: split them into minute + plus.
    let half2 = false;
    events.forEach((e) => {
      if (e.type === 'half') { half2 = true; return; }
      if (e.minute === undefined) return;
      const base = half2 ? 90 : 45;
      if (e.minute > base) { e.plus = e.minute - base; e.minute = base; }
    });

    const ratings = rateMatch(events, startIds, score);
    return {
      events, score, stats, seed, ratings,
      subs: { home: T.home.subs, away: T.away.subs },
      sentOff: { home: [...T.home.off], away: [...T.away.off] },
    };
  }

  const api = { simulate, eff, TACTIC_DEFAULT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);
