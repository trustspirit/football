// Match screen: replays the event list produced by Sim.simulate on a pitch.
//
// Everything moves in pitch meters (105 x 68) on a requestAnimationFrame loop:
//  - Players are steering agents with a max speed and acceleration (jog / press / sprint),
//    separation so they don't overlap, and a team shape that follows the ball every frame.
//  - The ball is either held (dribbled: pushed ahead and caught up with), in flight
//    (ground pass with grass friction, or lofted with a height arc + shadow), or dead.
//  - Each event kind (short / through / long / switch / cross / punt, shot / long / header)
//    gets its own ball trajectory and player choreography.
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

  const SPEED = { jog: 5.5, press: 7.5, sprint: 8.8, gk: 4.5, walk: 2.5 };

  // How each pass kind travels.
  const PASS = {
    short: { air: false, arrive: 5 },
    through: { air: false, arrive: 7, lead: 9 },
    long: { air: true, peak: 0.11 },
    switch: { air: true, peak: 0.09 },
    cross: { air: true, peak: 0.08 },
    punt: { air: true, peak: 0.17 },
  };
  const SHOT_KO = { shot: '슛', long: '중거리 슛', header: '헤딩' };

  let teams = null;
  let result = null;
  let runId = 0;
  let speed = 1;
  let skipping = false;
  let backCb = () => {};
  const live = { possession: 'home', kickoff: false, celebrate: null, score: { home: 0, away: 0 } };

  const agents = {};
  const ball = { p: { x: W / 2, y: H / 2 }, h: 0, mode: 'dead', holder: null, fl: null, spin: 0, touch: 0, alpha: 1, dest: null };
  let simT = 0;
  let last = 0;
  let rafGen = 0;
  let pxPerM = 11;
  let timers = [];

  // ---------- time ----------
  function simWait(sec) {
    if (skipping) return Promise.resolve();
    return new Promise((resolve) => timers.push({ at: simT + sec, resolve }));
  }

  // ---------- team shape ----------
  // Formation slot + ball influence, in meters. Team coords: depth 0..100 toward the
  // opponent goal, width 0..100; away is mirrored.
  function shapeTarget(o) {
    const side = o.side;
    const inPoss = live.possession === side;
    const bx = (ball.p.x / W) * 100;
    const by = (ball.p.y / H) * 100;
    const bD = side === 'home' ? bx : 100 - bx;
    const bW = side === 'home' ? by : 100 - by;
    const s = o.slot;
    let d;
    let w;
    if (s.role === 'GK') {
      d = 2.5 + clamp((bD - 25) * 0.07, 0, 6);
      w = 50 + (bW - 50) * 0.3;
    } else {
      d = 8 + s.x * 0.6 + (bD - 50) * 0.45 + (inPoss ? 8 : -2);
      if (!inPoss && s.role === 'DEF') d = Math.min(d, Math.max(bD - 6, 8)); // hold a line behind the ball
      w = 50 + (s.y - 50) * (inPoss ? 1 : 0.78) + (bW - 50) * (inPoss ? 0.2 : 0.35);
      d += o.off.dx * (inPoss ? 1 : 0.4);
      w += o.off.dy;
    }
    if (live.kickoff) d = Math.min(d, 48);
    d = clamp(d, 1.5, 96);
    w = clamp(w, 4, 96);
    const xp = side === 'home' ? d : 100 - d;
    const yp = side === 'home' ? w : 100 - w;
    return { x: (xp / 100) * W, y: (yp / 100) * H };
  }

  // Decide every agent's target + speed for this frame.
  function plan() {
    const list = Object.values(agents);
    list.forEach((o) => {
      o.goal = shapeTarget(o);
      o.max = o.role === 'GK' ? SPEED.gk : SPEED.jog;
      o.acc = 8;
    });

    if (live.celebrate) {
      const { side, scorer, corner } = live.celebrate;
      const sc = agents[scorer];
      list.forEach((o) => {
        if (o.key === scorer) { o.goal = corner; o.max = SPEED.press; }
        else if (o.side === side && o.role !== 'GK') {
          const a = (o.i / 11) * Math.PI * 2;
          o.goal = inPitch({ x: sc.p.x + Math.cos(a) * 2.2, y: sc.p.y + Math.sin(a) * 2.2 });
          o.max = SPEED.press;
        } else o.max = SPEED.walk;
      });
      return;
    }

    // Pressing: nearest opponents close down the ball carrier / landing spot.
    const focus = ball.mode === 'held' && ball.holder ? ball.p : ball.dest;
    const attSide = ball.mode === 'held' && ball.holder ? agents[ball.holder].side : live.possession;
    if (focus && !live.kickoff) {
      const pressers = list
        .filter((o) => o.side !== attSide && o.role !== 'GK' && !o.ov)
        .sort((a, b) => dist(a.p, focus) - dist(b.p, focus));
      if (pressers[0]) {
        pressers[0].goal = inPitch({ x: focus.x + dirOf(attSide) * 1.6, y: focus.y });
        pressers[0].max = SPEED.press;
      }
      if (pressers[1]) {
        pressers[1].goal = lerpP(pressers[1].goal, focus, 0.45);
        pressers[1].max = SPEED.jog + 1;
      }
    }

    // The ball carrier dribbles toward his own run target.
    if (ball.mode === 'held' && ball.holder) {
      const c = agents[ball.holder];
      if (c.run) { c.goal = c.run; c.max = c.role === 'GK' ? SPEED.walk : SPEED.jog; }
    }

    // Choreographed overrides win (receivers, interceptors, keeper dives, kickoff).
    list.forEach((o) => {
      if (o.ov) { o.goal = o.ov.t; o.max = o.ov.spd; o.acc = o.ov.acc || 14; }
    });
  }

  // ---------- physics ----------
  function stepAgents(dt) {
    const list = Object.values(agents);
    list.forEach((o) => {
      const dx = o.goal.x - o.p.x;
      const dy = o.goal.y - o.p.y;
      const d = Math.hypot(dx, dy);
      const want = d < 0.05 ? 0 : o.max * Math.min(1, d / 3.5); // arrive: slow down near target
      let dvx = (d ? (dx / d) * want : 0) - o.v.x;
      let dvy = (d ? (dy / d) * want : 0) - o.v.y;
      const dv = Math.hypot(dvx, dvy);
      const maxDv = o.acc * dt;
      if (dv > maxDv) { dvx *= maxDv / dv; dvy *= maxDv / dv; }
      o.v.x += dvx;
      o.v.y += dvy;
    });
    // Separation: players keep a little personal space.
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a];
        const B = list[b];
        const dx = B.p.x - A.p.x;
        const dy = B.p.y - A.p.y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d < 2.2) {
          const push = ((2.2 - d) * 4 * dt) / d;
          A.v.x -= dx * push; A.v.y -= dy * push;
          B.v.x += dx * push; B.v.y += dy * push;
        }
      }
    }
    list.forEach((o) => {
      o.p.x = clamp(o.p.x + o.v.x * dt, 0.5, W - 0.5);
      o.p.y = clamp(o.p.y + o.v.y * dt, 0.5, H - 0.5);
      o.stride += Math.hypot(o.v.x, o.v.y) * dt * 2.4;
      if (simT > o.nextOff) {
        // a fresh little run every few seconds
        const att = live.possession === o.side && (o.role === 'FWD' || o.role === 'MID');
        o.off = { dx: rand(-3, 3) + (att ? rand(0, 6) : 0), dy: rand(-4, 4) };
        o.nextOff = simT + rand(1.5, 4);
      }
    });
  }

  function stepBall(dt) {
    const before = { ...ball.p };
    if (ball.mode === 'flight') {
      const f = ball.fl;
      f.t = Math.min(f.T, f.t + dt);
      const u = f.t / f.T;
      let s;
      if (f.air) s = f.D * u;
      else s = f.v0 * f.t - (f.dec * f.t * f.t) / 2; // grass friction
      ball.p = { x: f.from.x + f.ux * s, y: f.from.y + f.uy * s };
      ball.h = f.h0 * (1 - u) + f.h1 * u + 4 * f.peak * u * (1 - u);
      if (f.t >= f.T) finishFlight();
    } else if (ball.mode === 'held' && ball.holder) {
      const o = agents[ball.holder];
      const sp = Math.hypot(o.v.x, o.v.y);
      const hd = sp > 0.8 ? { x: o.v.x / sp, y: o.v.y / sp } : { x: dirOf(o.side), y: 0 };
      ball.touch += sp * dt * 0.9;
      const lead = 0.55 + (sp > 0.8 ? 0.9 * Math.abs(Math.sin(ball.touch)) : 0); // pushed ahead, caught up
      const want = { x: o.p.x + hd.x * lead, y: o.p.y + hd.y * lead + 0.4 };
      const k = 1 - Math.exp(-dt * 12);
      ball.p = lerpP(ball.p, want, k);
      ball.h += (0 - ball.h) * k;
    } else if (ball.mode === 'hover' && ball.holder) {
      // ball arriving at head height for a header
      const o = agents[ball.holder];
      ball.p = lerpP(ball.p, { x: o.p.x, y: o.p.y }, 1 - Math.exp(-dt * 10));
    }
    ball.spin += dist(before, ball.p) * 55;
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

  // Launch the ball. Ground: decelerates to `arrive` m/s. Air: straight line with a height arc.
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
    return new Promise((resolve) => {
      f.resolve = resolve;
      ball.fl = f;
      if (skipping) finishFlight();
    });
  }

  // ---------- rendering ----------
  function draw() {
    Object.values(agents).forEach((o) => {
      const sp = Math.hypot(o.v.x, o.v.y);
      const bob = Math.sin(o.stride) * Math.min(1, sp / 6) * 1.6;
      o.el.style.left = (o.p.x / W) * 100 + '%';
      o.el.style.top = (o.p.y / H) * 100 + '%';
      o.el.style.transform = `translate(-50%, -50%) translateY(${bob}px)`;
      o.el.classList.toggle('has-ball', ball.holder === o.key && ball.mode === 'held');
    });
    const b = $('#ball');
    const s = $('#ball-shadow');
    const lift = ball.h * pxPerM * 0.9;
    b.style.left = (ball.p.x / W) * 100 + '%';
    b.style.top = (ball.p.y / H) * 100 + '%';
    b.style.opacity = String(ball.alpha);
    b.style.transform = `translate(-50%, -50%) translateY(${-lift}px) scale(${1 + ball.h * 0.07}) rotate(${ball.spin}deg)`;
    s.style.left = b.style.left;
    s.style.top = b.style.top;
    s.style.opacity = String(ball.alpha * Math.max(0.12, 0.5 - ball.h * 0.06));
    s.style.transform = `translate(-50%, -50%) scale(${1 + ball.h * 0.12})`;
  }

  function frame(now, gen) {
    if (gen !== rafGen) return;
    const real = Math.min(0.05, (now - last) / 1000);
    last = now;
    // sub-step for stable steering at high playback speeds
    const total = real * speed * TIME_SCALE;
    const n = Math.ceil(total / 0.04) || 1;
    for (let k = 0; k < n; k++) {
      const dt = total / n;
      simT += dt;
      plan();
      stepAgents(dt);
      stepBall(dt);
    }
    const due = timers.filter((t) => t.at <= simT);
    timers = timers.filter((t) => t.at > simT);
    due.forEach((t) => t.resolve());
    draw();
    requestAnimationFrame((t) => frame(t, gen));
  }

  // ---------- helpers ----------
  const playerOf = (side, i) => teams[side].lineup[i].player;
  const gkIndex = (side) => Math.max(0, teams[side].lineup.findIndex((e) => e.slot.role === 'GK'));
  const holdBy = (k) => { ball.mode = 'held'; ball.holder = k; ball.alpha = 1; };
  const goalLineX = (side) => (side === 'home' ? W : 0);
  // aimY (38..62 = inside the posts) -> meters across the goal mouth
  const goalY = (side, aimY) => {
    const y = 34 + (aimY - 50) * (3.66 / 12);
    return side === 'home' ? y : H - y;
  };

  function banner(text, side) {
    if (skipping) return;
    const el = $('#banner');
    el.textContent = text;
    el.className = 'banner is-on' + (side ? ' banner--' + side : '');
    setTimeout(() => { el.className = 'banner'; }, 1300 / speed);
  }

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
  }

  function clearOverrides() {
    Object.values(agents).forEach((o) => { o.ov = null; o.run = null; o.el.classList.remove('is-dive-l', 'is-dive-r'); });
  }

  // Where the intended receiver will meet the ball.
  function meetingPoint(r, prof, side) {
    let T = flightTime(dist(ball.p, r.p), prof);
    let A = { x: r.p.x + r.v.x * T * 0.7, y: r.p.y + r.v.y * T * 0.7 };
    if (prof.lead) A.x += dirOf(side) * prof.lead;
    A = inPitch(A, 2);
    T = flightTime(dist(ball.p, A), prof);
    return { A, T };
  }

  // Carry the ball for a moment before the next action.
  async function carry(k, side, sec, reach = 6) {
    const c = agents[k];
    if (ball.holder !== k) holdBy(k);
    c.run = inPitch({ x: c.p.x + dirOf(side) * rand(reach * 0.3, reach), y: c.p.y + rand(-3, 3) }, 3);
    await simWait(sec);
    c.run = null;
  }

  // ---------- event playback ----------
  async function doPass(ev) {
    const S = ev.side;
    const fromK = key(S, ev.from);
    const toK = key(S, ev.to);
    const r = agents[toK];
    const prof = PASS[ev.kind] || PASS.short;
    live.possession = S;
    const isGK = agents[fromK].role === 'GK';
    await carry(fromK, S, isGK ? rand(0.6, 1.2) : rand(0.3, 1.1), isGK ? 2 : 6);
    live.kickoff = false;

    const { A } = meetingPoint(r, prof, S);
    r.ov = { t: A, spd: SPEED.sprint };
    const header = ev.kind === 'cross' && ev.nextHeader;
    await kick(A, { ...prof, h1: header ? 1.9 : 0, then: { mode: header ? 'hover' : 'held', holder: toK } });
    if (prof.air && !header && !skipping) {
      // the ball lands, bounces once and is brought under control
      const bounce = inPitch({ x: A.x + dirOf(S) * 0.8, y: A.y + rand(-0.6, 0.6) });
      await kick(bounce, { air: true, T: 0.32, peakAbs: 0.5, h0: 0, h1: 0, then: { mode: 'held', holder: toK } });
    }
    r.ov = null;
  }

  async function doIntercept(ev) {
    const S = ev.side;
    const D = other(S);
    const fromK = key(S, ev.from);
    const toK = key(S, ev.to);
    const byK = key(D, ev.by);
    const prof = PASS[ev.kind] || PASS.short;
    live.possession = S;
    await carry(fromK, S, rand(0.3, 0.9));
    live.kickoff = false;

    const r = agents[toK];
    const d = agents[byK];
    const { A } = meetingPoint(r, prof, S);
    // The defender reads it and steps into the lane.
    const P0 = { ...ball.p };
    const seg = { x: A.x - P0.x, y: A.y - P0.y };
    const L2 = seg.x * seg.x + seg.y * seg.y || 1;
    const u = clamp(((d.p.x - P0.x) * seg.x + (d.p.y - P0.y) * seg.y) / L2, 0.35, 0.92);
    const C = { x: P0.x + seg.x * u, y: P0.y + seg.y * u };
    r.ov = { t: A, spd: SPEED.sprint };
    d.ov = { t: C, spd: SPEED.sprint, acc: 16 };
    const aerial = prof.air;
    await kick(C, { ...prof, arrive: 8, h1: aerial ? 1.8 : 0, then: { mode: 'held', holder: byK } });
    live.possession = D;
    if (aerial && !skipping) {
      // won in the air: headed down, then controlled
      const drop = inPitch({ x: C.x - dirOf(S) * rand(2, 4), y: C.y + rand(-2, 2) });
      d.ov = { t: drop, spd: SPEED.press };
      await kick(drop, { air: true, T: 0.45, peakAbs: 0.6, h0: 1.8, h1: 0, then: { mode: 'held', holder: byK } });
    }
    r.ov = null;
    d.ov = null;
    if (Math.random() < 0.25) log(ev.minute, `${playerOf(D, ev.by).short} ${aerial ? '공중볼 경합 승리' : '가로채기'}`, D);
  }

  async function doShot(ev) {
    const S = ev.side;
    const shK = key(S, ev.from);
    const gkK = key(other(S), ev.keeper ?? gkIndex(other(S)));
    const gk = agents[gkK];
    live.possession = S;

    if (ev.kind === 'header') {
      // ball is already hovering at head height
      ball.mode = 'hover'; ball.holder = shK; ball.h = 1.9;
      await simWait(0.15);
    } else {
      await carry(shK, S, ev.kind === 'long' ? rand(0.4, 0.8) : rand(0.2, 0.5), 3);
    }

    const lineX = goalLineX(S);
    const gy = goalY(S, ev.aimY);
    const target = { x: lineX, y: gy };
    const D = dist(ball.p, target);
    let opts;
    if (ev.kind === 'header') opts = { air: true, T: D / 14, h0: 1.9, h1: rand(0.2, 1.2), peakAbs: 0.2 };
    else if (ev.kind === 'long') opts = { air: true, T: D / 27, h0: 0, h1: rand(0.5, 2.2), peakAbs: rand(1.2, 3) };
    else opts = { air: true, T: D / 24, h0: 0, h1: rand(0, 1.6), peakAbs: rand(0, 0.8) };
    if (ev.type === 'miss' && ev.over) opts.h1 = rand(2.7, 4.2);

    // Keeper reacts after a beat: full dive on a save, a step short on a goal.
    const reach = ev.type === 'save' ? 1 : ev.type === 'goal' ? rand(0.4, 0.75) : 0.3;
    const diveY = gk.p.y + (gy - gk.p.y) * reach;
    setTimeout(() => {
      gk.ov = { t: { x: lineX - dirOf(S) * 1.2, y: diveY }, spd: 10, acc: 40 };
      if (Math.abs(gy - gk.p.y) > 1.2 && ev.type !== 'miss') gk.el.classList.add(gy > gk.p.y ? 'is-dive-r' : 'is-dive-l');
    }, skipping ? 0 : 120 / speed);

    if (ev.type === 'save') {
      const hands = { x: lineX - dirOf(S) * 1.2, y: diveY };
      await kick(hands, { ...opts, h1: rand(0.3, 1.6), then: { mode: ev.caught ? 'held' : 'dead', holder: gkK } });
      if (!ev.caught && !skipping) {
        // parried away, then gathered
        const loose = inPitch({ x: lineX - dirOf(S) * rand(4, 8), y: hands.y + (Math.random() < 0.5 ? -1 : 1) * rand(4, 9) }, 2);
        await kick(loose, { air: true, T: 0.5, peakAbs: 1, h1: 0, then: { mode: 'dead' } });
        gk.el.classList.remove('is-dive-l', 'is-dive-r');
        gk.ov = { t: loose, spd: SPEED.sprint };
        await simWait(0.9);
      }
      holdBy(gkK);
    } else if (ev.type === 'goal') {
      await kick(target, { ...opts, then: { mode: 'dead' } });
      const net = { x: lineX + dirOf(S) * 1.5, y: gy + rand(-0.6, 0.6) };
      await kick(net, { air: true, T: 0.16, h0: ball.h, h1: Math.max(0.2, ball.h * 0.5), peakAbs: 0, then: { mode: 'dead' } });
    } else {
      // wide or over: out of play
      const out = { x: lineX + dirOf(S) * 3, y: gy };
      await kick(out, { ...opts, T: opts.T * 1.15, then: { mode: 'dead' } });
      ball.alpha = 0;
    }
    gk.ov = null;
    gk.el.classList.remove('is-dive-l', 'is-dive-r');
  }

  async function step(ev, next) {
    if (ev.minute !== undefined) $('#clock').textContent = ev.minute + "'";
    const name = (side, i) => playerOf(side, i).short;

    switch (ev.type) {
      case 'kickoff': {
        clearOverrides();
        live.celebrate = null;
        live.kickoff = true;
        live.possession = ev.side;
        Object.assign(ball, { p: { x: W / 2, y: H / 2 }, h: 0, mode: 'dead', holder: null, fl: null, alpha: 1, dest: null });
        const k = key(ev.side, ev.holder);
        agents[k].ov = { t: { x: W / 2 - dirOf(ev.side) * 0.7, y: H / 2 }, spd: SPEED.jog };
        if (ev.minute === 0 || ev.minute === 45) log(ev.minute, `${teams[ev.side].name} 킥오프`, ev.side);
        await simWait(ev.minute === 0 ? 1.2 : 3.2);
        agents[k].ov = null;
        holdBy(k);
        return simWait(0.3);
      }
      case 'goalkick': {
        // ball placed in the six-yard box
        const k = key(ev.side, ev.holder);
        const g = agents[k];
        live.possession = ev.side;
        const spot = { x: ev.side === 'home' ? 5.5 : W - 5.5, y: H / 2 + rand(-6, 6) };
        g.ov = { t: spot, spd: SPEED.gk };
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
        return doIntercept(ev);
      case 'goal': {
        await doShot(ev);
        live.score = { ...ev.score };
        setScore();
        const how = ev.kind === 'shot' ? '' : SHOT_KO[ev.kind];
        const assist = ev.assist !== null && ev.assist !== undefined ? `도움 ${name(ev.side, ev.assist)}` : '';
        const extra = [how, assist].filter(Boolean).join(', ');
        log(ev.minute, `⚽ 골! ${playerOf(ev.side, ev.from).ko}${extra ? ` (${extra})` : ''}`, ev.side, true);
        banner((ev.kind === 'header' ? 'HEADER! ' : ev.kind === 'long' ? 'WHAT A STRIKE! ' : 'GOAL — ') + name(ev.side, ev.from), ev.side);
        const pitch = $('#pitch');
        pitch.classList.add('is-goal', ev.side === 'home' ? 'net-r' : 'net-l');
        const gy = goalY(ev.side, ev.aimY);
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
        await doShot(ev);
        log(ev.minute, `${name(ev.side, ev.from)}의 ${SHOT_KO[ev.kind]} — ${name(other(ev.side), ev.keeper)} ${ev.caught ? '캐치' : '선방'}`, ev.side);
        banner('SAVE!');
        return simWait(0.6);
      case 'miss':
        await doShot(ev);
        log(ev.minute, `${name(ev.side, ev.from)}의 ${SHOT_KO[ev.kind]}${ev.over ? '이 크로스바 위로' : '이 빗나감'}`, ev.side);
        return simWait(0.6);
      case 'half':
        clearOverrides();
        live.kickoff = true;
        ball.mode = 'dead'; ball.holder = null;
        log(45, `하프타임 ${live.score.home} : ${live.score.away}`, null, true);
        banner('HALF TIME');
        return simWait(2.5);
      case 'end':
        clearOverrides();
        ball.mode = 'dead'; ball.holder = null;
        $('#clock').textContent = "90'";
        log(90, `경기 종료 ${ev.score.home} : ${ev.score.away}`, null, true);
        return simWait(1);
      default:
        return undefined;
    }
  }

  async function play(id) {
    const evs = result.events;
    for (let n = 0; n < evs.length; n++) {
      if (id !== runId) return;
      await step(evs[n], evs[n + 1]);
    }
    if (id === runId) showResult();
  }

  // ---------- result ----------
  function showResult() {
    const { stats, events } = result;
    const totalPasses = stats.home.passes + stats.away.passes || 1;
    const goals = events.filter((e) => e.type === 'goal');
    const scorers = (side) => goals.filter((g) => g.side === side)
      .map((g) => `${playerOf(side, g.from).short} ${g.minute}'${g.kind === 'header' ? ' (헤딩)' : g.kind === 'long' ? ' (중거리)' : ''}`)
      .join(', ') || '—';

    const mk = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; el.textContent = text; return el; };
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
    const rows = [
      ['점유율', pct(stats.home.passes, totalPasses), pct(stats.away.passes, totalPasses)],
      ['슈팅', stats.home.shots, stats.away.shots],
      ['유효 슈팅', stats.home.onTarget, stats.away.onTarget],
      ['패스', stats.home.passes, stats.away.passes],
      ['패스 성공률', pct(stats.home.completed, stats.home.passes), pct(stats.away.completed, stats.away.passes)],
    ];
    const table = $('#res-stats');
    table.innerHTML = '';
    rows.forEach(([label, h, a]) => {
      const tr = document.createElement('tr');
      tr.append(mk('td', 'h', String(h)), mk('th', '', label), mk('td', 'a', String(a)));
      table.append(tr);
    });
    $('#result').hidden = false;
  }

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
          p: { x: 0, y: 0 }, v: { x: 0, y: 0 }, off: { dx: 0, dy: 0 }, nextOff: rand(0.5, 3),
          goal: { x: 0, y: 0 }, max: SPEED.jog, acc: 8, ov: null, run: null, stride: rand(0, 6),
        };
        agents[o.key] = o;
      });
    });
    live.kickoff = true;
    Object.values(agents).forEach((o) => { o.p = shapeTarget(o); o.goal = { ...o.p }; });
  }

  function start(home, away) {
    teams = { home, away };
    runId++;
    skipping = false;
    timers = [];
    result = Sim.simulate(home.lineup, away.lineup, (Math.random() * 2 ** 32) >>> 0);
    Object.assign(live, { score: { home: 0, away: 0 }, possession: 'home', celebrate: null, kickoff: true });
    Object.assign(ball, { p: { x: W / 2, y: H / 2 }, h: 0, mode: 'dead', holder: null, fl: null, alpha: 1, dest: null });

    $('#draft').hidden = true;
    $('#match').hidden = false;
    $('#result').hidden = true;
    $('#log').innerHTML = '';
    $('#sb-home-name').textContent = home.name;
    $('#sb-away-name').textContent = away.name;
    $('#clock').textContent = "0'";
    setScore();
    buildAgents();
    pxPerM = $('#pitch').clientWidth / W || 11;
    window.scrollTo({ top: 0 });

    const gen = ++rafGen;
    last = performance.now();
    requestAnimationFrame((t) => frame(t, gen));
    play(runId);
  }

  function stop() {
    runId++;
    rafGen++;
    timers.forEach((t) => t.resolve());
    timers = [];
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
  $('#rematch').addEventListener('click', () => start(teams.home, teams.away));
  $('#back').addEventListener('click', () => {
    stop();
    $('#match').hidden = true;
    $('#draft').hidden = false;
    backCb();
  });

  window.Match = { start, onBack: (cb) => { backCb = cb; } };
})();
