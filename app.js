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

// Tees a player can play off; each has its own slope + course rating on a course.
const TEES = [
  { key: 'yellow', label: 'Yellow', color: '#e0a400' },
  { key: 'red', label: 'Red', color: '#dc2626' },
];
const DEFAULT_TEE = TEES[0].key;
function teeInfo(key) { return TEES.find(t => t.key === key) || TEES[0]; }
function emptyTees() { return { yellow: { slope: 113, cr: null }, red: { slope: 113, cr: null } }; }
// Course rating is a decimal (e.g. 22.7); null/blank means "unknown" (skip the CR term).
function parseCR(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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
seedCatalog();

// Bring older saved data up to the current shape: per-tee { slope } on
// courses and rounds, and a tee on every player.
function migrateState() {
  const legacyTees = (obj) => {
    const y = obj.tees?.yellow?.slope ?? obj.slopes?.yellow ?? obj.slope ?? 113;
    const r = obj.tees?.red?.slope ?? obj.slopes?.red ?? obj.slope ?? 113;
    return {
      yellow: { slope: y, cr: obj.tees?.yellow?.cr ?? null },
      red: { slope: r, cr: obj.tees?.red?.cr ?? null },
    };
  };
  state.courses.forEach(c => { if (!c.tees) c.tees = legacyTees(c); });
  state.rounds.forEach(r => {
    if (!r.tees) r.tees = legacyTees(r);
    r.players.forEach(p => { if (!p.tee) p.tee = DEFAULT_TEE; });
  });
}

// Seed the bundled catalog (courses.js -> globalThis.BUNDLED_COURSES) into the
// saved course list. Each bundled course is added at most once (tracked in
// state.seededCourses), so deleting one doesn't bring it back and courses added
// to the bundle in a later release still appear. Seeded courses are ordinary
// editable courses tagged source:'bundled'.
function seedCatalog() {
  const bundled = globalThis.BUNDLED_COURSES;
  if (!Array.isArray(bundled)) return;
  if (!state.seededCourses) state.seededCourses = [];
  let changed = false;
  for (const raw of bundled) {
    const nc = normalizeImportedCourse(raw);
    if (!nc) continue;
    const key = nc.name.toLowerCase() + '|' + nc.holesCount;
    if (state.seededCourses.includes(key)) continue;   // seeded before — respect deletions/edits
    state.seededCourses.push(key);
    const dupe = state.courses.some(c => (c.name || '').toLowerCase() + '|' + c.holesCount === key);
    if (!dupe) state.courses.push({ id: uid(), ...nc, source: 'bundled', updatedAt: Date.now() });
    changed = true;
  }
  if (changed) save();
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

// Course handicap (WHS) = the strokes a player plays off this tee: HI scaled by
// the tee's slope (113 = neutral, HI halved for 9 holes), plus the (CR - par)
// term when a course rating is known.  CH = round( HI_used * slope/113 + (CR-par) )
function courseHandicap(handicapIndex, holesCount, slope, courseRating, par) {
  const hiFull = Number(handicapIndex) || 0;
  const hi = holesCount === 9 ? hiFull / 2 : hiFull;
  const s = Number(slope) || 113;
  let ch = hi * (s / 113);
  const cr = parseCR(courseRating);
  const p = Number(par);
  if (cr != null && Number.isFinite(p)) ch += cr - p;
  return Math.round(ch);
}

// Slope ratings run 55–155; 113 is the neutral value (no adjustment).
function clampSlope(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(155, Math.max(55, n)) : 113;
}

function strokesReceived(handicapIndex, si, holesCount, slope, courseRating, par) {
  const ph = courseHandicap(handicapIndex, holesCount, slope, courseRating, par);
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
// The { slope, cr } a given player plays off, based on their tee.
function teeDataForPlayer(round, player) {
  const t = teesFor(round);
  return t[player.tee] || t[DEFAULT_TEE] || { slope: 113, cr: null };
}
function parFor(round) {
  return holesFor(round).reduce((s, hh) => s + (Number(hh.par) || 0), 0);
}
// Course handicap for a player on this round (slope + CR of their tee).
function playerCourseHandicap(round, player) {
  const holes = holesFor(round);
  const { slope, cr } = teeDataForPlayer(round, player);
  return courseHandicap(player.handicap, holes.length, slope, cr, parFor(round));
}

function playerTotals(round, player) {
  const holes = holesFor(round);
  const par = parFor(round);
  const { slope, cr } = teeDataForPlayer(round, player);
  let points = 0, gross = 0, played = 0;
  for (const hole of holes) {
    const g = round.scores[player.id]?.[hole.index];
    if (g == null) continue;
    played++;
    gross += g;
    const sr = strokesReceived(player.handicap, hole.si, holes.length, slope, cr, par);
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

/* ----------------------------- catalog ----------------------------- */

// Normalise one bundled/imported course object into the native saved-course
// shape. Lenient: blank/invalid fields fall back to sensible defaults, slope
// defaults to 113 (neutral). Optional location/access/city/region/greenFee/
// maxHcp and per-hole length pass through for the course list and filters.
// Returns null when the object has no usable 9- or 18-hole layout.
function normalizeImportedCourse(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = Array.isArray(raw.holes) ? raw.holes : null;
  if (!src || (src.length !== 9 && src.length !== 18)) return null;
  const N = src.length;
  const holes = [];
  for (let i = 1; i <= N; i++) {
    const hh = src.find(x => Number(x?.index) === i) || src[i - 1] || {};
    let par = Math.round(Number(hh.par));
    if (!Number.isFinite(par)) par = 4;
    let si = Math.round(Number(hh.si));
    if (!Number.isFinite(si)) si = i;
    const hole = { index: i, par: Math.min(7, Math.max(1, par)), si: Math.min(N, Math.max(1, si)) };
    const ly = hh.len?.yellow, lr = hh.len?.red;   // null-guarded: Number(null) is 0, not absent
    const lyN = ly == null ? NaN : Number(ly), lrN = lr == null ? NaN : Number(lr);
    if (Number.isFinite(lyN) || Number.isFinite(lrN)) {
      hole.len = { yellow: Number.isFinite(lyN) ? lyN : null, red: Number.isFinite(lrN) ? lrN : null };
    }
    holes.push(hole);
  }
  const tees = {};
  TEES.forEach(t => {
    const s = raw.tees?.[t.key]?.slope;
    tees[t.key] = { slope: (s == null || s === '') ? 113 : clampSlope(s), cr: parseCR(raw.tees?.[t.key]?.cr) };
  });
  const name = (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : 'Imported course';
  const course = { name, holesCount: N, tees, holes };
  // Optional metadata, kept for the upcoming distance / pay-and-play filters.
  const rl = raw.location;
  if (rl && rl.lat != null && rl.lng != null && Number.isFinite(Number(rl.lat)) && Number.isFinite(Number(rl.lng))) {
    course.location = { lat: Number(rl.lat), lng: Number(rl.lng) };
  }
  // Access is per-course: pay-and-play (walk-up, no membership), greenfee
  // (members' club, visitors welcome by paying), or members (private). Legacy
  // "mixed" (from clubs that run several courses) maps to greenfee.
  const access = raw.access === 'mixed' ? 'greenfee' : raw.access;
  if (['pay-and-play', 'greenfee', 'members'].includes(access)) course.access = access;
  if (typeof raw.city === 'string' && raw.city.trim()) course.city = raw.city.trim();
  if (typeof raw.region === 'string' && raw.region.trim()) course.region = raw.region.trim();
  if (raw.maxHcp != null && Number.isFinite(Number(raw.maxHcp))) course.maxHcp = Number(raw.maxHcp);
  if (raw.greenFee && typeof raw.greenFee === 'object') {
    const gf = { currency: typeof raw.greenFee.currency === 'string' ? raw.greenFee.currency : 'SEK' };
    const mn = raw.greenFee.min, mx = raw.greenFee.max;   // null-guarded like above
    if (mn != null && Number.isFinite(Number(mn))) gf.min = Number(mn);
    if (mx != null && Number.isFinite(Number(mx))) gf.max = Number(mx);
    if (gf.min != null || gf.max != null) course.greenFee = gf;
  }
  return course;
}

/* ----------------------------- location ----------------------------- */

// Great-circle distance in km between two {lat,lng} points.
function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Ask the browser for the user's location, cache it, and re-render. onDone runs
// on success before the render (used to also flip the "near me" filter on).
function requestLocation(onDone) {
  if (!navigator.geolocation) { toast('Location isn’t available on this device'); return; }
  toast('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    pos => { state.userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude }; save(); if (onDone) onDone(); render(); },
    () => toast('Could not get your location'),
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
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
    if (state.courses.length === 0) {
      content.appendChild(h('div', { class: 'empty' }, [
        h('div', { class: 'big' }, '🏌️'),
        h('div', null, 'No courses yet.'),
        h('div', { class: 'dim', html: 'Tap <strong>New course</strong> to add one.' }),
      ]));
    } else {
      content.appendChild(coursesBrowser());
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

// Courses tab filter state — session-only (resets on reload).
let courseFilter = { q: '', fav: false, pay: false, near: false, region: '', maxFee: 0 };

// Does a course pass the active filters?
function courseMatches(c) {
  const f = courseFilter;
  if (f.fav && !c.favorite) return false;
  if (f.pay && c.access !== 'pay-and-play') return false;
  if (f.region && c.region !== f.region) return false;
  if (f.maxFee && !(c.greenFee && c.greenFee.min != null && c.greenFee.min <= f.maxFee)) return false;
  if (f.q) {
    const hay = [c.name, c.city, c.region].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

// Sort key: favourites first, then nearest (when "near me" is on) else by name.
function sortCourses(rows, loc) {
  return rows.sort((a, b) => {
    const fav = (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
    if (fav) return fav;
    if (courseFilter.near && loc) {
      const da = a.location ? haversineKm(loc, a.location) : Infinity;
      const db = b.location ? haversineKm(loc, b.location) : Infinity;
      if (da !== db) return da - db;
    }
    return (a.name || '').localeCompare(b.name || '');
  });
}

// The Courses tab: search + filters over the (bundled + user) course list.
function coursesBrowser() {
  const regions = [...new Set(state.courses.map(c => c.region).filter(Boolean))].sort();
  const list = h('div', { class: 'course-list' });

  function renderList() {
    const loc = (courseFilter.near && state.userLoc) ? state.userLoc : null;
    const rows = sortCourses(state.courses.filter(courseMatches), loc);
    list.replaceChildren();
    if (!rows.length) { list.appendChild(h('div', { class: 'empty small' }, 'No courses match those filters.')); return; }
    rows.forEach(c => list.appendChild(courseRow(c, loc)));
  }

  function chip(label, isOn, onToggle) {
    const b = h('button', { class: 'chip' + (isOn() ? ' on' : ''),
      onclick: () => { onToggle(() => { b.className = 'chip' + (isOn() ? ' on' : ''); renderList(); }); } }, label);
    return b;
  }

  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search course, city, region…',
    value: courseFilter.q, oninput: e => { courseFilter.q = e.target.value; renderList(); } });

  const favChip = chip('★ Favourites', () => courseFilter.fav, done => { courseFilter.fav = !courseFilter.fav; done(); });
  const payChip = chip('Pay & play', () => courseFilter.pay, done => { courseFilter.pay = !courseFilter.pay; done(); });
  const nearChip = chip('📍 Near me', () => courseFilter.near && !!state.userLoc, done => {
    if (courseFilter.near) { courseFilter.near = false; done(); return; }
    if (state.userLoc) { courseFilter.near = true; done(); }
    else requestLocation(() => { courseFilter.near = true; });   // re-renders whole screen on success
  });

  const regionSel = h('select', { class: 'filter-sel', onchange: e => { courseFilter.region = e.target.value; renderList(); } },
    [h('option', { value: '' }, 'All regions'), ...regions.map(r =>
      h('option', { value: r, selected: courseFilter.region === r || undefined }, r))]);
  const feeSel = h('select', { class: 'filter-sel', onchange: e => { courseFilter.maxFee = Number(e.target.value); renderList(); } },
    [[0, 'Any price'], [500, '≤ 500 kr'], [800, '≤ 800 kr'], [1000, '≤ 1000 kr']].map(([v, l]) =>
      h('option', { value: v, selected: courseFilter.maxFee === v || undefined }, l)));

  renderList();
  return h('div', null, [
    h('div', { class: 'course-controls' }, [
      search,
      h('div', { class: 'chips filter-chips' }, [favChip, payChip, nearChip]),
      h('div', { class: 'filter-selects' }, [regionSel, feeSel]),
    ]),
    list,
  ]);
}

// A course in the Courses tab — favourite star, tags, optional distance; tap to edit.
function courseRow(c, loc) {
  const parTotal = (c.holes || []).reduce((s, hh) => s + (Number(hh.par) || 0), 0);
  const sub = [c.city, `${c.holesCount} holes`, `par ${parTotal}`].filter(Boolean).join(' · ');

  const tags = [];
  if (c.access === 'pay-and-play') tags.push(h('span', { class: 'tag pay' }, 'Pay & play'));
  else if (c.access === 'greenfee') tags.push(h('span', { class: 'tag' }, 'Greenfee'));
  if (c.greenFee && c.greenFee.min != null) {
    const gf = c.greenFee.max && c.greenFee.max !== c.greenFee.min ? `${c.greenFee.min}–${c.greenFee.max}` : `${c.greenFee.min}`;
    tags.push(h('span', { class: 'tag' }, `${gf} kr`));
  }
  if (loc && c.location) tags.push(h('span', { class: 'tag dist' }, `${haversineKm(loc, c.location).toFixed(1)} km`));

  const star = h('button', { class: 'star' + (c.favorite ? ' on' : ''), 'aria-label': 'Favourite course',
    onclick: (e) => { e.stopPropagation(); c.favorite = !c.favorite; c.updatedAt = Date.now(); save(); render(); } },
    c.favorite ? '★' : '☆');

  return h('div', { class: 'card tappable round-card course-row', onclick: () => go({ name: 'course', courseId: c.id }) }, [
    star,
    h('div', { class: 'meta' }, [
      h('div', { class: 'title' }, c.name || 'Untitled course'),
      h('div', { class: 'sub' }, sub),
      tags.length ? h('div', { class: 'tags' }, tags) : null,
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

  // Seed a draft round in the setup screen. A course must be picked (or created)
  // before the round can start — no more "create the course as you play".
  go({
    name: 'setup',
    draft: {
      id: uid(),
      date: new Date().toISOString().slice(0, 10),
      courseId: null,      // the chosen saved course (required to start)
      players,
    },
  });
}

function screenSetup() {
  const d = state.view.draft;
  const content = h('div', { class: 'content' });

  // Date only — hole count now comes from the chosen course.
  const card1 = h('div', { class: 'card' }, [
    h('label', { class: 'field', style: 'margin-bottom:0' }, [
      h('span', { class: 'lbl' }, 'Date'),
      h('input', { type: 'date', value: d.date, oninput: e => { d.date = e.target.value; } }),
    ]),
  ]);

  // Course — select-only. A round must be backed by a saved course; if it isn't
  // there yet, create it (or import a pack on the Courses tab) first.
  // Favourites first, then alphabetical, so starred courses are quick to pick.
  const savedCourses = [...state.courses].sort((a, b) =>
    ((b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)) || (a.name || '').localeCompare(b.name || ''));
  const selected = d.courseId ? state.courses.find(c => c.id === d.courseId) : null;
  const courseCard = h('div', { class: 'card' });
  courseCard.appendChild(h('div', { class: 'section-label' }, 'Course'));
  if (savedCourses.length) {
    const chips = h('div', { class: 'chips' });
    savedCourses.forEach(c => {
      chips.appendChild(h('button', {
        class: 'chip' + (d.courseId === c.id ? ' on' : ''),
        onclick: () => { d.courseId = d.courseId === c.id ? null : c.id; rerenderSetup(); },
      }, `${c.favorite ? '★ ' : ''}${c.name || 'Untitled'} · ${c.holesCount}h · par ${c.holes.reduce((s, hh) => s + hh.par, 0)}`));
    });
    courseCard.appendChild(chips);
  } else {
    courseCard.appendChild(h('div', { class: 'hint', style: 'margin:0 2px' },
      'No saved courses yet. Create one (or import a pack on the Courses tab) to start a round.'));
  }
  courseCard.appendChild(h('button', { class: 'btn ghost setup-create', onclick: () => createCourseFromSetup() }, '+ Create course'));
  courseCard.appendChild(h('div', { class: 'hint', style: 'margin:10px 2px 0' },
    selected
      ? `Playing "${selected.name || 'Untitled'}" — ${selected.holesCount} holes, par ${selected.holes.reduce((s, hh) => s + hh.par, 0)}. Edit its pars/slope on the Courses tab.`
      : 'Pick a course above to start, or create one.'));

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

// Create a fresh course from the setup screen, then jump to the editor. The
// in-progress draft (date + roster) is stashed so returning re-selects the new
// course — see leaveCourse().
function createCourseFromSetup() {
  state.pendingDraft = state.view.draft;
  const c = { id: uid(), name: '', holesCount: 18, tees: emptyTees(), holes: makeHoles(18, 'std'), updatedAt: Date.now() };
  state.courses.push(c);
  save();
  go({ name: 'course', courseId: c.id, from: 'setup' });
}

function commitNewRound() {
  const d = state.view.draft;
  // A round must be backed by a saved course.
  const c = d.courseId ? state.courses.find(x => x.id === d.courseId) : null;
  if (!c) { toast('Pick or create a course first'); return; }

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

  const round = {
    id: d.id,
    date: d.date,
    courseId: c.id,
    courseName: c.name,
    holes: c.holes.map(hh => ({ ...hh })),          // frozen fallback if the course is later deleted
    tees: JSON.parse(JSON.stringify(c.tees || emptyTees())),
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

  // Par/SI are set per course (Courses tab), not mid-round — the header above
  // shows them; scoring reads them live via holesFor().

  // One row per player — strokes depend on the slope + CR of that player's tee.
  const par = parFor(r);
  r.players.forEach(p => {
    const tee = teeInfo(p.tee);
    const td = teeDataForPlayer(r, p);
    const g = r.scores[p.id][cur] ?? null;
    const sr = strokesReceived(p.handicap, hole.si, N, td.slope, td.cr, par);
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
  const par = parFor(r);
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
      const sr = strokesReceived(p.handicap, hole.si, N, td.slope, td.cr, par);
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

// Leaving the course editor: if we arrived from round setup, return there with
// this course preselected; otherwise go back to the Courses tab.
function leaveCourse(courseId) {
  if (state.view.from === 'setup' && state.pendingDraft) {
    const draft = state.pendingDraft;
    state.pendingDraft = null;
    draft.courseId = courseId;
    go({ name: 'setup', draft });
  } else {
    go({ name: 'home', tab: 'courses' });
  }
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

  // Info — metadata that came with the course (bundled/imported); read-only.
  const info = [];
  if (c.city || c.region) info.push(['Location', [c.city, c.region].filter(Boolean).join(', ')]);
  if (state.userLoc && c.location) info.push(['Distance', `${haversineKm(state.userLoc, c.location).toFixed(1)} km away`]);
  if (c.access) info.push(['Access', c.access === 'pay-and-play' ? 'Pay & play' : c.access === 'greenfee' ? 'Greenfee — guests welcome' : 'Members only']);
  if (c.greenFee && c.greenFee.min != null) {
    const gf = c.greenFee, range = gf.max && gf.max !== gf.min ? `${gf.min}–${gf.max}` : `${gf.min}`;
    info.push(['Green fee', `${range} ${gf.currency || 'SEK'}`]);
  }
  if (c.maxHcp != null) info.push(['Max handicap', String(c.maxHcp)]);
  const hasLen = t => c.holes.length && c.holes.every(hh => hh.len && hh.len[t] != null);
  if (hasLen('yellow') || hasLen('red')) {
    const tot = t => c.holes.reduce((s, hh) => s + (hh.len?.[t] || 0), 0);
    info.push(['Length', TEES.filter(t => hasLen(t.key)).map(t => `${t.label} ${tot(t.key)} m`).join(' · ')]);
  }
  if (info.length) {
    content.appendChild(h('div', { class: 'card info-list' }, [
      h('div', { class: 'section-label' }, 'Info'),
      ...info.map(([k, v]) => h('div', { class: 'info-row' }, [
        h('span', { class: 'k' }, k),
        h('span', { class: 'v' }, v),
      ])),
    ]));
  }

  // Slope + course rating per tee
  content.appendChild(h('div', { class: 'card' }, [
    h('div', { class: 'section-label' }, 'Tee slope (55–155) & course rating'),
    h('div', { class: 'tee-ratings' }, TEES.map(t => {
      const td = c.tees[t.key] || (c.tees[t.key] = { slope: 113, cr: null });
      return h('div', { class: 'tee-rating' }, [
        h('span', { class: 'tee-dot', style: `background:${t.color}` }),
        h('span', { class: 'tee-name' }, t.label),
        h('input', { class: 'sl', type: 'number', inputmode: 'numeric', min: '55', max: '155', placeholder: 'slope',
          value: td.slope ?? 113, oninput: e => { td.slope = clampSlope(e.target.value); touch(); } }),
        h('input', { class: 'cr', type: 'number', inputmode: 'decimal', step: '0.1', placeholder: 'CR',
          value: td.cr ?? '', oninput: e => { td.cr = parseCR(e.target.value); touch(); } }),
      ]);
    })),
    h('div', { class: 'hint', style: 'margin:10px 2px 0' },
      'Course rating is optional. Leave blank for slope-only; enter it (e.g. 22.7) to match official WHS points.'),
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
      if (state.view.from === 'setup' && state.pendingDraft) {
        const draft = state.pendingDraft; state.pendingDraft = null; draft.courseId = null;
        go({ name: 'setup', draft });
      } else {
        go({ name: 'home', tab: 'courses' });
      }
    }
  } }, 'Delete course'));

  return h('div', null, [
    topbar(c.name || 'Course', { back: () => leaveCourse(c.id) }),
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
