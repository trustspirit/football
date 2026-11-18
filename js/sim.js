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

    const restart = (s, idx, type) => {
      side = s; holder = idx; lastPasser = null;
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

      // --- Shot decision -------------------------------------------------
      const shootChance = depth >= 70 ? 0.24 : depth >= 55 ? 0.04 : 0;
      if (rng() < shootChance) {
        minute += 0.4;
        const st = stats[side];
        st.shots++;
        const att = eff(h, 'att');
        const gkIdx = indexOfRole(opp, 'GK');
        const gk = gkIdx >= 0 ? eff(opp[gkIdx], 'def') : 40;
        const range = depth >= 70 ? 0.06 : -0.08;
        const onTarget = rng() < clamp(0.28 + (att - 70) / 90 + range, 0.15, 0.6);
        const base = { side, from: holder, minute: Math.floor(minute), aimY: 38 + rng() * 24 };

        if (!onTarget) {
          events.push({ ...base, type: 'miss', aimY: rng() < 0.5 ? 30 + rng() * 8 : 62 + rng() * 8 });
          restart(other(side), Math.max(0, gkIdx), 'goalkick');
          continue;
        }
        st.onTarget++;
        const pGoal = clamp(0.24 + (att - gk) / 120 + range, 0.08, 0.45);
        if (rng() < pGoal) {
          st.goals++;
          score[side]++;
          events.push({ ...base, type: 'goal', assist: lastPasser, score: { ...score } });
          restart(other(side), kickoffTaker(opp), 'kickoff');
        } else {
          events.push({ ...base, type: 'save', keeper: gkIdx });
          restart(other(side), Math.max(0, gkIdx), 'gkball');
        }
        continue;
      }

      // --- Pass ------------------------------------------------------------
      const candidates = team
        .map((e, i) => ({ e, i }))
        .filter((o) => o.i !== holder && o.e.slot.role !== 'GK');
      const target = pickWeighted(rng, candidates, (o) => {
        const forward = o.e.slot.x - depth;
        const dist = Math.hypot(forward, o.e.slot.y - h.slot.y);
        const progress = forward > -5 ? 1 + forward / 18 : 0.35;
        const reach = dist > 50 ? 0.25 : 1;
        return Math.max(0.05, progress * reach);
      });

      const passer = eff(h, 'pas');
      const press = pressure(opp, target.e.slot.x);
      const long = target.e.slot.x - depth > 30 ? 0.1 : 0;
      const final3 = target.e.slot.x >= 60 ? 0.1 : 0;
      const pSuccess = clamp(0.82 + (passer - press) / 140 - long - final3, 0.5, 0.95);

      stats[side].passes++;
      minute += 0.28 + rng() * 0.22;

      if (rng() < pSuccess) {
        stats[side].completed++;
        events.push({ type: 'pass', side, from: holder, to: target.i, minute: Math.floor(minute) });
        lastPasser = holder;
        holder = target.i;
      } else {
        const by = nearestOpponent(opp, target.e.slot.x, target.e.slot.y);
        events.push({ type: 'intercept', side, from: holder, to: target.i, by, minute: Math.floor(minute) });
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
