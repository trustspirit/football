// Match engine: produces a deterministic list of events from two lineups + seed.
// A lineup is [{ player, slot: { role, x, y } }, ...] (11 entries).
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

  // A player out of their natural role loses effectiveness.
  function eff(entry, stat) {
    const { player, slot } = entry;
    const v = player[stat];
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

  function indexOfRole(lineup, role) {
    return lineup.findIndex((e) => e.slot.role === role);
  }

  function kickoffTaker(lineup) {
    let best = 0, bestScore = -Infinity;
    lineup.forEach((e, i) => {
      const score = e.slot.x - Math.abs(e.slot.y - 50) * 0.6;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  // Opponent closest to a point given in the *attacking* team's coordinates.
  function nearestOpponent(oppLineup, x, y) {
    let best = 0, bestD = Infinity;
    oppLineup.forEach((e, i) => {
      const ox = 100 - e.slot.x, oy = 100 - e.slot.y;
      const d = (ox - x) ** 2 + (oy - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // Average defending of the opponent line that guards zone x.
  function pressure(oppLineup, x) {
    const role = x >= 60 ? 'DEF' : x >= 30 ? 'MID' : 'FWD';
    const line = oppLineup.filter((e) => e.slot.role === role);
    if (!line.length) return 60;
    return line.reduce((s, e) => s + eff(e, 'def'), 0) / line.length;
  }

  // Success / accuracy modifiers per pass and shot type.
  const PASS_MOD = { short: 0.03, through: -0.08, long: -0.1, switch: -0.06, cross: -0.12, punt: -0.2 };
  const SHOT_MOD = {
    shot: { on: 0.06, goal: 0.06 },
    long: { on: -0.1, goal: -0.12 },
    header: { on: -0.02, goal: 0.02 },
  };

  function newStats() {
    return { passes: 0, completed: 0, shots: 0, onTarget: 0, goals: 0 };
  }

  function simulate(home, away, seed) {
    const rng = mulberry32(seed >>> 0);
    const teams = { home, away };
    const stats = { home: newStats(), away: newStats() };
    const score = { home: 0, away: 0 };
    const events = [];
    let minute = 0;
    let secondHalf = false;
    let side = 'home';
    let holder = kickoffTaker(home);
    let lastPasser = null;
    let fromCross = false;

    const restart = (s, idx, type) => {
      side = s; holder = idx; lastPasser = null; fromCross = false;
      events.push({ type, side, holder, minute: Math.floor(minute) });
    };

    restart('home', holder, 'kickoff');

    while (minute < 90) {
      if (!secondHalf && minute >= 45) {
        secondHalf = true;
        minute = 45;
        events.push({ type: 'half', minute: 45 });
        restart('away', kickoffTaker(away), 'kickoff');
      }

      const team = teams[side];
      const opp = teams[other(side)];
      const h = team[holder];
      const depth = h.slot.x;
      const isGK = h.slot.role === 'GK';

      // --- Shot decision -------------------------------------------------
      // kinds: 'shot' (inside the box), 'long' (from distance), 'header' (after a cross)
      let shotKind = null;
      if (fromCross) { if (rng() < 0.45) shotKind = 'header'; }
      else if (depth >= 70) { if (rng() < 0.22) shotKind = 'shot'; }
      else if (depth >= 40 && (h.slot.role === 'MID' || h.slot.role === 'FWD')) { if (rng() < 0.05) shotKind = 'long'; }
      fromCross = false;

      if (shotKind) {
        minute += 0.4;
        const st = stats[side];
        st.shots++;
        const mod = SHOT_MOD[shotKind];
        const att = eff(h, 'att');
        const gkIdx = indexOfRole(opp, 'GK');
        const gk = gkIdx >= 0 ? eff(opp[gkIdx], 'def') : 40;
        const onTarget = rng() < clamp(0.28 + (att - 70) / 90 + mod.on, 0.12, 0.6);
        const base = { side, from: holder, kind: shotKind, minute: Math.floor(minute), aimY: 38 + rng() * 24 };

        if (!onTarget) {
          // wide of a post, or over the bar
          const over = rng() < (shotKind === 'shot' ? 0.3 : 0.5);
          const aimY = over ? 40 + rng() * 20 : rng() < 0.5 ? 30 + rng() * 7 : 63 + rng() * 7;
          events.push({ ...base, type: 'miss', aimY, over });
          restart(other(side), Math.max(0, gkIdx), 'goalkick');
          continue;
        }
        st.onTarget++;
        const pGoal = clamp(0.24 + (att - gk) / 120 + mod.goal, 0.05, 0.45);
        if (rng() < pGoal) {
          st.goals++;
          score[side]++;
          events.push({ ...base, type: 'goal', assist: lastPasser, score: { ...score } });
          restart(other(side), kickoffTaker(opp), 'kickoff');
        } else {
          events.push({ ...base, type: 'save', keeper: gkIdx, caught: rng() < 0.55 });
          restart(other(side), Math.max(0, gkIdx), 'gkball');
        }
        continue;
      }

      // --- Pass ------------------------------------------------------------
      const wide = Math.abs(h.slot.y - 50) >= 28 && depth >= 55;
      const goLong = isGK && rng() < 0.55; // keepers often launch it
      const candidates = team
        .map((e, i) => ({ e, i }))
        .filter((o) => o.i !== holder && o.e.slot.role !== 'GK')
        .filter((o) => !goLong || o.e.slot.x >= 40);
      const target = pickWeighted(rng, candidates, (o) => {
        const forward = o.e.slot.x - depth;
        const dist = Math.hypot(forward, o.e.slot.y - h.slot.y);
        const progress = forward > -5 ? 1 + forward / 18 : 0.35;
        const reach = dist > 50 && !goLong ? 0.25 : 1;
        const boxBias = wide && o.e.slot.role === 'FWD' ? 2 : 1;
        return Math.max(0.05, progress * reach * boxBias);
      });

      const t = target.e.slot;
      const dx = t.x - depth;
      const dy = t.y - h.slot.y;
      const dist = Math.hypot(dx, dy);
      let kind = 'short';
      if (isGK) kind = goLong ? 'punt' : 'short';
      else if (wide && t.x >= 65 && Math.abs(t.y - 50) < 30 && rng() < 0.5) kind = 'cross';
      else if (Math.abs(dy) >= 55 && dist >= 50 && rng() < 0.5) kind = 'switch';
      else if (dx >= 30 && dist >= 38 && rng() < 0.6) kind = 'long';
      else if (dx >= 10 && t.x >= 55 && rng() < 0.4) kind = 'through';

      const passer = eff(h, 'pas');
      const press = pressure(opp, t.x);
      const final3 = t.x >= 60 && kind !== 'cross' ? 0.1 : 0;
      const pSuccess = clamp(0.82 + (passer - press) / 140 + PASS_MOD[kind] - final3, 0.4, 0.95);

      stats[side].passes++;
      minute += 0.28 + rng() * 0.22 + (kind === 'short' || kind === 'through' ? 0 : 0.1);

      if (rng() < pSuccess) {
        stats[side].completed++;
        events.push({ type: 'pass', kind, side, from: holder, to: target.i, minute: Math.floor(minute) });
        lastPasser = holder;
        holder = target.i;
        fromCross = kind === 'cross';
      } else {
        const by = nearestOpponent(opp, t.x, t.y);
        events.push({ type: 'intercept', kind, side, from: holder, to: target.i, by, minute: Math.floor(minute) });
        side = other(side);
        holder = by;
        lastPasser = null;
      }
    }

    events.push({ type: 'end', minute: 90, score: { ...score } });
    return { events, score, stats, seed };
  }

  const api = { simulate, eff };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);
