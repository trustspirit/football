// Squad builder: one team at a time (home -> away -> kick-off).
// Left: the active team's pitch. Right: player cards in GK / DEF / MID / FWD columns.
// Cards are placed by click (auto slot or targeted slot) or by drag & drop onto a slot.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ROLES = ['GK', 'DEF', 'MID', 'FWD'];
  const ROLE_KO = { GK: '골키퍼', DEF: '수비수', MID: '미드필더', FWD: '공격수' };

  const state = {
    step: 'home',       // which team is being edited
    targetSlot: null,   // empty slot chosen on the pitch; next card click fills it
    query: '',
    teams: {
      home: { name: 'Paper FC', formation: '4-3-3', slots: Array(11).fill(null) },
      away: { name: 'Ink United', formation: '4-4-2', slots: Array(11).fill(null) },
    },
  };

  const current = () => state.teams[state.step];
  const otherSide = () => (state.step === 'home' ? 'away' : 'home');
  const isFull = (side) => state.teams[side].slots.every(Boolean);
  // A player can appear in both teams, but only once within a team.
  const inTeam = (side, id) => state.teams[side].slots.includes(id);

  // ---------- search ----------
  // Case-, accent- and space-insensitive: "mbappe" finds Mbappé, "반다이크" finds 반 다이크.
  const norm = (v) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s.\-']/g, '').toLowerCase();
  PLAYERS.forEach((p) => { p._search = norm([p.name, p.ko, p.short, p.nat].join(' ')); });
  const matches = (p) => !state.query || p._search.includes(norm(state.query));

  // ---------- squad mutations ----------
  function placeAt(idx, id) {
    const team = current();
    const prev = team.slots.indexOf(id);
    if (prev >= 0) team.slots[prev] = team.slots[idx]; // moving within the team -> swap
    team.slots[idx] = id;
  }

  // Click on a card: toggle off if already picked, otherwise fill the targeted slot,
  // the first empty slot of the player's role, or any empty slot.
  function pickCard(id) {
    const team = current();
    if (inTeam(state.step, id) && state.targetSlot === null) {
      team.slots[team.slots.indexOf(id)] = null;
      return render();
    }
    const layout = FORMATIONS[team.formation];
    let idx = state.targetSlot;
    if (idx === null) idx = layout.findIndex((s, i) => s.role === PLAYER_BY_ID[id].pos && !team.slots[i]);
    if (idx === -1) idx = team.slots.findIndex((x) => !x);
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
      const options = PLAYERS.filter((p) => p.pos === slot.role && !used.has(p.id));
      if (!options.length) return;
      const pick = options[Math.floor(Math.random() * options.length)];
      team.slots[i] = pick.id;
      used.add(pick.id);
    });
    render();
  }

  function goTo(step) {
    state.step = step;
    state.targetSlot = null;
    render();
  }

  // ---------- rendering ----------
  const teamOvr = (side) => {
    const ids = state.teams[side].slots.filter(Boolean);
    return ids.length ? Math.round(ids.reduce((s, id) => s + PLAYER_BY_ID[id].ovr, 0) / ids.length) : '—';
  };

  function stepsHTML() {
    const item = (side, n) => {
      const t = state.teams[side];
      const count = t.slots.filter(Boolean).length;
      const on = state.step === side ? ' is-on' : '';
      const done = count === 11 ? ' is-done' : '';
      const locked = side === 'away' && !isFull('home') ? ' disabled' : '';
      return `<button class="step step--${side}${on}${done}" data-step="${side}"${locked}>
        <b>${n}</b><span><small>${side === 'home' ? 'HOME' : 'AWAY'} 구성</small>${esc(t.name)}</span>
        <i>${count}/11 · OVR ${teamOvr(side)}</i></button>`;
    };
    return `${item('home', 1)}<span class="step__rule"></span>${item('away', 2)}<span class="step__rule"></span>
      <span class="step step--kick${isFull('home') && isFull('away') ? ' is-ready' : ''}"><b>3</b><span><small>MATCH</small>킥오프</span></span>`;
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
      return `<button class="slot${off}" data-slot="${i}" draggable="true" style="${style}" title="${esc(p.ko)}${offNote} — 클릭해서 빼기 / 끌어서 자리 바꾸기">
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
      </header>
      <div class="team__meta">
        <select class="team__formation" aria-label="포메이션">
          ${Object.keys(FORMATIONS).map((f) => `<option ${f === team.formation ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
        <span>${count}/11</span><span>OVR ${teamOvr(side)}</span>
        <button class="linkish" data-act="auto">자동 채우기</button>
        <button class="linkish" data-act="clear">비우기</button>
      </div>
      <div class="mini-pitch">${slots}</div>
      <div class="team__nav">${nav}</div>`;
  }

  function cardHTML(p) {
    const mine = inTeam(state.step, p.id);
    const rival = inTeam(otherSide(), p.id);
    return `
      <button class="pc${mine ? ' is-mine' : ''}" data-id="${p.id}" draggable="true">
        ${Photos.html(p, 'pc__photo')}
        <span class="pc__body">
          <b class="pc__ko">${p.ko}</b>
          <small class="pc__en">${p.name} · ${p.nat}</small>
          <span class="pc__stats" title="공격 ${p.att} · 패스 ${p.pas} · ${p.pos === 'GK' ? '선방' : '수비'} ${p.def}">A ${p.att} · P ${p.pas} · ${p.pos === 'GK' ? 'G' : 'D'} ${p.def}</span>
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

  function render() {
    $('#steps').innerHTML = stepsHTML();
    const teamEl = $('#team');
    teamEl.dataset.side = state.step;
    teamEl.innerHTML = teamHTML();

    // Keep each column's scroll position across re-renders.
    const scroll = {};
    document.querySelectorAll('.col').forEach((c) => { scroll[c.dataset.role] = $('.col__list', c).scrollTop; });
    $('#pool').innerHTML = poolHTML();
    document.querySelectorAll('.col').forEach((c) => { $('.col__list', c).scrollTop = scroll[c.dataset.role] || 0; });

    const team = current();
    const found = state.query ? PLAYERS.filter(matches).length : null;
    let tip;
    if (state.targetSlot !== null) tip = `${ROLE_KO[FORMATIONS[team.formation][state.targetSlot].role]} 자리에 넣을 선수를 고르세요 — 포지션 상관없이 어떤 카드든 가능해요.`;
    else if (found !== null) tip = `"${state.query}" 검색 결과 ${found}명`;
    else tip = `${team.name} 구성 중 — 포지션 상관없이 아무 카드나 클릭하거나, 피치의 원하는 자리로 끌어다 놓으세요.`;
    const tipEl = $('#pool-tip');
    if (!tipEl.classList.contains('is-warn')) tipEl.textContent = tip;
  }

  let tipTimer;
  function flashTip(msg) {
    const el = $('#pool-tip');
    el.textContent = msg;
    el.classList.add('is-warn');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { el.classList.remove('is-warn'); render(); }, 2000);
  }

  function kickoff() {
    const lineup = (side) => {
      const t = state.teams[side];
      return {
        name: t.name,
        lineup: FORMATIONS[t.formation].map((slot, i) => ({ player: PLAYER_BY_ID[t.slots[i]], slot })),
      };
    };
    Match.start(lineup('home'), lineup('away'));
  }

  // ---------- events ----------
  $('#steps').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (b && !b.disabled) goTo(b.dataset.step);
  });

  const teamEl = $('#team');
  teamEl.addEventListener('click', (e) => {
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
      case 'clear': current().slots = Array(11).fill(null); state.targetSlot = null; return render();
      case 'next': return goTo('away');
      case 'prev': return goTo('home');
      case 'kickoff': return kickoff();
      default: return undefined;
    }
  });
  teamEl.addEventListener('change', (e) => {
    if (e.target.matches('.team__formation')) changeFormation(e.target.value);
  });
  teamEl.addEventListener('input', (e) => {
    if (!e.target.matches('.team__name')) return;
    current().name = e.target.value || (state.step === 'home' ? 'Home' : 'Away');
    $('#steps').innerHTML = stepsHTML();
  });

  // Drag & drop: cards -> slot, or slot -> slot (swap).
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.pc[draggable="true"]');
    const slot = e.target.closest('.slot[draggable="true"]');
    if (card) e.dataTransfer.setData('text/plain', 'card:' + card.dataset.id);
    else if (slot) e.dataTransfer.setData('text/plain', 'slot:' + slot.dataset.slot);
    else return;
    e.dataTransfer.effectAllowed = 'move';
    teamEl.classList.add('is-dragging');
  });
  document.addEventListener('dragend', () => teamEl.classList.remove('is-dragging'));
  teamEl.addEventListener('dragover', (e) => {
    const slot = e.target.closest('.slot');
    if (!slot) return;
    e.preventDefault();
    document.querySelectorAll('.slot.is-over').forEach((s) => s !== slot && s.classList.remove('is-over'));
    slot.classList.add('is-over');
  });
  teamEl.addEventListener('dragleave', (e) => {
    const slot = e.target.closest('.slot');
    if (slot && !slot.contains(e.relatedTarget)) slot.classList.remove('is-over');
  });
  teamEl.addEventListener('drop', (e) => {
    const slot = e.target.closest('.slot');
    if (!slot) return;
    e.preventDefault();
    const [kind, value] = e.dataTransfer.getData('text/plain').split(':');
    const idx = +slot.dataset.slot;
    const team = current();
    if (kind === 'card') placeAt(idx, value);
    else if (kind === 'slot') {
      const from = +value;
      [team.slots[from], team.slots[idx]] = [team.slots[idx], team.slots[from]];
    }
    state.targetSlot = null;
    render();
  });

  $('#pool').addEventListener('click', (e) => {
    const card = e.target.closest('.pc');
    if (card) pickCard(card.dataset.id);
  });

  const search = $('#search');
  search.addEventListener('input', () => { state.query = search.value.trim(); render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; state.query = ''; render(); }
    if (e.key === 'Enter') {
      // Enter picks the single remaining result.
      const hits = PLAYERS.filter(matches);
      if (hits.length === 1) { pickCard(hits[0].id); search.value = ''; state.query = ''; render(); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !$('#draft').hidden && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      search.focus();
    }
  });

  Match.onBack(() => render());

  render();
  Photos.load(PLAYERS).then((changed) => { if (changed) render(); });
})();
