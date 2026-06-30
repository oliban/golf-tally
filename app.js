/* Golf Scorecard — a tiny client-side PWA.
 * No build step, no server. State lives in localStorage and is saved on every change.
 *
 * Scoring model (Stableford, best-effort — no course slope/rating):
 *   - A player receives strokes spread across the holes by Stroke Index (SI).
 *   - playingHandicap = handicap for 18 holes, handicap/2 for 9 holes.
 *   - strokesOnHole = floor(ph / holes) + (si <= (ph mod holes) ? 1 : 0)
 *     e.g. handicap 36 over 18 holes -> 2 strokes on every hole.
 *   - net = gross - strokesReceived
 *   - points = max(0, par - net + 2)   (net par = 2 pts, net bogey = 1, net birdie = 3, ...)
 */

const STORE_KEY = 'golf.scorecard.v1';

/* ----------------------------- state ----------------------------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { rounds: [], courses: [], view: { name: 'home' } };
}

let state = loadState();
if (!state.courses) state.courses = []; // courses are remembered course layouts (par + SI)

function save() {
  // Write synchronously on every change so nothing is lost if the page is
  // closed or reloaded right after a tap — this is the "real-time save".
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — storage full?'); }
}

function uid() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/* ----------------------------- scoring ----------------------------- */

function playingHandicap(handicap, holesCount) {
  const h = Number(handicap) || 0;
  return holesCount === 9 ? Math.round(h / 2) : Math.round(h);
}

function strokesReceived(handicap, si, holesCount) {
  const ph = playingHandicap(handicap, holesCount);
  if (ph <= 0 || !si) return 0;
  const base = Math.floor(ph / holesCount);
  const remainder = ph % holesCount;
  return base + (si <= remainder ? 1 : 0);
}

function holePoints(gross, par, strokes) {
  if (gross == null) return null;
  const net = gross - strokes;
  return Math.max(0, par - net + 2);
}

// Colour bucket for a hole's Stableford points: 0 red, 1 orange, 2 black,
// 3 green, 4+ dark green.
function ptsClass(pts) {
  if (pts == null) return '';
  if (pts <= 0) return 'p0';
  if (pts >= 4) return 'p4';
  return 'p' + pts; // p1, p2, p3
}

function playerTotals(round, player) {
  let points = 0, gross = 0, played = 0;
  for (const hole of round.holes) {
    const g = round.scores[player.id]?.[hole.index];
    if (g == null) continue;
    played++;
    gross += g;
    const sr = strokesReceived(player.handicap, hole.si, round.holes.length);
    points += holePoints(g, hole.par, sr);
  }
  return { points, gross, played };
}

function leaderboard(round) {
  return round.players
    .map(p => ({ player: p, ...playerTotals(round, p) }))
    .sort((a, b) => b.points - a.points || a.gross - b.gross);
}

// Persist a hole's par/SI back to the round's linked course, so the corrected
// layout is remembered for the next round on that course.
function syncCourseHole(round, hole) {
  if (!round.courseId) return;
  const c = state.courses.find(x => x.id === round.courseId);
  if (!c) return;
  const ch = c.holes.find(x => x.index === hole.index);
  if (ch) { ch.par = hole.par; ch.si = hole.si; c.updatedAt = Date.now(); }
}

/* ----------------------------- course presets ----------------------------- */

// A standard par-72 layout (front + back nine). SI defaults to hole order; the
// user can edit either per hole. We only really need par + SI to score.
const STD_PARS_18 = [4,5,4,3,4,4,3,5,4, 4,4,3,5,4,4,3,4,5];

function makeHoles(count, preset) {
  const holes = [];
  for (let i = 1; i <= count; i++) {
    let par = 4;
    if (preset === 'std' && count === 18) par = STD_PARS_18[i - 1];
    holes.push({ index: i, par, si: i });
  }
  return holes;
}

/* ----------------------------- navigation ----------------------------- */

function go(view) {
  state.view = view;
  save();
  render();
  window.scrollTo(0, 0);
}

function currentRound() {
  return state.rounds.find(r => r.id === state.view.roundId);
}

/* ----------------------------- helpers ----------------------------- */

function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') el.className = attrs[k];
    else if (k === 'html') el.innerHTML = attrs[k];
    else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] === true) el.setAttribute(k, '');
    else if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
  }
  if (children != null) {
    (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c == null) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }
  return el;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

let toastTimer = null;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = h('div', { class: 'toast' }); document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

function topbar(title, opts = {}) {
  return h('div', { class: 'topbar' }, [
    opts.back ? h('button', { class: 'back', onclick: opts.back }, '‹ Back') : null,
    h('h1', null, title),
    opts.action ? h('button', { class: 'action', onclick: opts.action.onclick }, opts.action.label) : null,
  ]);
}

/* ----------------------------- screens ----------------------------- */

function screenHome() {
  const rounds = [...state.rounds].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const content = h('div', { class: 'content' });

  if (rounds.length === 0) {
    content.appendChild(h('div', { class: 'empty' }, [
      h('div', { class: 'big' }, '⛳️'),
      h('div', null, 'No rounds yet.'),
      h('div', { class: 'dim', html: 'Tap <strong>New round</strong> to start scoring.' }),
    ]));
  } else {
    rounds.forEach(r => {
      const lb = leaderboard(r);
      const top = lb[0];
      const thru = Math.max(...r.players.map(p => playerTotals(r, p).played), 0);
      content.appendChild(h('div', { class: 'card tappable round-card', onclick: () => go({ name: 'round', roundId: r.id }) }, [
        h('div', { class: 'meta' }, [
          h('div', { class: 'title' }, r.name || r.courseName || 'Round'),
          h('div', { class: 'sub' }, `${r.courseName && r.name ? r.courseName + ' · ' : ''}${fmtDate(r.date)} · ${r.holes.length} holes · ${r.players.length} player${r.players.length > 1 ? 's' : ''}`),
        ]),
        top ? h('div', { class: 'lead' }, [
          h('strong', null, String(top.points)),
          h('span', null, `${esc(top.player.name)} · thru ${thru}`),
        ]) : null,
        h('div', { class: 'chev' }, '›'),
      ]));
    });
  }

  const wrap = h('div', null, [
    topbar('My Rounds'),
    content,
    h('div', { class: 'fab-bar' }, h('div', { class: 'inner' },
      h('button', { class: 'btn', onclick: () => startNewRound() }, '+  New round'))),
  ]);
  return wrap;
}

function startNewRound() {
  // Prefill the roster from the most recent round so you don't re-enter
  // players every time; trim or edit them on the setup screen as needed.
  const last = [...state.rounds].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  const players = last && last.players.length
    ? last.players.map(p => ({ id: uid(), name: p.name, handicap: String(p.handicap) }))
    : [{ id: uid(), name: '', handicap: '' }];

  // Seed a draft round in the setup screen.
  go({
    name: 'setup',
    draft: {
      id: uid(),
      name: '',
      date: new Date().toISOString().slice(0, 10),
      holesCount: 18,
      preset: 'flat',
      courseId: null,      // links to a saved course layout, if chosen
      courseName: '',      // name for selecting/creating a course
      players,
    },
  });
}

function screenSetup() {
  const d = state.view.draft;
  const content = h('div', { class: 'content' });

  // Round name + date
  const card1 = h('div', { class: 'card' }, [
    h('label', { class: 'field' }, [
      h('span', { class: 'lbl' }, 'Round name (optional)'),
      h('input', { type: 'text', placeholder: 'e.g. Saturday at Pine Valley', value: d.name,
        oninput: e => { d.name = e.target.value; } }),
    ]),
    h('label', { class: 'field' }, [
      h('span', { class: 'lbl' }, 'Date'),
      h('input', { type: 'date', value: d.date, oninput: e => { d.date = e.target.value; } }),
    ]),
    h('label', { class: 'field', style: 'margin-bottom:0' }, [
      h('span', { class: 'lbl' }, 'Holes'),
      h('div', { class: 'seg' }, [9, 18].map(n =>
        h('button', { class: d.holesCount === n ? 'on' : '', onclick: () => { d.holesCount = n; d.courseId = null; rerenderSetup(); } }, String(n)))),
    ]),
  ]);

  // Course — a remembered layout of par + stroke index, reusable across rounds.
  // Show every saved course regardless of the hole count picked above; choosing
  // one switches the round to that course's hole count.
  const savedCourses = state.courses;
  const selected = d.courseId ? state.courses.find(c => c.id === d.courseId) : null;
  const courseCard = h('div', { class: 'card' });
  courseCard.appendChild(h('div', { class: 'section-label' }, 'Course'));
  if (savedCourses.length) {
    const chips = h('div', { class: 'chips' });
    savedCourses.forEach(c => {
      chips.appendChild(h('button', {
        class: 'chip' + (d.courseId === c.id ? ' on' : ''),
        onclick: () => {
          if (d.courseId === c.id) { d.courseId = null; d.courseName = ''; }
          else { d.courseId = c.id; d.courseName = c.name; d.holesCount = c.holesCount; }
          rerenderSetup();
        },
      }, `${c.name} · ${c.holesCount}h · par ${c.holes.reduce((s, hh) => s + hh.par, 0)}`));
    });
    courseCard.appendChild(chips);
  }
  courseCard.appendChild(h('label', { class: 'field', style: 'margin:' + (savedCourses.length ? '12px' : '0') + ' 0 0' }, [
    h('span', { class: 'lbl' }, selected ? 'Using saved course' : 'New course name (optional)'),
    h('input', { type: 'text', placeholder: 'e.g. Pine Hills', value: d.courseName,
      oninput: e => { d.courseName = e.target.value; d.courseId = null; } }),
  ]));
  if (!selected) {
    courseCard.appendChild(h('div', { class: 'field', style: 'margin:12px 0 0' }, [
      h('span', { class: 'lbl' }, 'Starting par template'),
      h('div', { class: 'seg' }, [
        h('button', { class: d.preset === 'flat' ? 'on' : '', onclick: () => { d.preset = 'flat'; rerenderSetup(); } }, 'All par 4'),
        h('button', { class: d.preset === 'std' ? 'on' : '', onclick: () => { d.preset = 'std'; rerenderSetup(); } }, 'Standard 72'),
      ]),
    ]));
  }
  courseCard.appendChild(h('div', { class: 'hint', style: 'margin:10px 2px 0' },
    selected
      ? `Pars from "${selected.name}" are loaded. Any par/SI you tweak while playing is saved back to it for next time.`
      : (d.courseName.trim()
        ? `New course "${d.courseName.trim()}" will be saved as you play — next round just tap it to reuse these pars.`
        : 'Tip: name the course and your per-hole pars are remembered, so you only set them once.')));

  // Players
  const playersCard = h('div', { class: 'card' });
  playersCard.appendChild(h('div', { class: 'section-label' }, 'Players & handicaps'));
  d.players.forEach((p, i) => {
    playersCard.appendChild(h('div', { class: 'player-row' }, [
      h('input', { class: 'name', type: 'text', placeholder: `Player ${i + 1}`, value: p.name,
        oninput: e => { p.name = e.target.value; } }),
      h('input', { class: 'hcp' + (d.hcpError && String(p.handicap).trim() === '' ? ' invalid' : ''),
        type: 'number', inputmode: 'numeric', placeholder: 'HCP', value: p.handicap,
        oninput: e => { p.handicap = e.target.value; if (d.hcpError) d.hcpError = false; e.target.classList.remove('invalid'); } }),
      d.players.length > 1 ? h('button', { class: 'rm', onclick: () => { d.players.splice(i, 1); rerenderSetup(); } }, '×') : null,
    ]));
  });
  if (d.players.length < 4) {
    playersCard.appendChild(h('button', { class: 'btn ghost add-player', onclick: () => {
      d.players.push({ id: uid(), name: '', handicap: '' }); rerenderSetup();
    } }, '+ Add player'));
  }
  playersCard.appendChild(h('div', { class: 'hint', style: 'margin-bottom:0' },
    'Handicap sets how many strokes each player gets per hole. e.g. 36 over 18 holes = 2 strokes a hole, so a 6 on a par 4 scores 2 points.'));

  content.appendChild(card1);
  content.appendChild(courseCard);
  content.appendChild(playersCard);

  return h('div', null, [
    topbar('New Round', { back: () => go({ name: 'home' }) }),
    content,
    h('div', { class: 'fab-bar' }, h('div', { class: 'inner' },
      h('button', { class: 'btn', onclick: () => commitNewRound() }, 'Start round  ›'))),
  ]);
}

function rerenderSetup() { render(); }

function commitNewRound() {
  const d = state.view.draft;
  // Drop fully-blank rows, then require a handicap for every remaining player.
  const rows = d.players.filter(p => (p.name || '').trim() !== '' || String(p.handicap).trim() !== '');
  if (rows.length === 0) { toast('Add at least one player'); return; }
  if (rows.some(p => String(p.handicap).trim() === '' || !Number.isFinite(Number(p.handicap)))) {
    d.hcpError = true;
    rerenderSetup();
    toast('Set a handicap for every player');
    return;
  }
  const named = rows.map((p, i) => ({
    id: p.id,
    name: (p.name || '').trim() || `Player ${i + 1}`,
    handicap: Number(p.handicap),
  }));

  // Resolve the course: an explicitly-picked one, else match a typed name,
  // else create a new saved course from the chosen template (if named).
  let courseId = d.courseId;
  const typed = (d.courseName || '').trim();
  if (!courseId && typed) {
    const match = state.courses.find(c =>
      c.holesCount === d.holesCount && c.name.trim().toLowerCase() === typed.toLowerCase());
    if (match) courseId = match.id;
  }
  let holes, courseName = '';
  if (courseId) {
    const c = state.courses.find(x => x.id === courseId);
    holes = c.holes.map(hh => ({ ...hh })); // copy so the round can be edited independently
    courseName = c.name;
  } else {
    holes = makeHoles(d.holesCount, d.preset);
    if (typed) {
      const c = { id: uid(), name: typed, holesCount: d.holesCount, holes: holes.map(hh => ({ ...hh })), updatedAt: Date.now() };
      state.courses.push(c);
      courseId = c.id;
      courseName = c.name;
    }
  }

  const round = {
    id: d.id,
    name: (d.name || '').trim(),
    date: d.date,
    courseId: courseId || null,
    courseName,
    holes,
    players: named,
    scores: Object.fromEntries(named.map(p => [p.id, {}])),
    currentHole: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.rounds.push(round);
  save();
  go({ name: 'round', roundId: round.id });
}

function screenRound() {
  const r = currentRound();
  if (!r) return screenHome();
  const tab = state.view.tab || 'play';

  const content = h('div', { class: 'content' });

  // Leaderboard summary (always at top)
  const lb = leaderboard(r);
  const leader = h('div', { class: 'leader' });
  lb.forEach((row, i) => {
    leader.appendChild(h('div', { class: 'leader-row' + (i === 0 ? ' first' : '') }, [
      h('div', { class: 'pos' }, String(i + 1)),
      h('div', { class: 'nm' }, row.player.name),
      h('div', null, [
        h('span', { class: 'pts' }, String(row.points)),
        h('span', { class: 'thru' }, `  thru ${row.played}`),
      ]),
    ]));
  });
  content.appendChild(leader);

  // Tab switch
  content.appendChild(h('div', { class: 'seg', style: 'margin-bottom:16px' }, [
    h('button', { class: tab === 'play' ? 'on' : '', onclick: () => go({ ...state.view, tab: 'play' }) }, 'Hole'),
    h('button', { class: tab === 'card' ? 'on' : '', onclick: () => go({ ...state.view, tab: 'card' }) }, 'Scorecard'),
  ]));

  if (tab === 'play') content.appendChild(holeEntry(r));
  else content.appendChild(scorecardTable(r));

  return h('div', null, [
    topbar(r.name || r.courseName || 'Round', {
      back: () => go({ name: 'home' }),
      action: { label: '⋯', onclick: () => go({ name: 'roundMenu', roundId: r.id }) },
    }),
    content,
  ]);
}

function holeEntry(r) {
  const N = r.holes.length;
  let cur = Math.min(Math.max(r.currentHole || 1, 1), N);
  const hole = r.holes[cur - 1];
  const box = h('div');

  function setHole(n) { r.currentHole = Math.min(Math.max(n, 1), N); r.updatedAt = Date.now(); save(); go(state.view); }

  // Header with prev/next
  box.appendChild(h('div', { class: 'hole-head' }, [
    h('button', { class: 'nav', disabled: cur === 1, onclick: () => setHole(cur - 1) }, '‹'),
    h('div', { class: 'hole-title' }, [
      h('div', { class: 'n' }, `Hole ${cur}`),
      h('div', { class: 'pp' }, `Par ${hole.par} · SI ${hole.si}`),
    ]),
    h('button', { class: 'nav', disabled: cur === N, onclick: () => setHole(cur + 1) }, '›'),
  ]));

  // Editable par + stroke index for this hole. Steppers (not text inputs) so
  // editing is one-tap on mobile and never loses focus. Changes are saved back
  // to the linked course so you don't re-enter them next round.
  function commitHoleMeta() { r.updatedAt = Date.now(); syncCourseHole(r, hole); save(); go(state.view); }
  // `kind` ('par' | 'si') drives the colour coding so these course-setup
  // controls are easy to tell apart from the green player-score steppers.
  function metaStepper(label, kind, value, dec, inc) {
    return h('div', { class: 'mini ' + kind }, [
      h('span', { class: 'mini-lbl' }, label),
      h('button', { class: 'mini-btn', onclick: dec }, '−'),
      h('span', { class: 'mini-val' }, String(value)),
      h('button', { class: 'mini-btn', onclick: inc }, '+'),
    ]);
  }
  box.appendChild(h('div', { class: 'par-edit' }, [
    metaStepper('Par', 'par', hole.par,
      () => { hole.par = Math.max(1, hole.par - 1); commitHoleMeta(); },
      () => { hole.par = hole.par + 1; commitHoleMeta(); }),
    metaStepper('SI', 'si', hole.si,
      () => { hole.si = Math.max(1, hole.si - 1); commitHoleMeta(); },
      () => { hole.si = Math.min(N, hole.si + 1); commitHoleMeta(); }),
  ]));

  // One row per player
  r.players.forEach(p => {
    const g = r.scores[p.id][cur] ?? null;
    const sr = strokesReceived(p.handicap, hole.si, N);
    const pts = holePoints(g, hole.par, sr);

    const valEl = h('div', { class: 'val' + (g == null ? ' blank' : '') }, g == null ? '–' : String(g));
    const ptsEl = h('div', { class: 'p ' + (pts == null ? '' : pts === 0 ? 'zero' : 'good') }, pts == null ? '–' : String(pts));

    function setGross(v) {
      if (v == null) delete r.scores[p.id][cur];
      else r.scores[p.id][cur] = v;
      r.updatedAt = Date.now();
      save();
      const ng = r.scores[p.id][cur] ?? null;
      valEl.textContent = ng == null ? '–' : String(ng);
      valEl.classList.toggle('blank', ng == null);
      const np = holePoints(ng, hole.par, sr);
      ptsEl.textContent = np == null ? '–' : String(np);
      ptsEl.className = 'p ' + (np == null ? '' : np === 0 ? 'zero' : 'good');
      refreshLeader(r);
    }

    box.appendChild(h('div', { class: 'score-row' }, [
      h('div', { class: 'who' }, [
        h('div', { class: 'nm' }, p.name),
        h('div', { class: 'det' }, [
          `HCP ${p.handicap} · `,
          h('span', { class: 'dot' }, sr > 0 ? `+${sr} stroke${sr > 1 ? 's' : ''}` : 'no stroke'),
        ]),
      ]),
      h('div', { class: 'stepper' }, [
        h('button', { onclick: () => { const c = r.scores[p.id][cur] ?? hole.par + sr; setGross(Math.max(1, c - 1)); } }, '−'),
        valEl,
        h('button', { onclick: () => { const c = r.scores[p.id][cur] ?? (hole.par + sr - 1); setGross(c + 1); } }, '+'),
      ]),
      h('div', { class: 'pts-badge' }, [ptsEl, h('div', { class: 'lab' }, 'pts')]),
    ]));
  });

  // Quick "next hole" button — on the final hole there's nowhere to go, so show
  // a plain end-of-round hint instead of a (dead-looking) button.
  box.appendChild(cur === N
    ? h('div', { class: 'hole-end' }, 'Last hole')
    : h('button', { class: 'btn secondary', style: 'margin-top:6px',
        onclick: () => setHole(cur + 1) }, 'Next hole  ›'));

  return box;
}

function refreshLeader(r) {
  const lb = leaderboard(r);
  const rows = document.querySelectorAll('.leader .leader-row');
  // Simple approach: re-render the leader section in place.
  const leader = document.querySelector('.leader');
  if (!leader) return;
  leader.innerHTML = '';
  lb.forEach((row, i) => {
    const el = h('div', { class: 'leader-row' + (i === 0 ? ' first' : '') }, [
      h('div', { class: 'pos' }, String(i + 1)),
      h('div', { class: 'nm' }, row.player.name),
      h('div', null, [
        h('span', { class: 'pts' }, String(row.points)),
        h('span', { class: 'thru' }, `  thru ${row.played}`),
      ]),
    ]);
    leader.appendChild(el);
  });
}

function scorecardTable(r) {
  const N = r.holes.length;
  const wrap = h('div', { class: 'scroll-x' });
  const tbl = h('table', { class: 'card-tbl' });

  // Head
  const thead = h('thead');
  const hr = h('tr');
  hr.appendChild(h('th', { class: 'hole-col' }, 'Hole'));
  r.players.forEach(p => hr.appendChild(h('th', null, [
    h('div', { class: 'ph-name' }, p.name.split(' ')[0]),
    h('div', { class: 'ph-hcp' }, `HCP ${p.handicap}`),
  ])));
  thead.appendChild(hr);
  tbl.appendChild(thead);

  const tbody = h('tbody');
  r.holes.forEach(hole => {
    const tr = h('tr');
    tr.appendChild(h('td', { class: 'hole-col' }, `${hole.index} · par ${hole.par}`));
    r.players.forEach(p => {
      const g = r.scores[p.id]?.[hole.index];
      const sr = strokesReceived(p.handicap, hole.si, N);
      const pts = holePoints(g ?? null, hole.par, sr);
      tr.appendChild(h('td', null, g == null
        ? h('span', { class: 'dim' }, '–')
        : h('span', null, [h('span', { class: 'g' }, String(g)), h('span', { class: 'pt ' + ptsClass(pts) }, ` (${pts})`)])));
    });
    tbody.appendChild(tr);
  });

  // Totals — points, with a pace delta vs 2 pts/hole (18 per 9 = playing to
  // handicap). e.g. 5 pts after 3 holes shows (-1): one point behind pace.
  const tot = h('tr', { class: 'tot' });
  tot.appendChild(h('td', { class: 'hole-col' }, 'Points'));
  r.players.forEach(p => {
    const t = playerTotals(r, p);
    let pace = null;
    if (t.played > 0) {
      const delta = t.points - 2 * t.played;
      const cls = delta < 0 ? 'behind' : delta > 0 ? 'ahead' : 'even';
      const txt = delta === 0 ? 'E' : delta > 0 ? '+' + delta : String(delta);
      pace = h('span', { class: 'pace ' + cls }, ` (${txt})`);
    }
    tot.appendChild(h('td', null, [String(t.points), pace]));
  });
  tbody.appendChild(tot);

  const totG = h('tr', { class: 'tot' });
  totG.appendChild(h('td', { class: 'hole-col' }, 'Gross'));
  r.players.forEach(p => {
    const t = playerTotals(r, p);
    totG.appendChild(h('td', null, String(t.gross)));
  });
  tbody.appendChild(totG);

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

function screenRoundMenu() {
  const r = currentRound();
  if (!r) return screenHome();
  const content = h('div', { class: 'content' }, [
    h('div', { class: 'card' }, [
      h('div', { class: 'section-label' }, 'Round'),
      h('div', { style: 'font-weight:650;font-size:18px;margin-bottom:4px' }, r.name || 'Round'),
      h('div', { class: 'dim' }, `${fmtDate(r.date)} · ${r.holes.length} holes · ${r.players.length} players`),
    ]),
    h('button', { class: 'btn secondary', style: 'margin-bottom:12px', onclick: () => go({ name: 'round', roundId: r.id }) }, 'Back to scoring'),
    h('button', { class: 'btn danger', onclick: () => {
      if (confirm(`Delete "${r.name || 'this round'}"? This cannot be undone.`)) {
        state.rounds = state.rounds.filter(x => x.id !== r.id);
        save();
        go({ name: 'home' });
      }
    } }, 'Delete round'),
  ]);
  return h('div', null, [
    topbar('Round options', { back: () => go({ name: 'round', roundId: r.id }) }),
    content,
  ]);
}

/* ----------------------------- render ----------------------------- */

function render() {
  const root = document.getElementById('app');
  let screen;
  switch (state.view.name) {
    case 'setup': screen = screenSetup(); break;
    case 'round': screen = screenRound(); break;
    case 'roundMenu': screen = screenRoundMenu(); break;
    case 'home':
    default: screen = screenHome(); break;
  }
  root.replaceChildren(screen);
}

render();

/* ----------------------------- service worker ----------------------------- */
if ('serviceWorker' in navigator) {
  // When a new worker takes control (after an update), reload once so the
  // freshly-deployed assets are shown without a manual refresh.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Check for a new version on launch and whenever the app regains focus
      // (e.g. reopened from the home screen) — this is what makes it self-update.
      reg.update();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update();
      });
    }).catch(() => { /* offline is best-effort */ });
  });
}
