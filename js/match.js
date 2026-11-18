// Match screen: replays the event list produced by Sim.simulate on a pitch.
// Movement runs on a requestAnimationFrame loop:
//  - players ease toward target positions (team shape + pressing + runs) with idle sway
//  - the ball is either attached to a player's feet (dribbling) or in flight (tween with
//    friction-like easing, optional arc height + ground shadow)
(function () {
  const $ = (s) => document.querySelector(s);
  const other = (s) => (s === 'home' ? 'away' : 'home');
  const key = (side, i) => `${side}-${i}`;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const dirOf = (side) => (side === 'home' ? 1 : -1);
  // Pitch is 105 x 68 m; positions are in % of each axis.
  const meters = (a, b) => Math.hypot((a.x - b.x) * 1.05, (a.y - b.y) * 0.68);

  let teams = null;
  let result = null;
  let runId = 0;
  let speed = 1;
  let skipping = false;
  let backCb = () => {};
  const live = { possession: 'home', holder: null, ballTop: 50, score: { home: 0, away: 0 } };

  const toks = {};      // key -> { el, side, i, role, x, y, tx, ty, k, phase, rx, ry }
  const ball = { x: 50, y: 50, h: 0, tween: null, attached: null };
  let clock = 0;
  let last = 0;
  let rafGen = 0;     // bumps on start/stop so only one RAF loop is ever alive
  let rafOn = false;

  // ---------- team shape ----------
  // Base position from the formation, shifted by possession and ball side.
  function shapePos(side, entry) {
    const { x, y, role } = entry.slot;
    const depth = role === 'GK' ? 3 + x * 0.5 : 4 + x * 0.55 + (live.possession === side ? 20 : 5);
    const ballY = side === 'home' ? live.ballTop : 100 - live.ballTop;
    const width = role === 'GK' ? 50 + (ballY - 50) * 0.15 : y + (ballY - 50) * 0.22;
    const top = 6 + clamp(width, 0, 100) * 0.88;
    return side === 'home' ? { x: depth, y: top } : { x: 100 - depth, y: 100 - top };
  }

  // Recompute every player's target: shape + attacking runs + pressing on the ball carrier.
  function relayout() {
    Object.values(toks).forEach((o) => {
      const p = shapePos(o.side, teams[o.side].lineup[o.i]);
      o.k = o.role === 'GK' ? 3 : rand(2.2, 3.2);
      if (o.side === live.possession && (o.role === 'FWD' || o.role === 'MID')) {
        p.x += dirOf(o.side) * rand(0, 5);   // off-ball runs
        p.y += rand(-3, 3);
      }
      o.tx = clamp(p.x, 1.5, 98.5);
      o.ty = clamp(p.y, 3, 97);
    });
    if (!live.holder) return;
    const h = toks[key(live.holder.side, live.holder.i)];
    const target = { x: h.tx, y: h.ty };
    const pressers = Object.values(toks)
      .filter((o) => o.side !== live.holder.side && o.role !== 'GK')
      .sort((a, b) => meters(a, target) - meters(b, target))
      .slice(0, 2);
    pressers.forEach((o, n) => {
      const pull = n === 0 ? 0.7 : 0.35;
      o.tx = o.tx + (target.x - dirOf(h.side) * 2.5 - o.tx) * pull;
      o.ty = o.ty + (target.y - o.ty) * pull;
      o.k = 3.6;
    });
  }

  const footOf = (k) => {
    const o = toks[k];
    return { x: o.rx + dirOf(o.side) * 1.1, y: o.ry + 2.6 };
  };

  // ---------- animation loop ----------
  function frame(now, gen) {
    if (!rafOn || gen !== rafGen) return;
    const dt = Math.min(0.05, (now - last) / 1000) * speed;
    last = now;
    clock += dt;

    Object.values(toks).forEach((o) => {
      const a = 1 - Math.exp(-dt * o.k);
      o.x += (o.tx - o.x) * a;
      o.y += (o.ty - o.y) * a;
      o.rx = o.x + Math.sin(clock * 1.3 + o.phase) * 0.45;
      o.ry = o.y + Math.cos(clock * 1.1 + o.phase * 1.7) * 0.6;
      o.el.style.left = o.rx + '%';
      o.el.style.top = o.ry + '%';
    });

    const tw = ball.tween;
    if (tw) {
      tw.t = Math.min(1, tw.t + (dt * 1000) / tw.dur);
      const e = 1 - (1 - tw.t) ** 2;           // decelerates like a rolling ball
      const to = tw.to();
      ball.x = tw.from.x + (to.x - tw.from.x) * e;
      ball.y = tw.from.y + (to.y - tw.from.y) * e;
      ball.h = tw.arc * 4 * tw.t * (1 - tw.t);
      if (tw.t >= 1) {
        ball.tween = null;
        ball.attached = tw.attachTo;
        tw.resolve();
      }
    } else if (ball.attached) {
      const f = footOf(ball.attached);
      ball.x = f.x + Math.sin(clock * 12) * 0.3; // little touches while dribbling
      ball.y = f.y;
      ball.h = 0;
    }
    drawBall();
    requestAnimationFrame((t) => frame(t, gen));
  }

  function drawBall() {
    const b = $('#ball');
    const s = $('#ball-shadow');
    b.style.left = ball.x + '%';
    b.style.top = ball.y + '%';
    b.style.transform = `translate(-50%, -50%) translateY(${-ball.h}px) scale(${1 + ball.h / 45})`;
    s.style.left = ball.x + '%';
    s.style.top = ball.y + '%';
    s.style.opacity = String(0.45 - Math.min(0.3, ball.h / 80));
    s.style.transform = `translate(-50%, -50%) scale(${1 + ball.h / 30})`;
  }

  // Kick the ball toward a (possibly moving) target. Resolves when it arrives.
  function kick(to, { dur, arc = 0, attachTo = null }) {
    ball.attached = null;
    if (skipping) {
      const p = to();
      Object.assign(ball, { x: p.x, y: p.y, h: 0, attached: attachTo, tween: null });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      ball.tween = { from: { x: ball.x, y: ball.y }, to, dur, arc, attachTo, t: 0, resolve };
    });
  }

  const wait = (ms) => (skipping ? Promise.resolve() : new Promise((r) => setTimeout(r, ms / speed)));
  const playerOf = (side, i) => teams[side].lineup[i].player;

  function giveBall(side, i) {
    live.possession = side;
    live.holder = { side, i };
    const entry = teams[side].lineup[i];
    const yTeam = 6 + entry.slot.y * 0.88;
    live.ballTop = side === 'home' ? yTeam : 100 - yTeam;
    relayout();
  }

  function shotTarget(side, aimY) {
    const top = 6 + aimY * 0.88;
    return side === 'home' ? { x: 99.6, y: top } : { x: 0.4, y: 100 - top };
  }

  const gkKey = (side) => key(side, teams[side].lineup.findIndex((e) => e.slot.role === 'GK'));

  // ---------- presentation helpers ----------
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

  // ---------- event playback ----------
  async function shoot(ev) {
    const shooterK = key(ev.side, ev.from);
    const keeper = toks[gkKey(other(ev.side))];
    const target = shotTarget(ev.side, ev.aimY);
    // Wind-up: a short touch toward goal.
    toks[shooterK].tx += dirOf(ev.side) * 2;
    await wait(rand(120, 220));
    const d = meters(ball, target);
    // Keeper reacts: dives toward the ball (reaches it on a save, falls short on a goal).
    keeper.k = 7;
    if (ev.type === 'save') keeper.ty = target.y;
    else keeper.ty = keeper.ty + (target.y - keeper.ty) * (ev.type === 'goal' ? 0.45 : 0.25);
    const arc = Math.random() < 0.4 ? rand(10, 22) : rand(0, 6);
    const dest = ev.type === 'save' ? () => footOf(gkKey(other(ev.side))) : () => target;
    await kick(dest, { dur: 220 + d * 9, arc, attachTo: ev.type === 'save' ? gkKey(other(ev.side)) : null });
  }

  async function step(ev) {
    if (ev.minute !== undefined) $('#clock').textContent = ev.minute + "'";
    const name = (side, i) => playerOf(side, i).short;

    switch (ev.type) {
      case 'kickoff': {
        const k = key(ev.side, ev.holder);
        Object.assign(ball, { x: 50, y: 50, h: 0, attached: null, tween: null });
        giveBall(ev.side, ev.holder);
        toks[k].tx = 50 - dirOf(ev.side) * 1.5;
        toks[k].ty = 47;
        if (ev.minute === 0 || ev.minute === 45) log(ev.minute, `${teams[ev.side].name} 킥오프`, ev.side);
        await wait(900);
        ball.attached = k;
        return wait(200);
      }
      case 'goalkick':
      case 'gkball':
        giveBall(ev.side, ev.holder);
        ball.attached = key(ev.side, ev.holder);
        return wait(600);
      case 'pass': {
        const fromK = key(ev.side, ev.from);
        const toK = key(ev.side, ev.to);
        // Carry the ball a few steps before releasing it.
        toks[fromK].tx += dirOf(ev.side) * rand(1, 4);
        toks[fromK].ty += rand(-2, 2);
        await wait(rand(140, 300));
        giveBall(ev.side, ev.to);
        const d = meters(ball, footOf(toK));
        await kick(() => footOf(toK), { dur: 180 + d * 15, arc: d > 25 ? 6 + d * 0.35 : 0, attachTo: toK });
        return wait(60);
      }
      case 'intercept': {
        const defSide = other(ev.side);
        const byK = key(defSide, ev.by);
        const toK = key(ev.side, ev.to);
        toks[key(ev.side, ev.from)].tx += dirOf(ev.side) * rand(1, 3);
        await wait(rand(140, 260));
        // The defender steps into the passing lane.
        const lane = footOf(toK);
        const cut = { x: ball.x + (lane.x - ball.x) * 0.6, y: ball.y + (lane.y - ball.y) * 0.6 };
        const defender = toks[byK];
        defender.tx = cut.x; defender.ty = cut.y; defender.k = 6;
        const d = meters(ball, cut);
        await kick(() => footOf(byK), { dur: 180 + d * 15, attachTo: byK });
        giveBall(defSide, ev.by);
        if (Math.random() < 0.25) log(ev.minute, `${name(defSide, ev.by)} 가로채기`, defSide);
        return wait(120);
      }
      case 'goal': {
        await shoot(ev);
        live.holder = null;
        live.score = { ...ev.score };
        setScore();
        const assist = ev.assist !== null && ev.assist !== undefined ? ` (도움 ${name(ev.side, ev.assist)})` : '';
        log(ev.minute, `⚽ 골! ${playerOf(ev.side, ev.from).ko}${assist}`, ev.side, true);
        banner('GOAL — ' + name(ev.side, ev.from), ev.side);
        const pitch = $('#pitch');
        pitch.classList.add('is-goal', ev.side === 'home' ? 'net-r' : 'net-l');
        // Scorer wheels away to celebrate.
        const sc = toks[key(ev.side, ev.from)];
        sc.tx -= dirOf(ev.side) * 8; sc.ty = clamp(sc.ty + rand(-12, 12), 8, 92); sc.k = 2;
        await wait(1600);
        pitch.classList.remove('is-goal', 'net-r', 'net-l');
        return undefined;
      }
      case 'save':
        await shoot(ev);
        log(ev.minute, `${name(ev.side, ev.from)}의 슛 — ${name(other(ev.side), toks[gkKey(other(ev.side))].i)} 선방`, ev.side);
        banner('SAVE!');
        return wait(500);
      case 'miss': {
        await shoot(ev);
        log(ev.minute, `${name(ev.side, ev.from)}의 슛이 빗나감`, ev.side);
        return wait(500);
      }
      case 'half':
        live.holder = null;
        log(45, `하프타임 ${live.score.home} : ${live.score.away}`, null, true);
        banner('HALF TIME');
        return wait(1400);
      case 'end':
        live.holder = null;
        $('#clock').textContent = "90'";
        log(90, `경기 종료 ${ev.score.home} : ${ev.score.away}`, null, true);
        return wait(400);
      default:
        return undefined;
    }
  }

  async function play(id) {
    for (const ev of result.events) {
      if (id !== runId) return;
      await step(ev);
    }
    if (id === runId) showResult();
  }

  // ---------- result ----------
  function showResult() {
    const { stats, events } = result;
    const totalPasses = stats.home.passes + stats.away.passes || 1;
    const goals = events.filter((e) => e.type === 'goal');
    const scorers = (side) => goals.filter((g) => g.side === side)
      .map((g) => `${playerOf(side, g.from).short} ${g.minute}'`).join(', ') || '—';

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
  function buildTokens() {
    const wrap = $('#tokens');
    wrap.innerHTML = '';
    Object.keys(toks).forEach((k) => delete toks[k]);
    ['home', 'away'].forEach((side) => {
      teams[side].lineup.forEach((entry, i) => {
        const el = document.createElement('div');
        el.className = `token token--${side}`;
        el.innerHTML = Photos.html(entry.player);
        const label = document.createElement('em');
        label.textContent = entry.player.short;
        el.append(label);
        wrap.append(el);
        const p = shapePos(side, entry);
        toks[key(side, i)] = {
          el, side, i, role: entry.slot.role,
          x: p.x, y: p.y, tx: p.x, ty: p.y, rx: p.x, ry: p.y, k: 3, phase: rand(0, Math.PI * 2),
        };
      });
    });
  }

  function start(home, away) {
    teams = { home, away };
    runId++;
    skipping = false;
    result = Sim.simulate(home.lineup, away.lineup, (Math.random() * 2 ** 32) >>> 0);
    live.score = { home: 0, away: 0 };
    live.holder = null;
    live.possession = 'home';
    live.ballTop = 50;

    $('#draft').hidden = true;
    $('#match').hidden = false;
    $('#result').hidden = true;
    $('#log').innerHTML = '';
    $('#sb-home-name').textContent = home.name;
    $('#sb-away-name').textContent = away.name;
    $('#clock').textContent = "0'";
    setScore();
    buildTokens();
    Object.assign(ball, { x: 50, y: 50, h: 0, attached: null, tween: null });
    window.scrollTo({ top: 0 });
    rafOn = true;
    const gen = ++rafGen;
    last = performance.now();
    requestAnimationFrame((t) => frame(t, gen));
    play(runId);
  }

  function stop() {
    runId++;
    rafGen++;
    rafOn = false;
  }

  document.querySelectorAll('[data-speed]').forEach((b) => {
    b.addEventListener('click', () => {
      speed = +b.dataset.speed;
      document.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('is-on', x === b));
    });
  });
  $('#skip').addEventListener('click', () => {
    skipping = true;
    if (ball.tween) { const tw = ball.tween; ball.tween = null; ball.attached = tw.attachTo; tw.resolve(); }
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
