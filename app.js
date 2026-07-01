/* Golf Scorecard — a tiny client-side PWA.
 * No build step, no server. State lives in localStorage and is saved on every change.
 *
 * Scoring model (Stableford):
 *   - A player receives strokes spread across the holes by Stroke Index (SI).
 *   - courseHandicap = round(handicapIndex * slope / 113), halved for 9 holes.
 *   - strokesOnHole = floor(ch / holes) + (si <= (ch mod holes) ? 1 : 0)
 *     e.g. course handicap 36 over 18 holes -> 2 strokes on every hole.
 *   - net = gross - strokesReceived
 *   - points = max(0, par - net + 2)   (net par = 2 pts, net bogey = 1, net birdie = 3, ...)
 *
 * Courses (par/SI/slope) are the source of truth: a round reads them live via
 * holesFor()/teesFor(), so editing a course updates its existing scorecards.
 */

const STORE_KEY = 'golf.scorecard.v1';

// Tees a player can play off; each has its own slope on a course.
const TEES = [
  { key: 'yellow', label: 'Yellow', color: '#e0a400' },
  { key: 'red', label: 'Red', color: '#dc2626' },
];
const DEFAULT_TEE = TEES[0].key;
function teeInfo(key) { return TEES.find(t => t.key === key) || TEES[0]; }
function emptyTees() { return { yellow: { slope: 113 }, red: { slope: 113 } }; }

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
if (!state.rounds) state.rounds = [];
migrateState();

// Bring older saved data up to the current shape: per-tee { slope } on
// courses and rounds, and a tee on every player.
function migrateState() {
  const legacyTees = (obj) => {
    const y = obj.tees?.yellow?.slope ?? obj.slopes?.yellow ?? obj.slope ?? 113;
    const r = obj.tees?.red?.slope ?? obj.slopes?.red ?? obj.slope ?? 113;
    return { yellow: { slope: y }, red: { slope: r } };
  };
  state.courses.forEach(c => { if (!c.tees) c.tees = legacyTees(c); });
  state.rounds.forEach(r => {
    if (!r.tees) r.tees = legacyTees(r);
    r.players.forEach(p => { if (!p.tee) p.tee = DEFAULT_TEE; });
  });
}

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

// Course handicap = the strokes a player plays off this tee: the handicap index
// scaled by the tee's slope (113 = neutral), halved for a 9-hole round.
function courseHandicap(handicapIndex, holesCount, slope) {
  const hiFull = Number(handicapIndex) || 0;
  const hi = holesCount === 9 ? hiFull / 2 : hiFull;
  const s = Number(slope) || 113;
  return Math.round(hi * (s / 113));
}

// Slope ratings run 55–155; 113 is the neutral value (no adjustment).
function clampSlope(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(155, Math.max(55, n)) : 113;
}

function strokesReceived(handicapIndex, si, holesCount, slope) {
  const ph = courseHandicap(handicapIndex, holesCount, slope);
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

// A round reads its par/SI/slope live from the linked course so edits to the
// course (layout or slope) show up on existing scorecards. Falls back to the
// round's own frozen copy when there is no course (or it was deleted).
function roundCourse(round) {
  return round.courseId ? state.courses.find(c => c.id === round.courseId) : null;
}
function holesFor(round) {
  const c = roundCourse(round);
  return (c && c.holes) || round.holes;
}
function teesFor(round) {
  const c = roundCourse(round);
  return (c && c.tees) || round.tees || emptyTees();
}
// The { slope } a given player plays off, based on their tee.
function teeDataForPlayer(round, player) {
  const t = teesFor(round);
  return t[player.tee] || t[DEFAULT_TEE] || { slope: 113 };
}
// Course handicap for a player on this round (slope of their tee).
function playerCourseHandicap(round, player) {
  const holes = holesFor(round);
  const { slope } = teeDataForPlayer(round, player);
  return courseHandicap(player.handicap, holes.length, slope);
}

function playerTotals(round, player) {
  const holes = holesFor(round);
  const { slope } = teeDataForPlayer(round, player);
  let points = 0, gross = 0, played = 0;
  for (const hole of holes) {
    const g = round.scores[player.id]?.[hole.index];
    if (g == null) continue;
    played++;
    gross += g;
    const sr = strokesReceived(player.handicap, hole.si, holes.length, slope);
    points += holePoints(g, hole.par, sr);
  }
  return { points, gross, played };
}

function leaderboard(round) {
  return round.players
    .map(p => ({ player: p, ...playerTotals(round, p) }))
    .sort((a, b) => b.points - a.points || a.gross - b.gross);
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

// Grow/shrink a holes array to `n`, keeping par/SI of holes that remain and
// clamping stroke indexes into range.
function resizeHoles(holes, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const ex = holes.find(hh => hh.index === i);
    out.push(ex ? { index: i, par: ex.par, si: Math.min(ex.si || i, n) } : { index: i, par: 4, si: i });
  }
  return out;
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

// Display name for a round: the course name, auto-numbered when more than one
// round is played on the same course the same day (2nd onwards gets " #N").
function roundLabel(round) {
  const base = round.courseName || 'Round';
  const sameDay = state.rounds
    .filter(r => r.date === round.date && (r.courseName || 'Round') === base)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const ordinal = sameDay.findIndex(r => r.id === round.id) + 1;
  return ordinal > 1 ? `${base} #${ordinal}` : base;
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
  const tab = state.view.tab === 'courses' ? 'courses' : 'rounds';
  const content = h('div', { class: 'content' });

  if (tab === 'rounds') {
    const rounds = [...state.rounds].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (rounds.length === 0) {
      content.appendChild(h('div', { class: 'empty' }, [
        h('div', { class: 'big' }, '⛳️'),
        h('div', null, 'No rounds yet.'),
        h('div', { class: 'dim', html: 'Tap <strong>New round</strong> to start scoring.' }),
      ]));
    } else {
      rounds.forEach(r => content.appendChild(roundRow(r)));
    }
  } else {
    const courses = [...state.courses].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (courses.length === 0) {
      content.appendChild(h('div', { class: 'empty' }, [
        h('div', { class: 'big' }, '🏌️'),
        h('div', null, 'No courses yet.'),
        h('div', { class: 'dim', html: 'Tap <strong>New course</strong> to add one.' }),
      ]));
    } else {
      courses.forEach(c => content.appendChild(courseRow(c)));
    }
  }

  const tabs = h('div', { class: 'home-tabs' }, [
    h('button', { class: 'home-tab' + (tab === 'rounds' ? ' on' : ''), onclick: () => go({ name: 'home', tab: 'rounds' }) }, 'My Rounds'),
    h('button', { class: 'home-tab' + (tab === 'courses' ? ' on' : ''), onclick: () => go({ name: 'home', tab: 'courses' }) }, 'Courses'),
  ]);

  const fab = tab === 'rounds'
    ? h('button', { class: 'btn', onclick: () => startNewRound() }, '+  New round')
    : h('button', { class: 'btn', onclick: () => newCourse() }, '+  New course');

  return h('div', null, [
    h('div', { class: 'topbar' }, tabs),
    content,
    h('div', { class: 'fab-bar' }, h('div', { class: 'inner' }, fab)),
  ]);
}

// A course in the Courses tab — tap to edit.
function courseRow(c) {
  const parTotal = (c.holes || []).reduce((s, hh) => s + (Number(hh.par) || 0), 0);
  const slopes = TEES.map(t => `${t.label[0]} ${c.tees?.[t.key]?.slope ?? 113}`).join(' · ');
  return h('div', { class: 'card tappable round-card', onclick: () => go({ name: 'course', courseId: c.id }) }, [
    h('div', { class: 'meta' }, [
      h('div', { class: 'title' }, c.name || 'Untitled course'),
      h('div', { class: 'sub' }, `${c.holesCount} holes · par ${parTotal} · slope ${slopes}`),
    ]),
    h('div', { class: 'chev' }, '›'),
  ]);
}

function newCourse() {
  const c = { id: uid(), name: '', holesCount: 18, tees: emptyTees(), holes: makeHoles(18, 'std'), updatedAt: Date.now() };
  state.courses.push(c);
  save();
  go({ name: 'course', courseId: c.id });
}

// A round in the list, swipeable left to reveal a delete (🗑) button.
function roundRow(r) {
  const REVEAL = 76;
  const lb = leaderboard(r);
  const top = lb[0];
  const thru = Math.max(...r.players.map(p => playerTotals(r, p).played), 0);

  const del = h('button', { class: 'swipe-delete', 'aria-label': 'Delete round', onclick: (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${roundLabel(r)}"? This cannot be undone.`)) {
      state.rounds = state.rounds.filter(x => x.id !== r.id);
      save();
      render();
    }
  } }, '🗑');

  const card = h('div', { class: 'card tappable round-card swipe-content' }, [
    h('div', { class: 'meta' }, [
      h('div', { class: 'title' }, roundLabel(r)),
      h('div', { class: 'sub' }, `${fmtDate(r.date)} · ${holesFor(r).length} holes · ${r.players.length} player${r.players.length > 1 ? 's' : ''}`),
    ]),
    top ? h('div', { class: 'lead' }, [
      h('strong', null, String(top.points)),
      h('span', null, `${esc(top.player.name)} · thru ${thru}`),
    ]) : null,
    h('div', { class: 'chev' }, '›'),
  ]);

  const wrap = h('div', { class: 'swipe-row' }, [del, card]);

  // Horizontal drag reveals the delete button; touch-action:pan-y lets the
  // browser keep handling vertical scroll.
  let startX = 0, startY = 0, dragging = false, moved = false, base = 0, curX = 0, open = false;
  const setX = (x) => { curX = x; card.style.transform = `translateX(${x}px)`; };
  card.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY; base = open ? -REVEAL : 0;
    card.style.transition = 'none';
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) { dragging = false; return; } // vertical scroll — let it be
      moved = true;
      card.setPointerCapture(e.pointerId);
    }
    setX(Math.max(-REVEAL, Math.min(0, base + dx)));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = '';
    if (!moved) return;                 // a tap — the click handler deals with it
    open = curX < -REVEAL / 2;
    setX(open ? -REVEAL : 0);
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
  card.addEventListener('click', (e) => {
    if (moved) { e.preventDefault(); return; }   // finished a drag, not a tap
    if (open) { open = false; card.style.transition = ''; setX(0); return; }
    go({ name: 'round', roundId: r.id, tab: 'card' });
  });
  return wrap;
}

function startNewRound() {
  // Prefill the roster from the most recent round so you don't re-enter
  // players every time; trim or edit them on the setup screen as needed.
  const last = [...state.rounds].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  const players = last && last.players.length
    ? last.players.map(p => ({ id: uid(), name: p.name, handicap: String(p.handicap), tee: p.tee || DEFAULT_TEE }))
    : [{ id: uid(), name: '', handicap: '', tee: DEFAULT_TEE }];

  // Seed a draft round in the setup screen.
  go({
    name: 'setup',
    draft: {
      id: uid(),
      date: new Date().toISOString().slice(0, 10),
      holesCount: 18,
      preset: 'flat',
      courseId: null,      // links to a saved course layout, if chosen
      courseName: '',      // name for selecting/creating a course
      tees: emptyTees(),   // per-tee { slope } for a newly-created course
      players,
    },
  });
}

function screenSetup() {
  const d = state.view.draft;
  const content = h('div', { class: 'content' });

  // Date + holes (the round name is derived from the course automatically)
  const card1 = h('div', { class: 'card' }, [
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
  // Per-tee slope (only relevant once there's a course). Editing a saved
  // course writes straight to it, so its scorecards recompute.
  if (selected || d.courseName.trim()) {
    const tees = selected ? (selected.tees || (selected.tees = emptyTees())) : d.tees;
    const touch = () => { if (selected) { selected.updatedAt = Date.now(); save(); } };
    courseCard.appendChild(h('div', { class: 'field', style: 'margin:12px 0 0' }, [
      h('span', { class: 'lbl' }, 'Slope per tee (55–155, 113 = neutral)'),
      h('div', { class: 'tee-ratings' }, TEES.map(t => {
        const td = tees[t.key] || (tees[t.key] = { slope: 113 });
        return h('div', { class: 'tee-rating' }, [
          h('span', { class: 'tee-dot', style: `background:${t.color}` }),
          h('span', { class: 'tee-name' }, t.label),
          h('input', { class: 'sl', type: 'number', inputmode: 'numeric', min: '55', max: '155', placeholder: 'slope',
            value: td.slope ?? 113,
            oninput: e => { td.slope = selected ? clampSlope(e.target.value) : e.target.value; touch(); } }),
        ]);
      })),
    ]));
  }
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
  playersCard.appendChild(h('div', { class: 'section-label' }, 'Players, handicaps & tees'));
  d.players.forEach((p, i) => {
    if (!p.tee) p.tee = DEFAULT_TEE;
    playersCard.appendChild(h('div', { class: 'player-entry' }, [
      h('div', { class: 'player-row' }, [
        h('input', { class: 'name', type: 'text', placeholder: `Player ${i + 1}`, value: p.name,
          oninput: e => { p.name = e.target.value; } }),
        h('input', { class: 'hcp' + (d.hcpError && String(p.handicap).trim() === '' ? ' invalid' : ''),
          type: 'number', inputmode: 'numeric', placeholder: 'HCP', value: p.handicap,
          oninput: e => { p.handicap = e.target.value; if (d.hcpError) d.hcpError = false; e.target.classList.remove('invalid'); } }),
        d.players.length > 1 ? h('button', { class: 'rm', onclick: () => { d.players.splice(i, 1); rerenderSetup(); } }, '×') : null,
      ]),
      h('div', { class: 'tee-row' }, TEES.map(t =>
        h('button', { class: 'tee-btn' + (p.tee === t.key ? ' on' : ''), style: `--tc:${t.color}`,
          onclick: () => { p.tee = t.key; rerenderSetup(); } }, [
          h('span', { class: 'tee-dot', style: `background:${t.color}` }),
          t.label,
        ]))),
    ]));
  });
  if (d.players.length < 4) {
    playersCard.appendChild(h('button', { class: 'btn ghost add-player', onclick: () => {
      d.players.push({ id: uid(), name: '', handicap: '', tee: DEFAULT_TEE }); rerenderSetup();
    } }, '+ Add player'));
  }
  playersCard.appendChild(h('div', { class: 'hint', style: 'margin-bottom:0' },
    'Handicap + the tee’s slope set how many strokes each player gets. e.g. course handicap 36 over 18 holes = 2 strokes a hole, so a 6 on a par 4 scores 2 points.'));

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
    tee: p.tee || DEFAULT_TEE,
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
    holes = c.holes.map(hh => ({ ...hh })); // frozen fallback if the course is later deleted
    courseName = c.name;
  } else {
    holes = makeHoles(d.holesCount, d.preset);
    if (typed) {
      const tees = {};
      TEES.forEach(t => {
        const src = d.tees[t.key] || {};
        tees[t.key] = { slope: clampSlope(src.slope) };
      });
      const c = {
        id: uid(), name: typed, holesCount: d.holesCount, tees,
        holes: holes.map(hh => ({ ...hh })), updatedAt: Date.now(),
      };
      state.courses.push(c);
      courseId = c.id;
      courseName = c.name;
    }
  }
  const linkedCourse = courseId ? state.courses.find(c => c.id === courseId) : null;
  const teesSnapshot = linkedCourse
    ? JSON.parse(JSON.stringify(linkedCourse.tees))
    : emptyTees();

  const round = {
    id: d.id,
    date: d.date,
    courseId: courseId || null,
    courseName,
    holes,
    tees: teesSnapshot,
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
    topbar(roundLabel(r), { back: () => go({ name: 'home' }) }),
    content,
  ]);
}

function holeEntry(r) {
  const holes = holesFor(r);
  const N = holes.length;
  let cur = Math.min(Math.max(r.currentHole || 1, 1), N);
  const hole = holes[cur - 1];
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
  // editing is one-tap on mobile and never loses focus. `hole` is the linked
  // course's own object (via holesFor), so edits persist to the course and
  // show up on every scorecard for it.
  function commitHoleMeta() {
    r.updatedAt = Date.now();
    const c = roundCourse(r);
    if (c) c.updatedAt = Date.now();
    save();
    go(state.view);
  }
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

  // One row per player — strokes depend on the slope of that player's tee.
  r.players.forEach(p => {
    const tee = teeInfo(p.tee);
    const td = teeDataForPlayer(r, p);
    const g = r.scores[p.id][cur] ?? null;
    const sr = strokesReceived(p.handicap, hole.si, N, td.slope);
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
        h('div', { class: 'nm' }, [
          h('span', { class: 'tee-dot', style: `background:${tee.color}`, title: tee.label + ' tee' }),
          p.name,
        ]),
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
  const holes = holesFor(r);
  const N = holes.length;
  const wrap = h('div', { class: 'scroll-x' });
  const tbl = h('table', { class: 'card-tbl' });

  // Head — name, tee, handicap index, and total strokes received.
  const thead = h('thead');
  const hr = h('tr');
  hr.appendChild(h('th', { class: 'hole-col' }, 'Hole'));
  r.players.forEach(p => {
    const tee = teeInfo(p.tee);
    hr.appendChild(h('th', null, [
      h('div', { class: 'ph-name' }, [
        h('span', { class: 'tee-dot', style: `background:${tee.color}`, title: tee.label + ' tee' }),
        p.name.split(' ')[0],
      ]),
      h('div', { class: 'ph-hcp' }, `HCP ${p.handicap} +${playerCourseHandicap(r, p)} strokes`),
    ]));
  });
  thead.appendChild(hr);
  tbl.appendChild(thead);

  const tbody = h('tbody');
  holes.forEach(hole => {
    const tr = h('tr');
    tr.appendChild(h('td', { class: 'hole-col' }, `${hole.index} · par ${hole.par}`));
    r.players.forEach(p => {
      const g = r.scores[p.id]?.[hole.index];
      const td = teeDataForPlayer(r, p);
      const sr = strokesReceived(p.handicap, hole.si, N, td.slope);
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

// Course editor — name, hole count, per-tee slope, and per-hole par + SI.
// Edits write straight to the course (and save), so linked scorecards recompute.
function screenCourse() {
  const c = state.courses.find(x => x.id === state.view.courseId);
  if (!c) return screenHome();
  if (!c.tees) c.tees = emptyTees();
  const touch = () => { c.updatedAt = Date.now(); save(); };

  const content = h('div', { class: 'content' });

  // Name + hole count
  content.appendChild(h('div', { class: 'card' }, [
    h('label', { class: 'field' }, [
      h('span', { class: 'lbl' }, 'Course name'),
      h('input', { type: 'text', placeholder: 'e.g. Pine Hills', value: c.name,
        oninput: e => { c.name = e.target.value; touch(); } }),
    ]),
    h('label', { class: 'field', style: 'margin-bottom:0' }, [
      h('span', { class: 'lbl' }, 'Holes'),
      h('div', { class: 'seg' }, [9, 18].map(n =>
        h('button', { class: c.holesCount === n ? 'on' : '', onclick: () => {
          if (c.holesCount === n) return;
          c.holesCount = n; c.holes = resizeHoles(c.holes, n); touch(); render();
        } }, String(n)))),
    ]),
  ]));

  // Slope per tee
  content.appendChild(h('div', { class: 'card' }, [
    h('div', { class: 'section-label' }, 'Slope per tee (55–155, 113 = neutral)'),
    h('div', { class: 'tee-ratings' }, TEES.map(t => {
      const td = c.tees[t.key] || (c.tees[t.key] = { slope: 113 });
      return h('div', { class: 'tee-rating' }, [
        h('span', { class: 'tee-dot', style: `background:${t.color}` }),
        h('span', { class: 'tee-name' }, t.label),
        h('input', { class: 'sl', type: 'number', inputmode: 'numeric', min: '55', max: '155', placeholder: 'slope',
          value: td.slope ?? 113, oninput: e => { td.slope = clampSlope(e.target.value); touch(); } }),
      ]);
    })),
  ]));

  // Per-hole par + SI
  const holesCard = h('div', { class: 'card' });
  holesCard.appendChild(h('div', { class: 'section-label' }, 'Par & stroke index'));
  holesCard.appendChild(h('div', { class: 'hole-edit head' }, [
    h('span', null, 'Hole'), h('span', null, 'Par'), h('span', null, 'SI'),
  ]));
  const N = c.holes.length;
  c.holes.forEach(hole => {
    // Par stepper updates its value in place (no full re-render, keeps scroll).
    const parVal = h('span', { class: 'v' }, String(hole.par));
    const parStep = h('div', { class: 'parstep' }, [
      h('button', { onclick: () => { hole.par = Math.max(1, hole.par - 1); parVal.textContent = String(hole.par); touch(); } }, '−'),
      parVal,
      h('button', { onclick: () => { hole.par = Math.min(7, hole.par + 1); parVal.textContent = String(hole.par); touch(); } }, '+'),
    ]);
    const siInput = h('input', { class: 'si-input', type: 'number', inputmode: 'numeric', min: '1', max: String(N),
      value: hole.si, oninput: e => {
        let v = parseInt(e.target.value, 10);
        if (Number.isFinite(v)) { hole.si = Math.min(N, Math.max(1, v)); touch(); }
      } });
    holesCard.appendChild(h('div', { class: 'hole-edit' }, [
      h('span', { class: 'hno' }, String(hole.index)), parStep, siInput,
    ]));
  });
  content.appendChild(holesCard);

  content.appendChild(h('button', { class: 'btn danger', onclick: () => {
    if (confirm(`Delete course "${c.name || 'Untitled'}"? Rounds already played keep their own copy.`)) {
      state.courses = state.courses.filter(x => x.id !== c.id);
      save();
      go({ name: 'home', tab: 'courses' });
    }
  } }, 'Delete course'));

  return h('div', null, [
    topbar(c.name || 'Course', { back: () => go({ name: 'home', tab: 'courses' }) }),
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
    case 'course': screen = screenCourse(); break;
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
