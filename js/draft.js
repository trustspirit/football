// Squad builder: one team at a time (home -> away -> kick-off).
// Left: the active team's pitch + tactics. Right: player cards in GK / DEF / MID / FWD columns.
// Cards are placed by tap (auto slot or targeted slot) or by dragging onto a slot
// (Pointer Events, so it works with mouse, pen and touch).
// Squads can be saved to / loaded from 6 local slots.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ROLES = ['GK', 'DEF', 'MID', 'FWD'];
  const ROLE_KO = { GK: '골키퍼', DEF: '수비수', MID: '미드필더', FWD: '공격수' };
  const TACTIC_OPTIONS = {
    mentality: { label: '성향', options: { defensive: '수비적', balanced: '균형', attacking: '공격적' } },
    style: { label: '스타일', options: { possession: '점유', balanced: '균형', direct: '롱볼·직선적', counter: '역습' } },
    press: { label: '압박', options: { low: '낮게', mid: '중간', high: '높게' } },
  };
  const SAVE_KEY = 'mdc-squads-v1';
  const SAVE_SLOTS = 6;
  const BENCH = 5;

  const newTeam = (name, formation) => ({
    name, formation, slots: Array(11).fill(null), bench: Array(BENCH).fill(null), tactic: { ...Sim.TACTIC_DEFAULT },
  });

  const state = {
    step: 'home',
    targetSlot: null,
    query: '',
    era: 'all', // player pool: all / now (current players) / legend
    teams: { home: newTeam('Paper FC', '4-3-3'), away: newTeam('Ink United', '4-4-2') },
  };

  const current = () => state.teams[state.step];
  const otherSide = () => (state.step === 'home' ? 'away' : 'home');
  const isFull = (side) => state.teams[side].slots.every(Boolean);
  // A player can appear in both teams, but only once within a team.
  const useBench = () => Options.get('stamina');
  const inTeam = (side, id) => state.teams[side].slots.includes(id) || (useBench() && state.teams[side].bench.includes(id));

  // ---------- search ----------
  const norm = (v) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s.\-']/g, '').toLowerCase();
  PLAYERS.forEach((p) => { p._search = norm([p.name, p.ko, p.short, p.nat].join(' ')); });
  const inEra = (p) => state.era === 'all' || (state.era === 'legend' ? !!p.legend : !p.legend);
  const matches = (p) => inEra(p) && (!state.query || p._search.includes(norm(state.query)));
  PLAYERS.forEach((p) => { if (p.legend) p._search += norm('legend 레전드'); });

  // ---------- squad mutations ----------
  // Put `id` at a pitch slot or bench spot. If the player was already in the team,
  // the two positions swap (pitch <-> pitch, pitch <-> bench, bench <-> bench).
  function moveTo(target, id) {
    const team = current();
    const arr = (kind) => (kind === 'bench' ? team.bench : team.slots);
    let from = null;
    if (team.slots.includes(id)) from = { kind: 'pitch', i: team.slots.indexOf(id) };
    else if (team.bench.includes(id)) from = { kind: 'bench', i: team.bench.indexOf(id) };
    const displaced = arr(target.kind)[target.i];
    arr(target.kind)[target.i] = id;
    if (from && !(from.kind === target.kind && from.i === target.i)) arr(from.kind)[from.i] = displaced;
  }
  const placeAt = (idx, id) => moveTo({ kind: 'pitch', i: idx }, id);

  function pickCard(id) {
    const team = current();
    if (inTeam(state.step, id) && state.targetSlot === null) {
      if (team.slots.includes(id)) team.slots[team.slots.indexOf(id)] = null;
      else team.bench[team.bench.indexOf(id)] = null;
      return render();
    }
    const layout = FORMATIONS[team.formation];
    let idx = state.targetSlot;
    if (idx === null) idx = layout.findIndex((s, i) => s.role === PLAYER_BY_ID[id].pos && !team.slots[i]);
    if (idx === -1) idx = team.slots.findIndex((x) => !x);
    if (idx === -1 && useBench()) {
      const b = team.bench.findIndex((x) => !x);
      if (b >= 0) { moveTo({ kind: 'bench', i: b }, id); return render(); }
      return flashTip('선발 11명과 벤치 5명이 모두 찼어요. 선수를 눌러 빼고 다시 골라 주세요.');
    }
    if (idx === -1) return flashTip('11명이 모두 찼어요. 피치 위 선수를 눌러 빼거나, 카드를 원하는 자리로 끌어다 놓으세요.');
    placeAt(idx, id);
    state.targetSlot = null;
    render();
  }

  function changeFormation(formation) {
    const team = current();
    const picked = team.slots.filter(Boolean);
    const layout = FORMATIONS[formation];
    const slots = Array(11).fill(null);
    const rest = [];
    picked.forEach((id) => {
      const i = layout.findIndex((s, k) => s.role === PLAYER_BY_ID[id].pos && !slots[k]);
      if (i >= 0) slots[i] = id; else rest.push(id);
    });
    rest.forEach((id) => { slots[slots.indexOf(null)] = id; });
    team.formation = formation;
    team.slots = slots;
    state.targetSlot = null;
    render();
  }

  function autoFill() {
    const team = current();
    const used = new Set(team.slots.filter(Boolean));
    FORMATIONS[team.formation].forEach((slot, i) => {
      if (team.slots[i]) return;
      const options = PLAYERS.filter((p) => p.pos === slot.role && inEra(p) && !used.has(p.id));
      if (!options.length) return;
      const pick = options[Math.floor(Math.random() * options.length)];
      team.slots[i] = pick.id;
      used.add(pick.id);
    });
    if (useBench()) {
      // a balanced bench: GK, DEF, MID, and two attackers
      ['GK', 'DEF', 'MID', 'FWD', 'FWD'].forEach((role, i) => {
        if (team.bench[i]) { used.add(team.bench[i]); return; }
        const options = PLAYERS.filter((p) => p.pos === role && inEra(p) && !used.has(p.id));
        if (!options.length) return;
        const pick = options[Math.floor(Math.random() * options.length)];
        team.bench[i] = pick.id;
        used.add(pick.id);
      });
    }
    render();
  }

  function goTo(step) {
    state.step = step;
    state.targetSlot = null;
    render();
  }

  // ---------- saved squads (localStorage, 6 slots) ----------
  // Saved data comes from storage and may be stale (players removed) or hand-edited, so
  // every slot is sanitised: unknown ids become empty slots, unknown tactics fall back.
  function sanitize(s) {
    if (!s || typeof s !== 'object' || !FORMATIONS[s.formation] || !Array.isArray(s.slots)) return null;
    const slots = Array.from({ length: 11 }, (_, i) => (PLAYER_BY_ID[s.slots[i]] ? s.slots[i] : null));
    const seen = new Set();
    slots.forEach((id, i) => { if (id && seen.has(id)) slots[i] = null; else if (id) seen.add(id); });
    const bench = Array.from({ length: BENCH }, (_, i) => {
      const id = Array.isArray(s.bench) ? s.bench[i] : null;
      if (!PLAYER_BY_ID[id] || seen.has(id)) return null;
      seen.add(id);
      return id;
    });
    const tactic = { ...Sim.TACTIC_DEFAULT };
    Object.keys(TACTIC_OPTIONS).forEach((k) => {
      if (s.tactic && TACTIC_OPTIONS[k].options[s.tactic[k]]) tactic[k] = s.tactic[k];
    });
    return { name: String(s.name || 'Team').slice(0, 18), formation: s.formation, slots, bench, tactic, savedAt: +s.savedAt || Date.now() };
  }
  function readSaves() {
    try {
      const arr = JSON.parse(localStorage.getItem(SAVE_KEY) || '[]');
      return Array.from({ length: SAVE_SLOTS }, (_, i) => sanitize(Array.isArray(arr) ? arr[i] : null));
    } catch (_) {
      return Array(SAVE_SLOTS).fill(null);
    }
  }
  function writeSaves(arr) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(arr)); return true; } catch (_) { return false; }
  }
  function saveTo(n) {
    const t = current();
    const arr = readSaves();
    arr[n] = { name: t.name, formation: t.formation, slots: [...t.slots], bench: [...t.bench], tactic: { ...t.tactic }, savedAt: Date.now() };
    if (!writeSaves(arr)) return flashTip('저장 공간을 사용할 수 없어요 (사생활 보호 모드 등).');
    renderSaves();
    flashTip(`${n + 1}번 슬롯에 "${t.name}" 저장 완료`);
  }
  function loadFrom(n) {
    const s = readSaves()[n];
    if (!s || !FORMATIONS[s.formation]) return;
    const t = current();
    t.name = s.name;
    t.formation = s.formation;
    t.slots = [...s.slots];
    t.bench = [...s.bench];
    t.tactic = { ...s.tactic };
    state.targetSlot = null;
    closeSaves();
    render();
    flashTip(`"${s.name}" 불러오기 완료`);
  }
  function deleteSave(n) {
    const arr = readSaves();
    arr[n] = null;
    writeSaves(arr);
    renderSaves();
  }

  const ovrOf = (ids) => {
    const list = ids.filter(Boolean);
    return list.length ? Math.round(list.reduce((s, id) => s + PLAYER_BY_ID[id].ovr, 0) / list.length) : '—';
  };

  function renderSaves() {
    const saves = readSaves();
    const team = current();
    $('#saves-list').innerHTML = saves.map((s, n) => {
      if (!s) {
        return `<li class="save save--empty"><b>${n + 1}</b><span class="save__body"><em>빈 슬롯</em></span>
          <span class="save__acts"><button class="btn btn--small" data-save="${n}">여기에 저장</button></span></li>`;
      }
      const filled = s.slots.filter(Boolean).length;
      const date = new Date(s.savedAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
      return `<li class="save"><b>${n + 1}</b>
        <span class="save__body"><strong>${esc(s.name)}</strong><small>${s.formation} · ${filled}/11 · OVR ${ovrOf(s.slots)} · ${date}</small></span>
        <span class="save__acts">
          <button class="btn btn--small" data-load="${n}">불러오기</button>
          <button class="btn btn--small btn--ghost" data-save="${n}">덮어쓰기</button>
          <button class="btn btn--small btn--ghost" data-del="${n}" aria-label="삭제">삭제</button>
        </span></li>`;
    }).join('');
    $('#saves-title').textContent = `스쿼드 저장/불러오기 — ${team.name}`;
  }
  function openSaves() { renderSaves(); $('#saves').hidden = false; }
  function closeSaves() { $('#saves').hidden = true; }

  // ---------- rendering ----------
  function stepsHTML() {
    const item = (side, n) => {
      const t = state.teams[side];
      const count = t.slots.filter(Boolean).length;
      const on = state.step === side ? ' is-on' : '';
      const done = count === 11 ? ' is-done' : '';
      const locked = side === 'away' && !isFull('home') ? ' disabled' : '';
      return `<button class="step step--${side}${on}${done}" data-step="${side}"${locked}>
        <b>${n}</b><span><small>${side === 'home' ? 'HOME' : 'AWAY'} 구성</small>${esc(t.name)}</span>
        <i>${count}/11 · OVR ${ovrOf(t.slots)}</i></button>`;
    };
    return `${item('home', 1)}<span class="step__rule"></span>${item('away', 2)}<span class="step__rule"></span>
      <span class="step step--kick${isFull('home') && isFull('away') ? ' is-ready' : ''}"><b>3</b><span><small>MATCH</small>킥오프</span></span>`;
  }

  function tacticsHTML(team) {
    return Object.entries(TACTIC_OPTIONS).map(([k, def]) => `
      <label class="tac"><span>${def.label}</span>
        <select data-tactic="${k}">
          ${Object.entries(def.options).map(([v, l]) => `<option value="${v}" ${team.tactic[k] === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>`).join('');
  }

  function teamHTML() {
    const side = state.step;
    const team = current();
    const layout = FORMATIONS[team.formation];
    const count = team.slots.filter(Boolean).length;

    const slots = layout.map((slot, i) => {
      const id = team.slots[i];
      const style = `left:${slot.y}%;top:${100 - (6 + slot.x * 0.86)}%`;
      if (!id) {
        const target = state.targetSlot === i ? ' is-target' : '';
        return `<button class="slot slot--empty${target}" data-slot="${i}" style="${style}" title="${ROLE_KO[slot.role]} 자리">${slot.role}</button>`;
      }
      const p = PLAYER_BY_ID[id];
      const off = p.pos !== slot.role ? ' is-off' : '';
      const offNote = off ? ` (원래 ${p.pos} → ${slot.role} 자리)` : '';
      return `<button class="slot${off}" data-slot="${i}" data-drag="slot" style="${style}" title="${esc(p.ko)}${offNote} — 탭해서 빼기 / 끌어서 자리 바꾸기">
        ${Photos.html(p)}<em>${p.short}</em></button>`;
    }).join('');

    const nav = side === 'home'
      ? `<button class="btn" data-act="next" ${isFull('home') ? '' : 'disabled'}>다음: 원정팀 구성 →</button>`
      : `<button class="btn btn--ghost" data-act="prev">← 홈팀</button>
         <button class="btn btn--kick" data-act="kickoff" ${isFull('home') && isFull('away') ? '' : 'disabled'}>킥오프</button>`;

    return `
      <header class="team__head">
        <span class="team__tag">${side === 'home' ? 'HOME' : 'AWAY'}</span>
        <input class="team__name" value="${esc(team.name)}" maxlength="18" aria-label="팀 이름">
        <button class="btn btn--small btn--ghost" data-act="saves">저장·불러오기</button>
      </header>
      <div class="team__meta">
        <span>${count}/11</span><span>OVR ${ovrOf(team.slots)}</span>
        <button class="linkish" data-act="auto">자동 채우기</button>
        <button class="linkish" data-act="clear">비우기</button>
      </div>
      <div class="team__tactics">
        <label class="tac"><span>포메이션</span>
          <select class="team__formation" aria-label="포메이션">
            ${Object.keys(FORMATIONS).map((f) => `<option ${f === team.formation ? 'selected' : ''}>${f}</option>`).join('')}
          </select></label>
        ${tacticsHTML(team)}
      </div>
      <div class="mini-pitch">${slots}</div>
      ${useBench() ? benchHTML(team) : ''}
      <div class="team__nav">${nav}</div>`;
  }

  function benchHTML(team) {
    const cells = team.bench.map((id, i) => {
      if (!id) return `<button class="bench-slot bench-slot--empty" data-bench="${i}" title="벤치 자리 — 카드를 끌어다 놓으세요">+</button>`;
      const p = PLAYER_BY_ID[id];
      return `<button class="bench-slot" data-bench="${i}" data-drag="bench" title="${esc(p.ko)} (${p.pos}) — 탭해서 빼기 / 끌어서 선발과 바꾸기">
        ${Photos.html(p)}<em>${p.short}</em><i>${p.pos}</i></button>`;
    }).join('');
    return `<div class="bench"><span class="bench__label">벤치 <small>${team.bench.filter(Boolean).length}/${BENCH}</small></span><div class="bench__row">${cells}</div></div>`;
  }

  // The four numbers that matter most for the position (all of them are in the tooltip).
  const CARD_STATS = {
    GK: [['선방', 'def'], ['킥', 'fk']],
    DEF: [['수', 'def'], ['속', 'pac'], ['피', 'phy'], ['패', 'pas']],
    MID: [['패', 'pas'], ['드', 'dri'], ['슛', 'sho'], ['FK', 'fk']],
    FWD: [['속', 'pac'], ['드', 'dri'], ['슛', 'sho'], ['패', 'pas']],
  };
  const cardStats = (p) => CARD_STATS[p.pos].map(([label, k]) => `<i>${label}</i>${p[k]}`).join('');

  function cardHTML(p) {
    const mine = inTeam(state.step, p.id);
    const rival = inTeam(otherSide(), p.id);
    const tip = `속도 ${p.pac} · 드리블 ${p.dri} · 슈팅 ${p.sho} · 프리킥 ${p.fk} · 공격 ${p.att} · 패스 ${p.pas} · ${p.pos === 'GK' ? '선방' : '수비'} ${p.def} · 피지컬 ${p.phy}`;
    return `
      <button class="pc${mine ? ' is-mine' : ''}${p.legend ? ' is-legend' : ''}" data-id="${p.id}" data-drag="card" title="${tip}">
        ${Photos.html(p, 'pc__photo')}
        <span class="pc__body">
          <b class="pc__ko">${p.ko}</b>
          <small class="pc__en">${p.legend ? '<b class="pc__legend">★ LEGEND</b> ' : ''}${p.name} · ${p.nat}</small>
          <span class="pc__stats">${cardStats(p)}</span>
        </span>
        <span class="pc__ovr">${p.ovr}</span>
        ${mine ? '<span class="pc__flag">✓</span>' : ''}
        ${rival ? `<span class="pc__flag pc__flag--${otherSide()}" title="상대 팀에도 있는 선수">${otherSide() === 'home' ? 'HOME' : 'AWAY'}</span>` : ''}
      </button>`;
  }

  function poolHTML() {
    const team = current();
    const layout = FORMATIONS[team.formation];
    const targetRole = state.targetSlot !== null ? layout[state.targetSlot].role : null;
    return ROLES.map((role) => {
      const picked = team.slots.filter((id) => id && PLAYER_BY_ID[id].pos === role).length;
      const list = PLAYERS.filter((p) => p.pos === role && matches(p)).sort((a, b) => b.ovr - a.ovr);
      const hot = targetRole === role ? ' is-hot' : '';
      return `
        <div class="col col--${role.toLowerCase()}${hot}" data-role="${role}">
          <header class="col__head">
            <b>${role}</b><span>${ROLE_KO[role]}</span>
            <i>${picked ? picked + '명 선택' : ''}</i>
          </header>
          <div class="col__list">
            ${list.map(cardHTML).join('') || '<p class="col__empty">검색 결과 없음</p>'}
          </div>
        </div>`;
    }).join('');
  }

  function tipText() {
    const team = current();
    const found = state.query ? PLAYERS.filter(matches).length : null;
    if (state.targetSlot !== null) return `${ROLE_KO[FORMATIONS[team.formation][state.targetSlot].role]} 자리에 넣을 선수를 고르세요 — 포지션 상관없이 어떤 카드든 가능해요.`;
    if (found !== null) return `"${state.query}" 검색 결과 ${found}명`;
    return `${team.name} 구성 중 — 카드를 탭하거나, 피치의 원하는 자리로 끌어다 놓으세요.`;
  }

  function render() {
    document.querySelectorAll('#era [data-era]').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.era === state.era);
      b.setAttribute('aria-checked', String(b.dataset.era === state.era));
    });
    $('#steps').innerHTML = stepsHTML();
    const teamEl = $('#team');
    teamEl.dataset.side = state.step;
    teamEl.innerHTML = teamHTML();

    const scroll = {};
    document.querySelectorAll('.col').forEach((c) => { scroll[c.dataset.role] = $('.col__list', c).scrollTop; });
    $('#pool').innerHTML = poolHTML();
    document.querySelectorAll('.col').forEach((c) => { $('.col__list', c).scrollTop = scroll[c.dataset.role] || 0; });

    const tipEl = $('#pool-tip');
    if (!tipEl.classList.contains('is-warn')) tipEl.textContent = tipText();
  }

  let tipTimer;
  function flashTip(msg) {
    const el = $('#pool-tip');
    el.textContent = msg;
    el.classList.add('is-warn');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { el.classList.remove('is-warn'); el.textContent = tipText(); }, 2200);
  }

  function kickoff() {
    const lineup = (side) => {
      const t = state.teams[side];
      return {
        name: t.name,
        tactic: { ...t.tactic },
        lineup: FORMATIONS[t.formation].map((slot, i) => ({ player: PLAYER_BY_ID[t.slots[i]], slot })),
        bench: useBench() ? t.bench.filter(Boolean).map((id) => PLAYER_BY_ID[id]) : [],
      };
    };
    Sound.unlock(); // must happen inside the tap for iOS
    Match.start(lineup('home'), lineup('away'));
  }

  // ---------- events ----------
  $('#steps').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (b && !b.disabled) goTo(b.dataset.step);
  });

  const teamEl = $('#team');
  // capture phase: runs before the panel/pool handlers, eats one post-drag click
  document.addEventListener('click', (e) => {
    if (!drag.suppressClick) return;
    drag.suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  teamEl.addEventListener('click', (e) => {
    const benchBtn = e.target.closest('.bench-slot');
    if (benchBtn) {
      const i = +benchBtn.dataset.bench;
      if (current().bench[i]) { current().bench[i] = null; return render(); }
      return flashTip('벤치 자리예요 — 선발이 다 찬 뒤 카드를 탭하거나, 카드를 이 자리로 끌어다 놓으세요.');
    }
    const slotBtn = e.target.closest('.slot');
    const act = e.target.closest('[data-act]');
    if (slotBtn) {
      const i = +slotBtn.dataset.slot;
      const team = current();
      if (team.slots[i]) { team.slots[i] = null; state.targetSlot = null; }
      else state.targetSlot = state.targetSlot === i ? null : i;
      return render();
    }
    if (!act) return;
    switch (act.dataset.act) {
      case 'auto': return autoFill();
      case 'clear': current().slots = Array(11).fill(null); current().bench = Array(BENCH).fill(null); state.targetSlot = null; return render();
      case 'next': return goTo('away');
      case 'prev': return goTo('home');
      case 'kickoff': return kickoff();
      case 'saves': return openSaves();
      default: return undefined;
    }
  });
  teamEl.addEventListener('change', (e) => {
    if (e.target.matches('.team__formation')) changeFormation(e.target.value);
    if (e.target.matches('[data-tactic]')) current().tactic[e.target.dataset.tactic] = e.target.value;
  });
  teamEl.addEventListener('input', (e) => {
    if (!e.target.matches('.team__name')) return;
    current().name = e.target.value || (state.step === 'home' ? 'Home' : 'Away');
    $('#steps').innerHTML = stepsHTML();
  });

  $('#pool').addEventListener('click', (e) => {
    const card = e.target.closest('.pc');
    if (card) pickCard(card.dataset.id);
  });

  // Saves dialog
  $('#saves').addEventListener('click', (e) => {
    if (e.target === $('#saves') || e.target.closest('[data-close]')) return closeSaves();
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.save !== undefined) saveTo(+b.dataset.save);
    if (b.dataset.load !== undefined) loadFrom(+b.dataset.load);
    if (b.dataset.del !== undefined) deleteSave(+b.dataset.del);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#saves').hidden) closeSaves(); });

  // ---------- drag & drop (Pointer Events: mouse, pen, touch) ----------
  // A press that moves more than a few px becomes a drag with a floating ghost.
  // Touch drags on cards start only after a short hold so the column can still scroll.
  const drag = { src: null, ghost: null, startX: 0, startY: 0, active: false, timer: null, pointerId: null, suppressClick: false };

  const srcId = (src) => (src.kind === 'card' ? src.id : src.kind === 'bench' ? current().bench[src.slot] : current().slots[src.slot]);
  function slotAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && el.closest('#team .slot, #team .bench-slot');
  }
  function beginDrag(e) {
    if (drag.ghost) drag.ghost.remove();
    drag.active = true;
    const src = drag.src;
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    const id = srcId(src);
    const p = PLAYER_BY_ID[id];
    ghost.innerHTML = Photos.html(p);
    const label = document.createElement('em');
    label.textContent = p.short;
    ghost.append(label);
    document.body.append(ghost);
    drag.ghost = ghost;
    teamEl.classList.add('is-dragging');
    moveGhost(e.clientX, e.clientY);
    requestAnimationFrame(autoScroll);
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) { /* ignore */ } }
  }
  function autoScroll() {
    if (!drag.active || !drag.last) return;
    const edge = 70;
    const y = drag.last.y;
    const dy = y < edge ? -(edge - y) / 3 : y > innerHeight - edge ? (y - (innerHeight - edge)) / 3 : 0;
    if (dy) { window.scrollBy(0, dy); moveGhost(drag.last.x, drag.last.y); }
    requestAnimationFrame(autoScroll);
  }
  function moveGhost(x, y) {
    drag.last = { x, y };
    drag.ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -60%)`;
    document.querySelectorAll('.slot.is-over').forEach((s) => s.classList.remove('is-over'));
    const over = slotAt(x, y);
    if (over) over.classList.add('is-over');
  }
  function endDrag(x, y) {
    const over = drag.active ? slotAt(x, y) : null;
    if (over) {
      const target = over.dataset.bench !== undefined ? { kind: 'bench', i: +over.dataset.bench } : { kind: 'pitch', i: +over.dataset.slot };
      const id = srcId(drag.src);
      if (id) moveTo(target, id);
      state.targetSlot = null;
    }
    if (drag.active) {
      // swallow the click that follows a drag (whenever the browser delivers it)
      drag.suppressClick = true;
      setTimeout(() => { drag.suppressClick = false; }, 400);
    }
    cleanupDrag();
    if (over) render();
  }
  function cleanupDrag() {
    clearTimeout(drag.timer);
    if (drag.ghost) drag.ghost.remove();
    document.querySelectorAll('.slot.is-over').forEach((s) => s.classList.remove('is-over'));
    teamEl.classList.remove('is-dragging');
    Object.assign(drag, { src: null, ghost: null, active: false, pointerId: null });
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || $('#draft').hidden) return;
    const card = e.target.closest('[data-drag="card"]');
    const slot = e.target.closest('[data-drag="slot"]');
    const benched = e.target.closest('[data-drag="bench"]');
    if (!card && !slot && !benched) return;
    drag.src = card ? { kind: 'card', id: card.dataset.id }
      : slot ? { kind: 'slot', slot: +slot.dataset.slot }
        : { kind: 'bench', slot: +benched.dataset.bench };
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.pointerId = e.pointerId;
    if (e.pointerType === 'touch' && card) {
      // long-press to pick a card up; a quick swipe still scrolls the column
      drag.timer = setTimeout(() => { if (drag.src) beginDrag(e); }, 280);
    }
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag.src || e.pointerId !== drag.pointerId) return;
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (!drag.active) {
      if (e.pointerType === 'touch' && drag.src.kind === 'card') {
        if (moved > 10) cleanupDrag(); // it was a scroll
        return;
      }
      if (moved < 6) return;
      beginDrag(e);
    }
    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
  }, { passive: false });
  document.addEventListener('pointerup', (e) => {
    if (!drag.src || e.pointerId !== drag.pointerId) return;
    endDrag(e.clientX, e.clientY);
  });
  document.addEventListener('pointercancel', () => { if (!drag.active) cleanupDrag(); });
  // Touch fallback: while a drag is active, stop scrolling and follow the finger even if
  // the browser cancelled the pointer stream.
  document.addEventListener('touchmove', (e) => {
    if (!drag.active) return;
    e.preventDefault();
    const t = e.touches[0];
    drag.last = { x: t.clientX, y: t.clientY };
    moveGhost(t.clientX, t.clientY);
  }, { passive: false });
  document.addEventListener('touchend', () => {
    if (drag.active && drag.last) endDrag(drag.last.x, drag.last.y);
  });
  // system gesture / interruption: drop the drag without placing anything
  document.addEventListener('touchcancel', () => { if (drag.src) cleanupDrag(); });

  // ---------- player pool: all / current / legends ----------
  document.querySelectorAll('#era [data-era]').forEach((b) => b.addEventListener('click', () => {
    state.era = b.dataset.era;
    render();
  }));

  // ---------- search ----------
  const search = $('#search');
  search.addEventListener('input', () => { state.query = search.value.trim(); render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; state.query = ''; render(); }
    if (e.key === 'Enter') {
      const hits = PLAYERS.filter(matches);
      if (hits.length === 1) { pickCard(hits[0].id); search.value = ''; state.query = ''; render(); search.blur(); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !$('#draft').hidden && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      search.focus();
    }
  });

  // ---------- settings ----------
  const settings = $('#settings');
  function openSettings() {
    settings.querySelectorAll('[data-opt]').forEach((c) => { c.checked = !!Options.get(c.dataset.opt); });
    settings.hidden = false;
  }
  $('#open-settings').addEventListener('click', openSettings);
  settings.addEventListener('click', (e) => {
    if (e.target === settings || e.target.closest('[data-close]')) settings.hidden = true;
  });
  settings.addEventListener('change', (e) => {
    const c = e.target.closest('[data-opt]');
    if (!c) return;
    Options.set(c.dataset.opt, c.checked);
    if (c.dataset.opt === 'sound') Sound.setEnabled(c.checked);
    render();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settings.hidden) settings.hidden = true; });

  // rotate hint: dismissed for this session
  try { if (sessionStorage.getItem('mdc-rotate-hint') === 'off') document.body.classList.add('no-rotate-hint'); } catch (_) { /* ignore */ }
  $('#rotate-hint-close').addEventListener('click', () => {
    document.body.classList.add('no-rotate-hint');
    try { sessionStorage.setItem('mdc-rotate-hint', 'off'); } catch (_) { /* ignore */ }
  });

  Match.onBack(() => render());

  render();
  Photos.load(PLAYERS).then((changed) => { if (changed) render(); });
})();
