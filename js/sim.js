// Match engine: produces a deterministic list of events from two lineups + seed (+ tactics).
// A lineup is [{ player, slot: { role, x, y } }, ...] (11 entries).
//
// What shapes the result:
//  - Player skills: att (finishing), pas, def, pac (pace), phy (aerial/strength), fk (kicking).
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
    short: 0.03, through: -0.08, long: -0.1, switch: -0.06, cross: -0.12, punt: -0.2, corner: -0.05, fkcross: -0.05,
  };
  const SHOT_MOD = {
    shot: { on: 0.06, goal: 0.06 },
    long: { on: -0.1, goal: -0.12 },
    header: { on: -0.02, goal: 0.02 },
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

  // A player out of their natural role loses effectiveness (technical stats only).
  function eff(entry, stat) {
    const { player, slot } = entry;
    const v = player[stat] ?? 70;
    if (stat === 'pac' || stat === 'phy' || stat === 'fk') return v;
    if (player.pos === slot.role) return v;
    if (player.pos === 'GK' || slot.role === 'GK') return v * 0.5;
    return v * 0.88;
  }

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
      fouls: 0, yellows: 0, reds: 0, corners: 0, freekicks: 0, penalties: 0,
    };
  }

  function simulate(home, away, seed, tactics) {
    const rng = mulberry32(seed >>> 0);
    const T = {
      home: { lineup: home, tac: { ...TACTIC_DEFAULT, ...(tactics && tactics.home) }, off: new Set(), booked: new Set() },
      away: { lineup: away, tac: { ...TACTIC_DEFAULT, ...(tactics && tactics.away) }, off: new Set(), booked: new Set() },
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
      side = s; holder = idx; lastPasser = null; fromCross = false; counterLeft = 0; space = 0;
      events.push({ type, side, holder, minute: Math.floor(minute) });
    };
    const turnover = (newSide, idx) => {
      side = newSide; holder = idx; lastPasser = null; fromCross = false; space = 0;
      const tac = T[newSide].tac;
      const oppAttacking = T[other(newSide)].tac.mentality === 'attacking';
      counterLeft = tac.style === 'counter' ? 3 : oppAttacking ? 2 : 0;
    };

    // ---------- shots ----------
    function shoot(kind, idx, edge = false) {
      const team = T[side];
      const oppSide = other(side);
      const sh = team.lineup[idx];
      const st = stats[side];
      minute += 0.4;
      st.shots++;
      const gkIdx = gkOf(oppSide);
      const gk = eff(T[oppSide].lineup[gkIdx], 'def');
      let a = eff(sh, 'att');
      if (kind === 'long') a = 0.5 * a + 0.5 * sh.player.fk;
      if (kind === 'header') a = 0.5 * a + 0.5 * sh.player.phy;
      if (kind === 'freekick') a = 0.3 * a + 0.7 * sh.player.fk;
      if (kind === 'penalty') a = 0.6 * a + 0.4 * sh.player.fk;

      let onTarget;
      let pGoal;
      if (kind === 'penalty') {
        onTarget = clamp(0.86 + (a - 80) / 200, 0.75, 0.95);
        pGoal = clamp(0.74 + (a - gk) / 120, 0.55, 0.9);
      } else {
        const mod = SHOT_MOD[kind];
        const range = edge ? 0.03 : 0;
        onTarget = clamp(0.28 + (a - 70) / 90 + mod.on - range, 0.1, 0.65);
        pGoal = clamp(0.24 + (a - gk) / 120 + mod.goal - range + menDown(oppSide) * 0.03, 0.04, 0.5);
      }
      const base = { side, from: idx, kind, minute: Math.floor(minute), aimY: 38 + rng() * 24 };

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
      if (sp.direct) shoot('freekick', taker);
      else if (sp.x >= 55) deliver('fkcross', taker);
      // otherwise: taken short, play continues from the taker
    }

    restart('home', kickoffTaker('home'), 'kickoff');

    while (minute < 90) {
      if (!secondHalf && minute >= 45) {
        secondHalf = true;
        minute = 45;
        setPiece = null;
        events.push({ type: 'half', minute: 45 });
        restart('away', kickoffTaker('away'), 'kickoff');
      }
      if (setPiece) {
        const sp = setPiece;
        setPiece = null;
        playSetPiece(sp);
        continue;
      }

      const oppSide = other(side);
      const team = T[side];
      const h = team.lineup[holder];
      const depth = h.slot.x;
      const isGK = h.slot.role === 'GK';
      const men = MENTALITY[team.tac.mentality];
      const sty = STYLE[team.tac.style];

      // --- Shot decision -------------------------------------------------
      let shotKind = null;
      let edge = false; // shot from the edge of the box (attacking midfielders)
      if (fromCross) { if (rng() < 0.45) shotKind = 'header'; }
      else if (depth >= 70) { if (rng() < 0.22 * men.shoot) shotKind = 'shot'; }
      else if (depth >= 55 && h.slot.role !== 'DEF') { if (rng() < 0.08 * men.shoot) { shotKind = 'shot'; edge = true; } }
      else if (depth >= 40 && (h.slot.role === 'MID' || h.slot.role === 'FWD')) {
        if (rng() < 0.05 * men.shoot * (0.6 + h.player.fk / 200)) shotKind = 'long';
      }
      fromCross = false;
      if (shotKind) { shoot(shotKind, holder, edge); continue; }

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
        const progress = forward > -5 ? 1 + (forward / 18) * men.forward * (countering ? 1.5 : 1) : 0.35;
        const reach = dist > 50 && !goLong ? 0.25 : 1;
        const inBox = o.e.slot.role === 'FWD' || (o.e.slot.role === 'MID' && o.e.slot.x >= 55 && Math.abs(o.e.slot.y - 50) < 20);
        const boxBias = wide && inBox ? 2 : 1;
        return Math.max(0.05, progress * reach * boxBias);
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
        fromCross = kind === 'cross';
        maybeFoul(target.i, t);
      } else {
        const by = AERIAL.has(kind) ? markerIdx : nearestOpponent(oppSide, t.x, t.y);
        events.push({ type: 'intercept', kind, side, from: holder, to: target.i, by, minute: Math.floor(minute) });
        // a cross cleared behind -> corner
        if (kind === 'cross' && rng() < 0.3) { setPiece = { type: 'corner', side }; continue; }
        turnover(oppSide, by);
      }
    }

    events.push({ type: 'end', minute: 90, score: { ...score } });
    return { events, score, stats, seed, sentOff: { home: [...T.home.off], away: [...T.away.off] } };
  }

  const api = { simulate, eff, TACTIC_DEFAULT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);
