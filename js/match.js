// Match screen: replays the event list produced by Sim.simulate on a pitch.
//
// Everything moves in pitch meters (105 x 68) on a requestAnimationFrame loop:
//  - Players are steering agents whose top speed comes from their pace, with acceleration,
//    separation, a team shape that follows the ball and reflects tactics, pressing and runs.
//  - The ball is held (dribbled), in flight (ground pass with friction, or lofted with a
//    height arc + shadow, then bounces and rolls), or dead. Fast balls leave a short trail.
//  - Set pieces (free kicks with a wall, penalties, corners), fouls and cards are staged.
(function () {
  const $ = (s) => document.querySelector(s);
  const W = 105;
  const H = 68;
  const TIME_SCALE = 3;           // simulated seconds per real second at 1x
  const other = (s) => (s === 'home' ? 'away' : 'home');
  const key = (side, i) => `${side}-${i}`;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const dirOf = (side) => (side === 'home' ? 1 : -1);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const inPitch = (p, m = 1.5) => ({ x: clamp(p.x, m, W - m), y: clamp(p.y, m, H - m) });

  const PASS = {
    short: { air: false, arrive: 5 },
    cutback: { air: false, arrive: 6 },
    through: { air: false, arrive: 7, lead: 9 },
    long: { air: true, peak: 0.11 },
    switch: { air: true, peak: 0.09 },
    cross: { air: true, peak: 0.08 },
    punt: { air: true, peak: 0.17 },
    corner: { air: true, peak: 0.13 },
    fkcross: { air: true, peak: 0.1 },
    throw: { air: true, peak: 0.06 },
  };
  const SHOT_KO = { shot: '슛', long: '중거리 슛', header: '헤딩', freekick: '프리킥', penalty: '페널티킥' };
  const MENT_SHIFT = { defensive: -4, balanced: 0, attacking: 4 };
  const PRESS_SHIFT = { low: -7, mid: 0, high: 6 };

  let teams = null;
  let result = null;
  let runId = 0;
  let speed = 2; // default playback speed (matches the highlighted 2× button)
  let skipping = false;
  let backCb = () => {};
  const live = { possession: 'home', kickoff: false, celebrate: null, setPiece: null, score: { home: 0, away: 0 }, cards: null };

  const agents = {};
  const ball = { p: { x: W / 2, y: H / 2 }, h: 0, mode: 'dead', holder: null, fl: null, spin: 0, touch: 0, alpha: 1, dest: null, speed: 0 };
  const trail = [];
  // The referee trails play diagonally and runs in to show cards.
  const ref = { p: { x: W / 2, y: H / 2 + 8 }, v: { x: 0, y: 0 }, goal: null, ov: null, el: null };
  let simT = 0;
  let last = 0;
  let rafGen = 0;
  let pxPerM = 11;
  let timers = [];

  // ---------- time ----------
  // Sim-time wait. A wait requested by a match that has since been stopped never resolves,
  // so an old playback chain quietly ends instead of touching the new match.
  function simWait(sec) {
    const run = runId;
    if (skipping) return run === runId ? Promise.resolve() : new Promise(() => {});
    return new Promise((resolve) => timers.push({ at: simT + sec, resolve, run }));
  }

  // ---------- team shape ----------
  function shapeTarget(o) {
    const side = o.side;
    const inPoss = live.possession === side;
    const tac = teams[side].tactic || {};
    const bx = (ball.p.x / W) * 100;
    const by = (ball.p.y / H) * 100;
    const bD = side === 'home' ? bx : 100 - bx;
    const bW = side === 'home' ? by : 100 - by;
    const s = o.slot;
    let d;
    let w;
    if (s.role === 'GK') {
      d = 2.5 + clamp((bD - 25) * 0.07, 0, 6) + (tac.press === 'high' ? 2 : 0);
      w = 50 + (bW - 50) * 0.3;
    } else {
      // the block follows the ball up the pitch (midfield most), and in the attacking third the
      // side in possession pushes on: forwards into the box, midfield to its edge, full-backs overlap
      const follow = bD < 50 ? 0.4 : { DEF: 0.55, MID: 0.65, FWD: 0.6 }[s.role] || 0.55;
      d = 8 + s.x * 0.6 + (bD - 50) * follow + (inPoss ? 8 : -2);
      if (inPoss) {
        const a = clamp((bD - 55) / 25, 0, 1);
        const fullback = s.role === 'DEF' && Math.abs(s.y - 50) >= 25;
        d += a * (s.role === 'FWD' ? 10 : s.role === 'MID' ? 8 : fullback ? 14 : 4);
      }
      d += MENT_SHIFT[tac.mentality] || 0;
      if (!inPoss) d += PRESS_SHIFT[tac.press] || 0;
      if (!inPoss && s.role === 'DEF') d = Math.min(d, Math.max(bD - 6, 8)); // hold a line behind the ball
      w = 50 + (s.y - 50) * (inPoss ? 1 : 0.78) + (bW - 50) * (inPoss ? 0.2 : 0.35);
      d += o.offs.dx * (inPoss ? 1 : 0.4);
      w += o.offs.dy;
    }
    if (live.kickoff) d = Math.min(d, 48);
    d = clamp(d, 1.5, 96);
    w = clamp(w, 4, 96);
    const xp = side === 'home' ? d : 100 - d;
    const yp = side === 'home' ? w : 100 - w;
    return { x: (xp / 100) * W, y: (yp / 100) * H };
  }

  const activeAgents = () => Object.values(agents).filter((o) => !o.gone);

  // Top speed from pace: 50 -> 6.6 m/s, 97 -> ~9.4 m/s; jogging is ~62 % of that.
  function setPace(o, player) {
    o.sprint = 6.6 + (((player.pac ?? 75) - 50) / 50) * 3;
    o.jog = o.sprint * 0.62;
    o.phy = player.phy ?? 70;
  }
  // Stamina option: legs get heavier with minutes played (up to -14 %, less for strong players).
  function tiredness(o) {
    if (!live.stamina || o.role === 'GK') return 1;
    const played = Math.max(0, (live.minute || 0) - (o.since || 0));
    const resist = clamp(1 - (o.phy - 60) / 70, 0.35, 1);
    return 1 - 0.14 * Math.min(1, played / 95) * resist;
  }

  function plan() {
    const list = activeAgents();
    list.forEach((o) => {
      o.goal = shapeTarget(o);
      o.max = o.role === 'GK' ? o.jog * 0.85 : o.jog;
      o.acc = 8;
    });

    // sent-off players walk to the touchline
    list.filter((o) => o.off).forEach((o) => {
      o.goal = { x: o.p.x, y: o.p.y < H / 2 ? -3 : H + 3 };
      o.max = 2.5;
    });

    if (live.celebrate) {
      const { side, scorer, corner } = live.celebrate;
      const sc = agents[scorer];
      list.forEach((o) => {
        if (o.off) return;
        if (o.key === scorer) { o.goal = corner; o.max = o.jog * 1.3; }
        else if (o.side === side && o.role !== 'GK') {
          const a = (o.i / 11) * Math.PI * 2;
          o.goal = inPitch({ x: sc.p.x + Math.cos(a) * 2.2, y: sc.p.y + Math.sin(a) * 2.2 });
          o.max = o.jog * 1.2;
        } else o.max = 2.5;
      });
      return;
    }

    if (live.setPiece) {
      list.forEach((o) => { if (o.spot && !o.off) { o.goal = o.spot; o.max = o.jog; } });
    } else {
      // Pressing: nearest opponents close down the ball carrier / landing spot.
      const focus = ball.mode === 'held' && ball.holder ? ball.p : ball.dest;
      const attSide = ball.mode === 'held' && ball.holder ? agents[ball.holder].side : live.possession;
      if (focus && !live.kickoff) {
        const defTac = teams[other(attSide)].tactic || {};
        const pressSpd = defTac.press === 'high' ? 1.05 : defTac.press === 'low' ? 0.75 : 0.9;
        const pressers = list
          .filter((o) => o.side !== attSide && o.role !== 'GK' && !o.ov && !o.off)
          .sort((a, b) => dist(a.p, focus) - dist(b.p, focus));
        if (pressers[0]) {
          pressers[0].goal = inPitch({ x: focus.x + dirOf(attSide) * 1.6, y: focus.y });
          pressers[0].max = pressers[0].sprint * pressSpd;
        }
        if (pressers[1]) {
          pressers[1].goal = lerpP(pressers[1].goal, focus, 0.45);
          pressers[1].max = pressers[1].jog * 1.2;
        }
      }
      if (ball.mode === 'held' && ball.holder) {
        const c = agents[ball.holder];
        if (c.run) { c.goal = c.run; c.max = c.role === 'GK' ? 2.5 : c.jog * 1.1; }
      }
    }

    list.forEach((o) => {
      if (o.ov && !o.off) {
        o.goal = o.ov.t;
        o.max = o.ov.spd === 'sprint' ? o.sprint : o.ov.spd;
        o.acc = o.ov.acc || 14;
      }
      if (!o.off) o.max *= tiredness(o);
    });
  }

  // ---------- physics ----------
  function stepAgents(dt) {
    const list = activeAgents();
    list.forEach((o) => {
      const dx = o.goal.x - o.p.x;
      const dy = o.goal.y - o.p.y;
      const d = Math.hypot(dx, dy);
      const want = d < 0.05 ? 0 : o.max * Math.min(1, d / 3.5);
      let dvx = (d ? (dx / d) * want : 0) - o.v.x;
      let dvy = (d ? (dy / d) * want : 0) - o.v.y;
      const dv = Math.hypot(dvx, dvy);
      const maxDv = o.acc * dt;
      if (dv > maxDv && dv > 0) { dvx *= maxDv / dv; dvy *= maxDv / dv; }
      o.v.x += dvx;
      o.v.y += dvy;
    });
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a];
        const B = list[b];
        const dx = B.p.x - A.p.x;
        const dy = B.p.y - A.p.y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d < 2) {
          const push = ((2 - d) * 4 * dt) / d;
          A.v.x -= dx * push; A.v.y -= dy * push;
          B.v.x += dx * push; B.v.y += dy * push;
        }
      }
    }
    list.forEach((o) => {
      o.p.x = clamp(o.p.x + o.v.x * dt, 0.5, W - 0.5);
      o.p.y = clamp(o.p.y + o.v.y * dt, o.off ? -4 : 0.5, o.off ? H + 4 : H - 0.5);
      o.stride += Math.hypot(o.v.x, o.v.y) * dt * 2.4;
      if (o.off && (o.p.y < -2 || o.p.y > H + 2)) { o.gone = true; o.el.hidden = true; }
      if (simT > o.nextOff) {
        const att = live.possession === o.side && (o.role === 'FWD' || o.role === 'MID');
        o.offs = { dx: rand(-3, 3) + (att ? rand(0, 6) : 0), dy: rand(-4, 4) };
        o.nextOff = simT + rand(1.5, 4);
      }
    });
  }

  function stepRef(dt) {
    const side = ball.p.y < H / 2 ? 1 : -1; // stay on the far side of the ball
    const goal = ref.ov || inPitch({ x: ball.p.x - dirOf(live.possession) * 9, y: ball.p.y + side * 10 }, 3);
    const max = ref.ov ? 8 : 6;
    const dx = goal.x - ref.p.x;
    const dy = goal.y - ref.p.y;
    const d = Math.hypot(dx, dy);
    const want = d < 0.05 ? 0 : max * Math.min(1, d / 4);
    const k = 1 - Math.exp(-dt * 3);
    ref.v.x += ((d ? (dx / d) * want : 0) - ref.v.x) * k;
    ref.v.y += ((d ? (dy / d) * want : 0) - ref.v.y) * k;
    ref.p.x += ref.v.x * dt;
    ref.p.y += ref.v.y * dt;
  }

  function stepBall(dt) {
    const before = { ...ball.p };
    if (ball.mode === 'flight') {
      const f = ball.fl;
      f.t = Math.min(f.T, f.t + dt);
      const u = f.t / f.T;
      const s = f.air ? f.D * u : f.v0 * f.t - (f.dec * f.t * f.t) / 2;
      ball.p = { x: f.from.x + f.ux * s, y: f.from.y + f.uy * s };
      ball.h = f.h0 * (1 - u) + f.h1 * u + 4 * f.peak * u * (1 - u);
      if (f.t >= f.T) finishFlight();
    } else if (ball.mode === 'held' && ball.holder) {
      const o = agents[ball.holder];
      const sp = Math.hypot(o.v.x, o.v.y);
      const hd = sp > 0.8 ? { x: o.v.x / sp, y: o.v.y / sp } : { x: dirOf(o.side), y: 0 };
      ball.touch += sp * dt * 0.9;
      const lead = 0.55 + (sp > 0.8 ? 0.9 * Math.abs(Math.sin(ball.touch)) : 0);
      const want = { x: o.p.x + hd.x * lead, y: o.p.y + hd.y * lead + 0.4 };
      const k = 1 - Math.exp(-dt * 12);
      ball.p = lerpP(ball.p, want, k);
      ball.h += (0 - ball.h) * k;
    } else if (ball.mode === 'hover' && ball.holder) {
      const o = agents[ball.holder];
      ball.p = lerpP(ball.p, { x: o.p.x, y: o.p.y }, 1 - Math.exp(-dt * 10));
    }
    const moved = dist(before, ball.p);
    ball.speed = dt > 0 ? moved / dt : 0;
    ball.spin += moved * 55;
  }

  function finishFlight() {
    const f = ball.fl;
    ball.fl = null;
    ball.dest = null;
    ball.p = { ...f.to };
    ball.h = f.h1;
    ball.mode = f.then.mode;
    ball.holder = f.then.holder || null;
    f.resolve();
  }

  function flightTime(D, o) {
    if (o.T) return o.T;
    if (o.air) return 0.55 + D / 21;
    const v1 = o.arrive ?? 5;
    const dec = o.dec ?? 5;
    return (Math.sqrt(v1 * v1 + 2 * dec * D) - v1) / dec;
  }

  function kick(to, o) {
    const from = { ...ball.p };
    const D = Math.max(0.01, dist(from, to));
    const T = Math.max(0.12, flightTime(D, o));
    const dec = o.dec ?? 5;
    const v1 = o.arrive ?? 5;
    const f = {
      from, to: { ...to }, D, T, t: 0, air: !!o.air,
      ux: (to.x - from.x) / D, uy: (to.y - from.y) / D,
      v0: o.air ? 0 : Math.sqrt(v1 * v1 + 2 * dec * D), dec,
      h0: o.h0 ?? ball.h, h1: o.h1 ?? 0, peak: o.air ? (o.peakAbs ?? D * (o.peak ?? 0.1)) : (o.peakAbs ?? 0),
      then: o.then || { mode: 'dead' },
    };
    ball.mode = 'flight';
    ball.holder = null;
    ball.dest = { ...to };
    // boot on ball: a proper strike, not bounces/rolls (those start at ground level with low peaks)
    if (!skipping && !o.silent) Sound.kick(clamp(D / T / 30, 0.15, 1));
    return new Promise((resolve) => {
      f.resolve = resolve;
      ball.fl = f;
      if (skipping) finishFlight();
    });
  }

  // A lofted ball lands, bounces twice (lower each time) and rolls to the receiver.
  async function bounceAndRoll(landing, dir, toK) {
    if (skipping) { if (toK) { ball.mode = 'held'; ball.holder = toK; } return; }
    const ux = dir.x;
    const uy = dir.y;
    const b1 = inPitch({ x: landing.x + ux * 2.4, y: landing.y + uy * 2.4 });
    await kick(b1, { air: true, T: 0.42, peakAbs: 0.7, h0: 0, h1: 0, then: { mode: 'dead' }, silent: true });
    const b2 = inPitch({ x: b1.x + ux * 1.3, y: b1.y + uy * 1.3 });
    await kick(b2, { air: true, T: 0.24, peakAbs: 0.22, h0: 0, h1: 0, then: { mode: 'dead' }, silent: true });
    if (toK) {
      const f = footOf(toK);
      await kick(f, { air: false, arrive: 1.5, dec: 4, then: { mode: 'held', holder: toK }, silent: true });
    }
  }

  const footOf = (k) => {
    const o = agents[k];
    return { x: o.p.x + dirOf(o.side) * 0.6, y: o.p.y + 0.4 };
  };

  // ---------- rendering ----------
  // Everything is positioned with translate3d in px (pitch meters * pxPerM): moving
  // `left/top` would trigger layout for ~25 elements every frame, which tablets feel.
  const px = (m) => (m * pxPerM).toFixed(1);
  function draw() {
    activeAgents().forEach((o) => {
      const sp = Math.hypot(o.v.x, o.v.y);
      const bob = Math.sin(o.stride) * Math.min(1, sp / 6) * 1.6;
      o.el.style.transform = `translate3d(${px(o.p.x)}px, ${(o.p.y * pxPerM + bob).toFixed(1)}px, 0) translate(-50%, -50%)`;
      const has = ball.holder === o.key && ball.mode === 'held';
      if (o.hasBall !== has) { o.hasBall = has; o.el.classList.toggle('has-ball', has); }
    });
    if (ref.el) ref.el.style.transform = `translate3d(${px(ref.p.x)}px, ${px(ref.p.y)}px, 0) translate(-50%, -50%)`;
    const b = $('#ball');
    const s = $('#ball-shadow');
    const lift = ball.h * pxPerM * 1.1;
    const bx = px(ball.p.x);
    const by = px(ball.p.y);
    b.style.opacity = String(ball.alpha);
    b.style.transform = `translate3d(${bx}px, ${(ball.p.y * pxPerM - lift).toFixed(1)}px, 0) translate(-50%, -50%) scale(${(1 + ball.h * 0.09).toFixed(3)}) rotate(${ball.spin.toFixed(0)}deg)`;
    s.style.opacity = String(ball.alpha * Math.max(0.12, 0.55 - ball.h * 0.07));
    s.style.transform = `translate3d(${bx}px, ${by}px, 0) translate(-50%, -50%) scale(${(1 + ball.h * 0.14).toFixed(3)})`;

    // motion trail for fast balls
    trail.unshift({ x: ball.p.x, y: ball.p.y, lift, fast: ball.speed > 14 && ball.mode === 'flight' });
    trail.length = Math.min(trail.length, 6);
    const dots = $('#ball-trail').children;
    for (let i = 0; i < dots.length; i++) {
      const t = trail[i + 1];
      const d = dots[i];
      if (!t || !t.fast || skipping) { d.style.opacity = '0'; continue; }
      d.style.transform = `translate3d(${px(t.x)}px, ${(t.y * pxPerM - t.lift).toFixed(1)}px, 0) translate(-50%, -50%) scale(${1 - i * 0.15})`;
      d.style.opacity = String(0.35 - i * 0.07);
    }
  }

  function frame(now, gen) {
    if (gen !== rafGen) return;
    // rAF timestamps can be slightly earlier than performance.now() taken in start(): never go back in time
    const real = clamp((now - last) / 1000, 0, 0.05);
    last = now;
    const total = real * speed * TIME_SCALE;
    const n = Math.ceil(total / 0.04) || 1;
    for (let k = 0; k < n; k++) {
      const dt = total / n;
      simT += dt;
      plan();
      stepAgents(dt);
      stepRef(dt);
      stepBall(dt);
    }
    const due = timers.filter((t) => t.at <= simT && t.run === runId);
    timers = timers.filter((t) => t.at > simT);
    due.forEach((t) => t.resolve());
    draw();
    requestAnimationFrame((t) => frame(t, gen));
  }

  // ---------- helpers ----------
  const playerOf = (side, i) => teams[side].lineup[i].player;
  const gkKey = (side) => {
    const i = teams[side].lineup.findIndex((e, n) => e.slot.role === 'GK' && !agents[key(side, n)].off);
    return key(side, Math.max(0, i));
  };
  const holdBy = (k) => { ball.mode = 'held'; ball.holder = k; ball.alpha = 1; };
  const goalLineX = (side) => (side === 'home' ? W : 0);
  const goalY = (side, aimY) => {
    const y = 34 + (aimY - 50) * (3.66 / 12);
    return side === 'home' ? y : H - y;
  };
  // Sim coords (attacking team's depth/width 0..100) -> pitch meters for set-piece spots.
  const simToPitch = (side, x, y) => {
    const d = clamp(10 + x * 0.95, 15, 80);
    const xp = side === 'home' ? d : 100 - d;
    const yp = side === 'home' ? y : 100 - y;
    return { x: (xp / 100) * W, y: clamp((yp / 100) * H, 4, H - 4) };
  };

  function banner(text, side) {
    if (skipping) return;
    const el = $('#banner');
    el.textContent = text;
    el.className = 'banner is-on' + (side ? ' banner--' + side : '');
    setTimeout(() => { el.className = 'banner'; }, 1300 / speed);
  }

  // Referee holds the card up; the booked player's token flashes in the card colour.
  function showCard(kind, k) {
    if (skipping) return Promise.resolve();
    const o = agents[k];
    const card = ref.card; // lives inside the referee element, so it moves with him
    card.className = 'ref-card';
    void card.offsetWidth; // restart the animation
    card.className = 'ref-card is-on ref-card--' + kind;
    ref.el.classList.add('is-showing');
    o.el.classList.add('is-booked', 'is-booked--' + kind);
    // big centre overlay: the card itself + the call + the player's name
    const show = $('#card-show');
    show.className = 'card-show';
    void show.offsetWidth;
    show.className = 'card-show is-on card-show--' + kind;
    show.querySelector('b').textContent = kind === 'yellow' ? 'YELLOW CARD' : 'RED CARD';
    show.querySelector('small').textContent = `${o.side === 'home' ? teams.home.name : teams.away.name} · ${playerOf(o.side, o.i).ko}`;
    const run = runId;
    return new Promise((resolve) => setTimeout(() => {
      if (run !== runId) return;
      show.className = 'card-show';
      card.className = 'ref-card';
      ref.el.classList.remove('is-showing');
      o.el.classList.remove('is-booked', 'is-booked--yellow', 'is-booked--red');
      resolve();
    }, Math.max(1100, 1500 / speed)));
  }

  // Event minute as shown on the clock: 45+2, 90+4 in stoppage time.
  const mm = (ev) => (ev.plus ? `${ev.minute}+${ev.plus}` : String(ev.minute));

  function log(minute, text, side, strong) {
    const li = document.createElement('li');
    li.className = (side ? 'log--' + side : '') + (strong ? ' is-strong' : '');
    const m = document.createElement('time');
    m.textContent = minute + "'";
    const t = document.createElement('span');
    t.textContent = text;
    li.append(m, t);
    $('#log').prepend(li);
  }

  function setScore() {
    $('#sb-home').textContent = live.score.home;
    $('#sb-away').textContent = live.score.away;
    ['home', 'away'].forEach((side) => {
      const c = live.cards[side];
      const el = $(`#sb-${side}-cards`);
      el.innerHTML = '';
      for (let i = 0; i < c.yellow; i++) el.append(Object.assign(document.createElement('i'), { className: 'card-y' }));
      for (let i = 0; i < c.red; i++) el.append(Object.assign(document.createElement('i'), { className: 'card-r' }));
    });
  }

  function clearOverrides() {
    Object.values(agents).forEach((o) => {
      o.ov = null; o.run = null; o.spot = null;
      o.el.classList.remove('is-dive-l', 'is-dive-r', 'is-down', 'is-throw');
    });
  }

  function meetingPoint(r, prof, side) {
    let T = flightTime(dist(ball.p, r.p), prof);
    let A = { x: r.p.x + r.v.x * T * 0.7, y: r.p.y + r.v.y * T * 0.7 };
    if (prof.lead) A.x += dirOf(side) * prof.lead;
    A = inPitch(A, 2);
    T = flightTime(dist(ball.p, A), prof);
    return { A, T };
  }

  async function carry(k, side, sec, reach = 6) {
    const c = agents[k];
    if (ball.holder !== k) holdBy(k);
    c.run = inPitch({ x: c.p.x + dirOf(side) * rand(reach * 0.3, reach), y: c.p.y + rand(-3, 3) }, 3);
    await simWait(sec);
    c.run = null;
  }

  // Dead balls stay put: the taker must walk/run to the ball, however far away he was.
  // Waits (in sim time) until he is there; `minSec` keeps a short pause for set-up.
  async function arrive(o, spot, minSec, maxSec = 12) {
    let t = 0;
    while (t < maxSec && (t < minSec || dist(o.p, spot) > 0.9)) {
      if (skipping) break;
      await simWait(0.2);
      t += 0.2;
    }
    if (dist(o.p, spot) > 0.9) { o.p = { ...spot }; o.v = { x: 0, y: 0 }; } // skip mode / safety
  }
  // Short run-up, then the dead ball is struck from where it lies (never pulled to the feet).
  async function runUp(o, side) {
    const behind = { x: ball.p.x - dirOf(side) * 0.6, y: ball.p.y };
    o.ov = { t: behind, spd: 3 };
    await simWait(0.35);
  }

  // Put everyone in position for a dead ball. `crowd` sends players into the box.
  function setupSetPiece(sp) {
    live.setPiece = sp;
    const goalX = goalLineX(sp.side);
    const dir = dirOf(sp.side);
    const list = activeAgents().filter((o) => !o.off);
    list.forEach((o) => { o.spot = null; });
    if (sp.type === 'penalty') {
      list.forEach((o, n) => {
        if (o.role === 'GK') return;
        o.spot = { x: goalX - dir * (19 + (n % 3) * 2.5), y: 14 + ((n * 7) % 40) };
      });
      return;
    }
    if (sp.crowd) {
      const att = list.filter((o) => o.side === sp.side && o.role !== 'GK');
      const def = list.filter((o) => o.side !== sp.side && o.role !== 'GK');
      // two deepest attackers stay back
      const stay = att.slice().sort((a, b) => (a.p.x - b.p.x) * dir).slice(0, 2);
      att.forEach((o) => {
        if (stay.includes(o)) return;
        o.spot = { x: goalX - dir * rand(5, 14), y: 34 + rand(-11, 11) };
      });
      def.forEach((o, n) => {
        if (n === 0 && def.length > 6) return; // one stays up for the counter
        o.spot = { x: goalX - dir * rand(3, 12), y: 34 + rand(-10, 10) };
      });
    }
  }

  function buildWall(spot, side, n) {
    const goal = { x: goalLineX(side), y: 34 };
    const dx = goal.x - spot.x;
    const dy = goal.y - spot.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const c = { x: spot.x + ux * 9.15, y: spot.y + uy * 9.15 };
    const def = activeAgents()
      .filter((o) => o.side !== side && o.role !== 'GK' && !o.off)
      .sort((a, b) => dist(a.p, c) - dist(b.p, c))
      .slice(0, n);
    def.forEach((o, i) => {
      const off = (i - (n - 1) / 2) * 0.9;
      o.ov = { t: { x: c.x - uy * off, y: c.y + ux * off }, spd: 'sprint' };
    });
    return def;
  }

  // ---------- event playback ----------
  async function doPass(ev) {
    const S = ev.side;
    const fromK = key(S, ev.from);
    const toK = key(S, ev.to);
    const r = agents[toK];
    const prof = PASS[ev.kind] || PASS.short;
    live.possession = S;
    const setPiece = ev.kind === 'corner' || ev.kind === 'fkcross';
    const isGK = agents[fromK].role === 'GK';
    if (ev.kind === 'throw') { ball.h = 2.1; agents[fromK].el.classList.remove('is-throw'); agents[fromK].ov = null; }
    else if (!setPiece) await carry(fromK, S, isGK ? rand(0.6, 1.2) : rand(0.3, 1.1), isGK ? 2 : 6);
    else await runUp(agents[fromK], S);
    live.kickoff = false;

    // crosses are swung into the six-yard / penalty-spot area, cut-backs pulled back to the spot
    const flank = ev.kind === 'cross' || ev.kind === 'cutback';
    const { A } = setPiece
      ? { A: inPitch({ x: goalLineX(S) - dirOf(S) * rand(6, 11), y: 34 + rand(-7, 7) }) }
      : ev.kind === 'cross' ? { A: inPitch({ x: goalLineX(S) - dirOf(S) * rand(5, 12), y: 34 + rand(-8, 8) }) }
        : ev.kind === 'cutback' ? { A: inPitch({ x: goalLineX(S) - dirOf(S) * rand(10, 15), y: 34 + rand(-6, 6) }) }
          : meetingPoint(r, prof, S);
    r.ov = { t: A, spd: 'sprint' };
    if (flank && Math.random() < 0.6) log(mm(ev), `${playerOf(S, ev.from).short} ${ev.kind === 'cross' ? '크로스' : '컷백'} → ${playerOf(S, ev.to).short}`, S);
    const header = (ev.kind === 'cross' || setPiece) && ev.nextHeader;
    await kick(A, { ...prof, h1: header ? 1.9 : 0, then: { mode: header ? 'hover' : prof.air ? 'dead' : 'held', holder: toK } });
    if (setPiece) { live.setPiece = null; agents[fromK].ov = null; Object.values(agents).forEach((o) => { o.spot = null; }); }
    if (prof.air && !header) {
      const d = dist(ball.p, agents[fromK].p) || 1;
      const dir = { x: (A.x - agents[fromK].p.x) / d, y: (A.y - agents[fromK].p.y) / d };
      await bounceAndRoll(A, dir, toK);
    }
    r.ov = null;
  }

  async function doIntercept(ev, next) {
    const S = ev.side;
    const D = other(S);
    const fromK = key(S, ev.from);
    const toK = key(S, ev.to);
    const byK = key(D, ev.by);
    const prof = PASS[ev.kind] || PASS.short;
    const setPiece = ev.kind === 'corner' || ev.kind === 'fkcross';
    live.possession = S;
    if (ev.kind === 'throw') { ball.h = 2.1; agents[fromK].el.classList.remove('is-throw'); agents[fromK].ov = null; }
    else if (!setPiece) await carry(fromK, S, rand(0.3, 0.9));
    else await runUp(agents[fromK], S);
    live.kickoff = false;

    const r = agents[toK];
    const d = agents[byK];
    const { A } = setPiece
      ? { A: inPitch({ x: goalLineX(S) - dirOf(S) * rand(5, 10), y: 34 + rand(-6, 6) }) }
      : meetingPoint(r, prof, S);
    const P0 = { ...ball.p };
    const seg = { x: A.x - P0.x, y: A.y - P0.y };
    const L2 = seg.x * seg.x + seg.y * seg.y || 1;
    const u = clamp(((d.p.x - P0.x) * seg.x + (d.p.y - P0.y) * seg.y) / L2, 0.35, 0.92);
    const C = setPiece ? A : { x: P0.x + seg.x * u, y: P0.y + seg.y * u };
    r.ov = { t: A, spd: 'sprint' };
    d.ov = { t: C, spd: 'sprint', acc: 16 };
    const aerial = prof.air;
    const keeper = d.role === 'GK';
    await kick(C, { ...prof, arrive: 8, h1: aerial ? (keeper ? 2.2 : 1.8) : 0, then: { mode: keeper ? 'held' : 'dead', holder: byK } });
    if (setPiece) { live.setPiece = null; agents[fromK].ov = null; Object.values(agents).forEach((o) => { o.spot = null; }); }
    live.possession = D;
    if (ev.out) {
      // touched out over the sideline
      const out = { x: clamp(C.x + rand(-5, 5), 2, W - 2), y: C.y < H / 2 ? -1.2 : H + 1.2 };
      d.ov = null;
      await kick(out, aerial ? { air: true, T: 0.6, peakAbs: 1.5, h0: ball.h, h1: 0 } : { air: false, arrive: 4, dec: 4 });
      live.lastOut = { ...out };
      ball.alpha = 0;
      r.ov = null;
      return;
    }
    if (!keeper && next && next.type === 'corner' && next.side === S) {
      // cleared behind the byline: the engine gives a corner, so the ball really goes out
      const out = { x: goalLineX(S) + dirOf(S) * 1.5, y: next.top ? rand(6, 22) : H - rand(6, 22) };
      d.ov = null;
      await kick(out, aerial ? { air: true, T: 0.55, peakAbs: 2.4, h0: ball.h, h1: 0.4 } : { air: false, arrive: 6, dec: 3 });
      ball.alpha = 0;
      if (Math.random() < 0.5) log(mm(ev), `${playerOf(D, ev.by).short} ${aerial ? '헤딩' : '태클'}으로 걷어냄 — 코너킥`, D);
      r.ov = null;
      return;
    }
    if (aerial && !keeper && !skipping) {
      // headed clear, bounces, then controlled
      const away = inPitch({ x: C.x - dirOf(S) * rand(8, 16), y: C.y + rand(-6, 6) });
      d.ov = { t: away, spd: 'sprint' };
      await kick(away, { air: true, T: 0.7, peakAbs: 2.2, h0: 1.8, h1: 0, then: { mode: 'dead' } });
      const dd = dist(away, C) || 1;
      await bounceAndRoll(away, { x: (away.x - C.x) / dd, y: (away.y - C.y) / dd }, byK);
    } else if (!keeper) holdBy(byK);
    r.ov = null;
    d.ov = null;
    if (Math.random() < 0.25 || setPiece) {
      const what = keeper ? '공중볼 캐치' : aerial ? '헤딩 클리어' : '가로채기';
      log(mm(ev), `${playerOf(D, ev.by).short} ${what}`, D);
    }
  }

  // Engine depth (0..100, x >= 70 = in the box) -> distance up the pitch, as a fraction of W.
  const shotDepth = (x) => (x >= 70 ? Math.min(0.95, 0.83 + (x - 70) * 0.006) : 0.55 + (x - 50) * 0.014);
  // Carries the ball up to where the engine took the shot from, if the shooter is short of it.
  async function toShotSpot(k, S, ev) {
    if (ev.x == null || skipping) return;
    const c = agents[k];
    if (ball.holder !== k) holdBy(k);
    const fx = shotDepth(ev.x) * W;
    const want = inPitch({
      x: S === 'home' ? fx : W - fx,
      y: ev.x >= 70 ? clamp(c.p.y, H / 2 - 13, H / 2 + 13) : c.p.y,
    }, 3);
    if ((want.x - c.p.x) * dirOf(S) < 2) return;
    c.ov = { t: want, spd: 'sprint' };
    for (let t = 0; t < 1.8 && dist(c.p, want) > 2 && !skipping; t += 0.15) await simWait(0.15);
    c.ov = null;
  }

  async function doShot(ev, next) {
    const S = ev.side;
    const shK = key(S, ev.from);
    const gkK = ev.keeper !== undefined ? key(other(S), ev.keeper) : gkKey(other(S));
    const gk = agents[gkK];
    live.possession = S;

    if (ev.kind === 'header') {
      ball.mode = 'hover'; ball.holder = shK; ball.h = 1.9;
      await simWait(0.15);
    } else if (ev.kind === 'penalty' || ev.kind === 'freekick') {
      // struck from the spot after a run-up; the wall jumps as the ball goes
      await runUp(agents[shK], S);
      agents[shK].ov = null;
      const wall = live.wall || [];
      live.wall = null;
      const endJump = () => wall.forEach((o) => { o.el.classList.remove('is-jump'); o.ov = null; });
      if (skipping) endJump();
      else {
        wall.forEach((o) => o.el.classList.add('is-jump'));
        setTimeout(endJump, 700 / speed);
      }
    } else {
      await toShotSpot(shK, S, ev);
      await carry(shK, S, ev.kind === 'long' ? rand(0.4, 0.8) : rand(0.2, 0.5), 3);
    }

    const lineX = goalLineX(S);
    const gy = goalY(S, ev.aimY);
    const target = { x: lineX, y: gy };
    const D = dist(ball.p, target);
    let opts;
    if (ev.kind === 'header') opts = { air: true, T: D / 14, h0: 1.9, h1: rand(0.2, 1.2), peakAbs: 0.2 };
    else if (ev.kind === 'long') opts = { air: true, T: D / 27, h0: 0, h1: rand(0.5, 2.2), peakAbs: rand(1.2, 3) };
    else if (ev.kind === 'freekick') opts = { air: true, T: D / 22, h0: 0, h1: rand(0.6, 2.1), peakAbs: rand(2.6, 3.4) }; // up and over the wall
    else if (ev.kind === 'penalty') opts = { air: true, T: D / 25, h0: 0, h1: rand(0, 1.8), peakAbs: rand(0, 0.4) };
    else opts = { air: true, T: D / 24, h0: 0, h1: rand(0, 1.6), peakAbs: rand(0, 0.8) };
    if (ev.type === 'miss' && ev.over) opts.h1 = rand(2.7, 4.2);
    if (ball.holder) ball.holder = null;

    const reach = ev.type === 'save' ? 1 : ev.type === 'goal' ? rand(0.4, 0.75) : 0.3;
    const diveY = gk.p.y + (gy - gk.p.y) * reach;
    const run = runId;
    if (!skipping) {
      setTimeout(() => {
        if (run !== runId || skipping) return;
        gk.ov = { t: { x: lineX - dirOf(S) * 1.2, y: diveY }, spd: 10, acc: 40 };
        if (Math.abs(gy - gk.p.y) > 1.2 && ev.type !== 'miss') gk.el.classList.add(gy > gk.p.y ? 'is-dive-r' : 'is-dive-l');
      }, 120 / speed);
    }

    if (ev.type === 'save') {
      const hands = { x: lineX - dirOf(S) * 1.2, y: diveY };
      await kick(hands, { ...opts, h1: rand(0.3, 1.6), then: { mode: ev.caught ? 'held' : 'dead', holder: gkK } });
      if (!ev.caught && !skipping) {
        // parried: either out for a corner, or loose and gathered
        const toCorner = !!(next && next.type === 'corner');
        const loose = toCorner
          ? { x: lineX + dirOf(S) * 2, y: hands.y < H / 2 ? rand(18, 26) : rand(42, 50) }
          : inPitch({ x: lineX - dirOf(S) * rand(4, 8), y: hands.y + (Math.random() < 0.5 ? -1 : 1) * rand(4, 9) }, 2);
        await kick(loose, { air: true, T: 0.5, peakAbs: 1.2, h1: 0, then: { mode: 'dead' } });
        gk.el.classList.remove('is-dive-l', 'is-dive-r');
        if (!toCorner) {
          gk.ov = { t: loose, spd: 'sprint' };
          await simWait(0.9);
          holdBy(gkK);
        } else ball.alpha = 0;
      } else holdBy(gkK);
    } else if (ev.type === 'goal') {
      await kick(target, { ...opts, then: { mode: 'dead' } });
      const net = { x: lineX + dirOf(S) * 1.5, y: gy + rand(-0.6, 0.6) };
      await kick(net, { air: true, T: 0.16, h0: ball.h, h1: Math.max(0.2, ball.h * 0.5), peakAbs: 0, then: { mode: 'dead' }, silent: true });
    } else {
      // wide, over, or deflected behind
      const out = ev.deflected
        ? { x: lineX + dirOf(S) * 2, y: gy < 34 ? rand(12, 24) : rand(44, 56) }
        : { x: lineX + dirOf(S) * 3, y: gy };
      await kick(out, { ...opts, T: opts.T * 1.15, then: { mode: 'dead' } });
      ball.alpha = 0;
    }
    gk.ov = null;
    gk.el.classList.remove('is-dive-l', 'is-dive-r');
    live.setPiece = null;
    Object.values(agents).forEach((o) => { o.spot = null; });
  }

  // Where the foul happens on the pitch. It has to agree with what the engine awards next:
  // a penalty must be inside the box, a direct free kick in shooting range, an ordinary
  // free kick outside the box. The free kick / penalty is then taken from this exact spot.
  function foulSpot(attSide, p, next) {
    const goalX = goalLineX(attSide);
    const dir = dirOf(attSide);
    const dx = Math.abs(goalX - p.x);
    const inBox = dx < 16.5 && Math.abs(p.y - 34) < 20;
    if (next && next.type === 'penalty') return { x: goalX - dir * clamp(dx, 5, 15), y: clamp(p.y, 17, 51) };
    if (next && next.type === 'freekick' && next.direct) return { x: goalX - dir * clamp(dx, 18, 30), y: clamp(p.y, 21, 47) };
    if (inBox) return { x: goalX - dir * 17.5, y: p.y };
    return inPitch(p, 2);
  }

  async function doFoul(ev, next) {
    const foulK = key(ev.side, ev.by);
    const vicK = key(ev.victimSide, ev.on);
    const f = agents[foulK];
    const v = agents[vicK];
    const spot = foulSpot(ev.victimSide, v.p, next);
    live.foulSpot = spot;
    // if the decision needs a different place (e.g. into the box), the victim carries the ball there first
    if (dist(v.p, spot) > 2.5 && !skipping) {
      holdBy(vicK);
      v.ov = { t: spot, spd: 'sprint' };
      await arrive(v, spot, 0, 2.5);
    }
    v.p = { ...spot };
    // the challenge
    f.ov = { t: { ...v.p }, spd: 'sprint', acc: 20 };
    await simWait(0.35);
    v.el.classList.add('is-down');
    v.ov = { t: { ...v.p }, spd: 0.5 };
    f.ov = { t: { x: f.p.x - dirOf(ev.victimSide) * 1, y: f.p.y }, spd: 2 };
    ball.mode = 'dead';
    ball.holder = null;
    banner('FOUL');
    Sound.whistle('short');
    const sp = playerOf(ev.side, ev.by).short;
    if (ev.card) {
      // referee runs in, stops beside the player, card goes up
      ref.ov = inPitch({ x: f.p.x - dirOf(ev.side) * 2.2, y: f.p.y + (f.p.y < H / 2 ? 2.2 : -2.2) }, 1);
      await simWait(1.4);
      const red = ev.card === 'red' || ev.card === 'second-yellow';
      const c = live.cards[ev.side];
      if (ev.card !== 'red') {
        c.yellow++;
        setScore();
        await showCard('yellow', foulK);
      }
      if (red) {
        c.red++;
        setScore();
        await showCard('red', foulK);
      }
      ref.ov = null;
      const label = ev.card === 'yellow' ? '🟨 경고' : ev.card === 'second-yellow' ? '🟨🟥 경고 누적 퇴장' : '🟥 퇴장';
      log(mm(ev), `${sp} ${label} (반칙 — ${playerOf(ev.victimSide, ev.on).short})`, ev.side, red);
      if (red) {
        f.off = true;
        f.ov = null;
        f.el.classList.add('is-off-pitch');
      }
    } else if (Math.random() < 0.35) {
      log(mm(ev), `${sp} 반칙`, ev.side);
    }
    await simWait(0.9);
    v.el.classList.remove('is-down');
    v.ov = null;
    if (!f.off) f.ov = null;
  }

  async function doFreekick(ev) {
    const k = key(ev.side, ev.holder);
    // taken where the foul was (doFoul), not from the engine's rough zone
    const spot = live.foulSpot ? { ...live.foulSpot } : simToPitch(ev.side, ev.x, ev.y);
    live.foulSpot = null;
    Object.assign(ball, { p: { ...spot }, h: 0, mode: 'dead', holder: null, alpha: 1, dest: null });
    const t = agents[k];
    t.ov = { t: { x: spot.x - dirOf(ev.side) * 1.2, y: spot.y }, spd: 'sprint' };
    setupSetPiece({ type: 'freekick', side: ev.side, crowd: ev.direct || ev.x >= 55 });
    let wall = [];
    if (ev.direct) wall = buildWall(spot, ev.side, 4);
    const gk = agents[gkKey(other(ev.side))];
    gk.ov = { t: { x: goalLineX(ev.side) - dirOf(ev.side) * 1.2, y: 34 + (spot.y < 34 ? 1.5 : -1.5) }, spd: 4 };
    const dangerous = ev.direct || ev.x >= 55;
    if (dangerous) log(mm(ev), `${teams[ev.side].name} ${ev.direct ? '직접 프리킥' : '프리킥'} — ${playerOf(ev.side, ev.holder).short}`, ev.side);
    await arrive(t, t.ov.t, dangerous ? 2.2 : 0.8);
    gk.ov = null;
    if (!ev.direct && ev.x < 55) {
      // taken short: play on from the taker's feet
      t.ov = null;
      holdBy(k);
      live.setPiece = null;
      Object.values(agents).forEach((o) => { o.spot = null; });
    }
    live.wall = wall; // jumps when the shot is struck (doShot)
  }

  async function doPenalty(ev) {
    const k = key(ev.side, ev.holder);
    const spot = { x: goalLineX(ev.side) - dirOf(ev.side) * 11, y: 34 };
    live.foulSpot = null;
    Object.assign(ball, { p: { ...spot }, h: 0, mode: 'dead', holder: null, alpha: 1, dest: null });
    setupSetPiece({ type: 'penalty', side: ev.side });
    const t = agents[k];
    t.ov = { t: { x: spot.x - dirOf(ev.side) * 2.5, y: 34.5 }, spd: 'sprint' };
    const gk = agents[gkKey(other(ev.side))];
    gk.ov = { t: { x: goalLineX(ev.side) - dirOf(ev.side) * 0.6, y: 34 }, spd: 4 };
    banner('PENALTY!', ev.side);
    Sound.whistle('short');
    log(mm(ev), `페널티킥 선언 — 키커 ${playerOf(ev.side, ev.holder).short}`, ev.side, true);
    await arrive(t, t.ov.t, 2.6);
    gk.ov = null;
    // taker stays behind the ball; doShot does the run-up
    live.setPiece = null;
    Object.values(agents).forEach((o) => { o.spot = null; });
  }

  async function doCorner(ev) {
    const k = key(ev.side, ev.holder);
    const lineX = goalLineX(ev.side);
    const spot = { x: lineX - dirOf(ev.side) * 0.5, y: ev.top ? 0.6 : H - 0.6 };
    Object.assign(ball, { p: { ...spot }, h: 0, mode: 'dead', holder: null, alpha: 1, dest: null });
    setupSetPiece({ type: 'corner', side: ev.side, crowd: true });
    const t = agents[k];
    t.ov = { t: { x: spot.x - dirOf(ev.side) * 0.8, y: spot.y + (ev.top ? 0.8 : -0.8) }, spd: 'sprint' };
    const gk = agents[gkKey(other(ev.side))];
    gk.ov = { t: { x: lineX - dirOf(ev.side) * 1.5, y: 34 + (ev.top ? -1.5 : 1.5) }, spd: 4 };
    log(mm(ev), `${teams[ev.side].name} 코너킥 — ${playerOf(ev.side, ev.holder).short}`, ev.side);
    await arrive(t, t.ov.t, 2.4);
    gk.ov = null;
    // the taker keeps his override: he stays at the flag until the ball is delivered
  }

  // Ball went out over the touchline: the taker fetches it and holds it overhead.
  async function doThrowin(ev) {
    const k = key(ev.side, ev.holder);
    const t = agents[k];
    const top = live.lastOut ? live.lastOut.y < H / 2 : (ev.side === 'home' ? ev.y < 50 : ev.y >= 50);
    const x = live.lastOut ? clamp(live.lastOut.x, 3, W - 3) : simToPitch(ev.side, ev.x, 50).x;
    const spot = { x, y: top ? 0.2 : H - 0.2 };
    live.lastOut = null;
    live.possession = ev.side;
    Object.assign(ball, { p: { ...spot }, h: 0, mode: 'dead', holder: null, alpha: 0, dest: null });
    t.ov = { t: { x, y: top ? 0.6 : H - 0.6 }, spd: 'sprint' };
    if (Math.random() < 0.4) log(mm(ev), `${teams[ev.side].name} 스로인 — ${playerOf(ev.side, ev.holder).short}`, ev.side);
    await arrive(t, t.ov.t, 1.2);
    ball.p = { x: t.p.x, y: t.p.y };
    ball.alpha = 1;
    ball.mode = 'hover';
    ball.holder = k;
    ball.h = 2.1;
    t.el.classList.add('is-throw');
    await simWait(0.7);
    // stays on the line until the throw is taken (doPass / doIntercept release him)
  }

  // Dribble: the carrier runs at a defender with the ball. Won: a sidestep past him
  // (the defender is left on the floor). Lost: the defender pokes it away.
  async function doDribble(ev) {
    const S = ev.side;
    const D = other(S);
    const ck = key(S, ev.from);
    const dk = key(D, ev.by);
    const c = agents[ck];
    const d = agents[dk];
    live.possession = S;
    live.kickoff = false;
    if (ball.holder !== ck || ball.mode !== 'held') holdBy(ck);
    const dir = dirOf(S);
    const meet = inPitch({ x: c.p.x + dir * 5, y: c.p.y + rand(-1, 1) }, 3);
    c.ov = { t: meet, spd: 'sprint' };
    d.ov = { t: lerpP(d.p, meet, 0.85), spd: 'sprint', acc: 16 };
    await simWait(0.65);
    if (ev.ok && ev.wing) {
      // knocks it past the full-back and races down the touchline
      const line = c.p.y < H / 2 ? rand(3, 6) : H - rand(3, 6);
      const past = inPitch({ x: c.p.x + dir * rand(13, 19), y: line }, 2);
      c.ov = { t: past, spd: 'sprint', acc: 18 };
      d.ov = { t: lerpP(d.p, past, 0.5), spd: 'sprint' };
      if (Math.random() < 0.6) log(mm(ev), `${playerOf(S, ev.from).short} 측면 돌파 — ${playerOf(D, ev.by).short} 따돌림`, S);
      await simWait(1.3);
      d.ov = null;
      c.ov = null;
    } else if (ev.ok) {
      const swerve = (c.p.y < H / 2 ? 1 : -1) * rand(2.5, 4.5);
      const past = inPitch({ x: c.p.x + dir * rand(7, 11), y: c.p.y + swerve }, 3);
      c.ov = { t: past, spd: 'sprint', acc: 18 };
      d.ov = { t: { x: d.p.x, y: d.p.y - swerve * 0.3 }, spd: 2 };
      d.el.classList.add('is-down');
      if (Math.random() < 0.45 || playerOf(S, ev.from).dri >= 88) log(mm(ev), `${playerOf(S, ev.from).short} 드리블 돌파 — ${playerOf(D, ev.by).short} 제침`, S);
      await simWait(1.0);
      d.el.classList.remove('is-down');
      d.ov = null;
      c.ov = null;
    } else {
      d.ov = { t: { ...c.p }, spd: 'sprint', acc: 22 };
      await simWait(0.25);
      c.ov = null;
      d.ov = null;
      holdBy(dk);
      live.possession = D;
      if (Math.random() < 0.4) log(mm(ev), `${playerOf(D, ev.by).short} 태클로 공 탈취`, D);
      await simWait(0.3);
    }
  }

  // Substitution: the tired player jogs off, the token turns into the new player.
  async function doSub(ev) {
    const o = agents[key(ev.side, ev.i)];
    const outP = PLAYER_BY_ID[ev.out];
    const inP = PLAYER_BY_ID[ev.in];
    teams[ev.side].lineup[ev.i] = { ...teams[ev.side].lineup[ev.i], player: inP };
    log(mm(ev), `🔁 교체 ${inP.short} IN · ${outP.short} OUT`, ev.side);
    if (!skipping) {
      banner(`SUB · ${inP.short}`, ev.side);
      o.el.classList.add('is-sub');
      await simWait(0.9);
    }
    o.el.querySelector('.photo').outerHTML = Photos.html(inP);
    o.el.querySelector('em').textContent = inP.short;
    setPace(o, inP);
    o.since = live.minute;
    o.el.classList.remove('is-sub');
    if (!skipping) await simWait(0.6);
  }

  async function step(ev, next) {
    if (ev.minute !== undefined) {
      $('#clock').textContent = mm(ev) + "'";
      live.minute = ev.minute + (ev.plus || 0);
    }
    const name = (side, i) => playerOf(side, i).short;

    switch (ev.type) {
      case 'kickoff': {
        clearOverrides();
        live.celebrate = null;
        live.setPiece = null;
        live.kickoff = true;
        live.possession = ev.side;
        Object.assign(ball, { p: { x: W / 2, y: H / 2 }, h: 0, mode: 'dead', holder: null, fl: null, alpha: 1, dest: null });
        const k = key(ev.side, ev.holder);
        agents[k].ov = { t: { x: W / 2 - dirOf(ev.side) * 0.7, y: H / 2 }, spd: 5 };
        if (ev.minute === 0 && result.referee) log(0, `주심 ${result.referee.name} — ${refStyle(result.referee.strict)}`, null);
        if (ev.minute === 0 || ev.minute === 45) {
          log(mm(ev), `${teams[ev.side].name} 킥오프`, ev.side);
          Sound.whistle('short');
        }
        await simWait(ev.minute === 0 ? 1.2 : 3.2);
        agents[k].ov = null;
        holdBy(k);
        return simWait(0.3);
      }
      case 'goalkick': {
        const k = key(ev.side, ev.holder);
        const g = agents[k];
        live.possession = ev.side;
        live.setPiece = null;
        const spot = { x: ev.side === 'home' ? 5.5 : W - 5.5, y: H / 2 + rand(-6, 6) };
        g.ov = { t: spot, spd: 4 };
        if (Math.random() < 0.5) log(mm(ev), `${teams[ev.side].name} 골킥 — ${playerOf(ev.side, ev.holder).short}`, ev.side);
        Object.assign(ball, { p: { ...spot }, h: 0, mode: 'dead', holder: null, alpha: 0 });
        await simWait(1.2);
        ball.alpha = 1;
        g.ov = null;
        holdBy(k);
        return simWait(0.6);
      }
      case 'gkball':
        live.possession = ev.side;
        holdBy(key(ev.side, ev.holder));
        return simWait(0.9);
      case 'pass':
        return doPass({ ...ev, nextHeader: next && next.kind === 'header' && next.side === ev.side });
      case 'intercept':
        return doIntercept(ev, next);
      case 'foul':
        return doFoul(ev, next);
      case 'freekick':
        return doFreekick(ev);
      case 'penalty':
        return doPenalty(ev);
      case 'corner':
        return doCorner(ev);
      case 'throwin':
        return doThrowin(ev);
      case 'added': {
        // fourth official's board
        const el = $('#added');
        el.textContent = `+${ev.extra}`;
        el.hidden = false;
        log(mm(ev), `추가 시간 ${ev.extra}분`, null);
        banner(`+${ev.extra}'`);
        return simWait(1.2);
      }
      case 'sub':
        return doSub(ev);
      case 'dribble':
        return doDribble(ev);
      case 'goal': {
        await doShot(ev);
        live.score = { ...ev.score };
        setScore();
        const how = ev.kind === 'shot' ? '' : SHOT_KO[ev.kind];
        const assist = ev.assist !== null && ev.assist !== undefined ? `도움 ${name(ev.side, ev.assist)}` : '';
        const extra = [how, assist].filter(Boolean).join(', ');
        log(mm(ev), `⚽ 골! ${playerOf(ev.side, ev.from).ko}${extra ? ` (${extra})` : ''}`, ev.side, true);
        const head = { header: 'HEADER! ', long: 'WHAT A STRIKE! ', freekick: 'FREE KICK! ', penalty: 'PENALTY GOAL — ' }[ev.kind] || 'GOAL — ';
        banner(head + name(ev.side, ev.from), ev.side);
        Sound.roar();
        const pitch = $('#pitch');
        pitch.classList.add('is-goal', ev.side === 'home' ? 'net-r' : 'net-l');
        const gy = goalY(ev.side, ev.aimY);
        live.setPiece = null;
        live.celebrate = {
          side: ev.side,
          scorer: key(ev.side, ev.from),
          corner: { x: ev.side === 'home' ? W - 3 : 3, y: gy < H / 2 ? 3 : H - 3 },
        };
        await simWait(3.5);
        pitch.classList.remove('is-goal', 'net-r', 'net-l');
        return undefined;
      }
      case 'save':
        await doShot(ev, next);
        log(mm(ev), `${name(ev.side, ev.from)}의 ${SHOT_KO[ev.kind]} — ${name(other(ev.side), ev.keeper)} ${ev.caught ? '캐치' : '선방'}`, ev.side);
        banner('SAVE!');
        Sound.ooh();
        return simWait(0.6);
      case 'miss':
        await doShot(ev);
        if (!ev.deflected) Sound.ooh();
        log(mm(ev), `${name(ev.side, ev.from)}의 ${SHOT_KO[ev.kind]}${ev.deflected ? '이 수비 맞고 굴절' : ev.over ? '이 크로스바 위로' : '이 빗나감'}`, ev.side);
        return simWait(0.6);
      case 'half':
        clearOverrides();
        live.setPiece = null;
        live.kickoff = true;
        ball.mode = 'dead'; ball.holder = null;
        $('#added').hidden = true;
        Sound.whistle('half');
        log(45, `하프타임 ${live.score.home} : ${live.score.away}`, null, true);
        banner('HALF TIME');
        return simWait(2.5);
      case 'end':
        clearOverrides();
        ball.mode = 'dead'; ball.holder = null;
        $('#added').hidden = true;
        Sound.whistle('end');
        Sound.crowdStop();
        log(mm(ev), `경기 종료 ${ev.score.home} : ${ev.score.away}`, null, true);
        return simWait(1);
      default:
        return undefined;
    }
  }

  async function play(id) {
    const evs = result.events;
    for (let n = 0; n < evs.length; n++) {
      if (id !== runId) return;
      try {
        await step(evs[n], evs[n + 1]);
      } catch (err) {
        // never leave the user stuck mid-match: jump to the final whistle
        console.error('playback error at event', n, evs[n], err);
        skipping = true;
      }
    }
    if (id === runId) showResult();
  }

  // ---------- result ----------
  function showResult() {
    // settle the pitch behind the overlay and stop the animation loop (saves battery on tablets)
    clearOverrides();
    live.celebrate = null;
    Object.assign(ball, { mode: 'dead', holder: null, fl: null, alpha: 1, h: 0 });
    draw();
    rafGen++;
    const { stats, events } = result;
    const totalPasses = stats.home.passes + stats.away.passes || 1;
    const goals = events.filter((e) => e.type === 'goal');
    const tag = { header: ' (헤딩)', long: ' (중거리)', freekick: ' (프리킥)', penalty: ' (PK)' };
    const scorers = (side) => goals.filter((g) => g.side === side)
      .map((g) => `${PLAYER_BY_ID[g.pid].short} ${mm(g)}'${tag[g.kind] || ''}`)
      .join(', ') || '—';

    const mk = (tg, cls, text) => { const el = document.createElement(tg); el.className = cls; el.textContent = text; return el; };
    const score = $('#res-score');
    score.innerHTML = '';
    score.append(
      mk('span', 'rs__name rs__name--home', teams.home.name),
      mk('b', 'rs__num', `${result.score.home} : ${result.score.away}`),
      mk('span', 'rs__name rs__name--away', teams.away.name),
    );
    const sc = $('#res-scorers');
    sc.innerHTML = '';
    sc.append(mk('p', 'log--home', scorers('home')), mk('p', 'log--away', scorers('away')));
    sc.hidden = goals.length === 0;

    const pct = (a, b) => Math.round((a / (b || 1)) * 100) + '%';
    const h = stats.home;
    const a = stats.away;
    const rows = [
      ['점유율', pct(h.passes, totalPasses), pct(a.passes, totalPasses)],
      ['슈팅 (유효)', `${h.shots} (${h.onTarget})`, `${a.shots} (${a.onTarget})`],
      ['패스 성공률', pct(h.completed, h.passes), pct(a.completed, a.passes)],
      ['드리블 (성공)', `${h.dribbles} (${h.dribblesWon})`, `${a.dribbles} (${a.dribblesWon})`],
      ['코너킥', h.corners, a.corners],
      ['프리킥 / PK', `${h.freekicks} / ${h.penalties}`, `${a.freekicks} / ${a.penalties}`],
      ['파울', h.fouls, a.fouls],
      ['경고 / 퇴장', `${h.yellows} / ${h.reds}`, `${a.yellows} / ${a.reds}`],
    ];
    if (result.referee) rows.push(['주심', result.referee.name, refStyle(result.referee.strict)]);
    const table = $('#res-stats');
    table.innerHTML = '';
    rows.forEach(([label, hv, av]) => {
      const tr = document.createElement('tr');
      tr.append(mk('td', 'h', String(hv)), mk('th', '', label), mk('td', 'a', String(av)));
      table.append(tr);
    });
    renderRatings(mk);
    showTab('stats');
    $('#result').hidden = false;
    $('#rematch').focus({ preventScroll: true });
  }

  // How card-happy the referee is (engine strictness 0.55 .. 1.5).
  function refStyle(st) {
    if (st >= 1.2) return '엄격한 판정 (카드 많음)';
    if (st <= 0.8) return '관대한 판정 (카드 적음)';
    return '보통 판정';
  }

  // Man of the match + per-player ratings (home | away), starters first, subs after.
  function renderRatings(mk) {
    const { players, mom } = result.ratings;
    const m = players.find((p) => p.id === mom);
    const momEl = $('#res-mom');
    momEl.innerHTML = '';
    if (m) {
      const pl = PLAYER_BY_ID[m.id];
      const facts = [m.goals && `${m.goals}골`, m.assists && `${m.assists}도움`, m.saves && `${m.saves}선방`].filter(Boolean).join(' · ');
      momEl.className = `result__mom result__mom--${m.side}`;
      momEl.innerHTML = Photos.html(pl, 'mom__photo');
      const body = mk('span', 'mom__body', '');
      body.append(mk('small', '', 'MAN OF THE MATCH'), mk('b', '', pl.ko), mk('i', '', `${teams[m.side].name}${facts ? ' · ' + facts : ''}`));
      momEl.append(body, mk('strong', 'mom__rating', m.r.toFixed(1)));
    }
    const wrap = $('#res-ratings');
    wrap.innerHTML = '';
    ['home', 'away'].forEach((side) => {
      const col = mk('div', `rt rt--${side}`, '');
      col.append(mk('h3', '', teams[side].name));
      const list = players.filter((p) => p.side === side)
        .sort((a, b) => (a.subIn != null) - (b.subIn != null) || b.r - a.r);
      list.forEach((p) => {
        const pl = PLAYER_BY_ID[p.id];
        const row = mk('div', 'rt__row' + (p.id === mom ? ' is-mom' : ''), '');
        const tags = [
          p.goals ? '⚽'.repeat(p.goals) : '',
          p.assists ? '🅰'.repeat(p.assists) : '',
          p.cards.includes('R') ? '🟥' : p.cards.includes('Y') ? '🟨' : '',
          p.subIn != null ? `↑${p.subIn}'` : '',
          p.subOut != null ? `↓${p.subOut}'` : '',
        ].join('');
        const r = mk('b', 'rt__r', p.r.toFixed(1));
        r.dataset.band = p.r >= 8 ? 'hi' : p.r >= 7 ? 'good' : p.r < 6 ? 'low' : 'mid';
        row.append(mk('span', 'rt__pos', pl.pos), mk('span', 'rt__name', pl.short), mk('span', 'rt__tags', tags), r);
        col.append(row);
      });
      wrap.append(col);
    });
  }
  function showTab(name) {
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.tab === name);
      b.setAttribute('aria-selected', String(b.dataset.tab === name));
    });
    $('#res-stats').hidden = name !== 'stats';
    $('#res-ratings').hidden = name !== 'ratings';
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- setup ----------
  function buildAgents() {
    const wrap = $('#tokens');
    wrap.innerHTML = '';
    Object.keys(agents).forEach((k) => delete agents[k]);
    ['home', 'away'].forEach((side) => {
      teams[side].lineup.forEach((entry, i) => {
        const el = document.createElement('div');
        el.className = `token token--${side}`;
        el.innerHTML = Photos.html(entry.player);
        const label = document.createElement('em');
        label.textContent = entry.player.short;
        el.append(label);
        wrap.append(el);
        const o = {
          key: key(side, i), el, side, i, slot: entry.slot, role: entry.slot.role,
          p: { x: 0, y: 0 }, v: { x: 0, y: 0 }, offs: { dx: 0, dy: 0 }, nextOff: rand(0.5, 3),
          goal: { x: 0, y: 0 }, max: 5, acc: 8, ov: null, run: null, spot: null, stride: rand(0, 6),
          off: false, gone: false, since: 0, hasBall: false,
        };
        setPace(o, entry.player);
        agents[o.key] = o;
      });
    });
    live.kickoff = true;
    Object.values(agents).forEach((o) => { o.p = shapeTarget(o); o.goal = { ...o.p }; });
  }

  let original = null;
  function start(home, away) {
    original = { home, away };
    // private copies: substitutions rewrite lineup entries during playback
    const copy = (t) => ({ ...t, lineup: t.lineup.map((e) => ({ ...e })) });
    teams = { home: copy(home), away: copy(away) };
    runId++;
    skipping = false;
    timers = [];
    const stamina = Options.get('stamina');
    result = Sim.simulate(home.lineup, away.lineup, (Math.random() * 2 ** 32) >>> 0,
      { home: home.tactic, away: away.tactic },
      { stamina, bench: { home: home.bench || [], away: away.bench || [] } });
    live.stamina = stamina;
    live.minute = 0;
    Sound.setEnabled(Options.get('sound'));
    syncMute();
    Sound.crowdStart();
    $('#added').hidden = true;
    Object.assign(live, {
      score: { home: 0, away: 0 }, possession: 'home', celebrate: null, kickoff: true, setPiece: null, lastOut: null,
      cards: { home: { yellow: 0, red: 0 }, away: { yellow: 0, red: 0 } },
    });
    Object.assign(ball, { p: { x: W / 2, y: H / 2 }, h: 0, mode: 'dead', holder: null, fl: null, alpha: 1, dest: null });

    document.body.classList.add('is-playing');
    $('#draft').hidden = true;
    $('#match').hidden = false;
    $('#result').hidden = true;
    $('#log').innerHTML = '';
    $('#sb-home-name').textContent = home.name;
    $('#sb-away-name').textContent = away.name;
    $('#clock').textContent = "0'";
    const tr = $('#ball-trail');
    tr.innerHTML = '';
    for (let i = 0; i < 4; i++) tr.append(Object.assign(document.createElement('i'), { className: 'trail-dot' }));
    setScore();
    buildAgents();
    const refEl = document.createElement('div');
    refEl.className = 'referee';
    refEl.innerHTML = '<span></span><em>주심</em><i class="ref-card"></i>';
    $('#tokens').append(refEl);
    Object.assign(ref, { el: refEl, card: refEl.querySelector('.ref-card'), p: { x: W / 2 - 6, y: H / 2 + 10 }, v: { x: 0, y: 0 }, ov: null });
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => { pxPerM = ($('#pitch').clientWidth || 1155) / W; });

    const gen = ++rafGen;
    last = performance.now();
    requestAnimationFrame((t) => frame(t, gen));
    play(runId);
  }

  function stop() {
    runId++;
    rafGen++;
    timers = [];
  }

  function leave() {
    stop();
    Sound.crowdStop();
    document.body.classList.remove('is-playing');
    $('#match').hidden = true;
    $('#draft').hidden = false;
    backCb();
  }

  window.addEventListener('resize', () => { pxPerM = ($('#pitch').clientWidth || 1155) / W; });
  document.querySelectorAll('[data-speed]').forEach((b) => {
    b.addEventListener('click', () => {
      speed = +b.dataset.speed;
      document.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('is-on', x === b));
    });
  });
  $('#skip').addEventListener('click', () => {
    skipping = true;
    timers.forEach((t) => t.resolve());
    timers = [];
    if (ball.fl) finishFlight();
  });
  $('#rematch').addEventListener('click', () => { Sound.unlock(); start(original.home, original.away); });

  function syncMute() {
    const on = Sound.isEnabled();
    const b = $('#mute');
    b.textContent = on ? '🔊' : '🔇';
    b.setAttribute('aria-pressed', String(!on));
    b.setAttribute('aria-label', on ? '사운드 끄기' : '사운드 켜기');
  }
  $('#mute').addEventListener('click', () => {
    const on = !Sound.isEnabled();
    Options.set('sound', on);
    Sound.setEnabled(on);
    if (on && $('#result').hidden) Sound.crowdStart();
    syncMute();
  });
  // the pitch can change size (rotation, split view): keep the meter -> px scale right
  if (window.ResizeObserver) new ResizeObserver(() => { pxPerM = ($('#pitch').clientWidth || 1155) / W; draw(); }).observe($('#pitch'));
  $('#back').addEventListener('click', leave);
  $('#exit').addEventListener('click', leave);

  window.Match = { start, onBack: (cb) => { backCb = cb; } };
})();
