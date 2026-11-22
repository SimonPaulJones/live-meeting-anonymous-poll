'use strict';
// Live Poll: one page for voters and the host. It polls api.php about once a second.

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const NONVOTER_COLOR = '#b4b2aa';
const DEFAULT_OPTIONS = ['Yes', 'Maybe', 'No'];
const CHARTS = [['bar', 'Bar'], ['pie', 'Pie'], ['numbers', 'Numbers']];
const SHOWS = [['attendees', 'People here'], ['counts', 'Vote counts'], ['percent', 'Percentages'], ['nonvoters', 'Didn’t vote']];
const DEFAULT_PREFS = { live: false, chart: 'bar', show: { attendees: true, counts: true, percent: true, nonvoters: false } };
const POLL_MS = 1200;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------- storage (best effort; the page works without it) ----------
const store = {
  get(k, fallback) { try { const v = localStorage.getItem('livepoll.' + k); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
  set(k, v) { try { localStorage.setItem('livepoll.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('livepoll.' + k); } catch (e) {} },
};

function randomId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The room comes from the link (…/livepoll/<room>; old ?p=<room> links still work). Without one, the page is the
// host login, which creates a new room. A host's token for each of their rooms is kept in this browser; a host link
// (#host=…) brings it to another one.
const BASE = new URL('.', document.baseURI).href;
const room = ((location.pathname.match(/\/([a-f0-9]{16})$/) || [])[1]
  || (new URLSearchParams(location.search).get('p') || '').toLowerCase().replace(/[^a-f0-9]/g, '')).slice(0, 16);
const hashHost = location.hash.match(/host=([a-f0-9]{64})/);
if (room && hashHost) store.set('host.' + room, hashHost[1]);
// Short links need the server's rewrite (room.php); check once, otherwise use …/?p=<room>.
let shortLinks = store.get('shortLinks', null);
const roomUrl = (r) => BASE + (shortLinks ? r : '?p=' + r);
async function checkShortLinks(r) {
  try { shortLinks = (await fetch(BASE + r, { method: 'HEAD', cache: 'no-store' })).ok; } catch (e) { shortLinks = false; }
  store.set('shortLinks', shortLinks);
  if (state) render();
}
if (room && hashHost) history.replaceState(null, '', roomUrl(room));
if (room && /\/[a-f0-9]{16}$/.test(location.pathname)) { shortLinks = true; store.set('shortLinks', true); }
store.del('token'); // left over from the single-poll version
let token = room ? store.get('host.' + room, null) : null;
let clientId = store.get('client', null);
if (!clientId) { clientId = randomId(); store.set('client', clientId); }

let state = null;        // last view from the server
let ended = false;       // the room has been deleted or cleaned up
let setupOpen = false;   // host is preparing a new poll
let failures = 0;
let timer = null;

function voterLink() { return roomUrl(room); }
function hostLink() { return voterLink() + '#host=' + token; }

// ---------- server ----------
async function api(a, body) {
  const res = await fetch('api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ a, r: room, t: token, c: clientId }, body || {})),
    cache: 'no-store',
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 404 && a !== 'login') endRoom();
  return { ok: res.ok, status: res.status, data };
}

async function tick() {
  clearTimeout(timer);
  if (!room || ended) return;
  try {
    const r = await api('state');
    if (r.ok) { failures = 0; apply(r.data); }
    else if (r.status !== 404) failures++;
  } catch (e) { failures++; }
  $('conn').hidden = failures < 3;
  if (!ended) timer = setTimeout(tick, failures ? Math.min(5000, POLL_MS * (failures + 1)) : POLL_MS);
}

function apply(view) {
  if (!view || !view.role) return;
  state = view;
  render();
}

function endRoom() {
  ended = true;
  state = null;
  clearTimeout(timer);
  if (token) { store.del('host.' + room); if (store.get('lastRoom', null) === room) store.del('lastRoom'); token = null; }
  render();
}

window.addEventListener('pagehide', () => {
  if (room && !ended && navigator.sendBeacon) {
    navigator.sendBeacon('api.php', new Blob([JSON.stringify({ a: 'leave', r: room, t: token, c: clientId })], { type: 'text/plain' }));
  }
});
window.addEventListener('pageshow', (e) => { if (e.persisted) tick(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

// ---------- host login: creates a new room and goes to it ----------
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('pw').value.trim();
  if (!pw) return;
  $('login-err').textContent = '';
  try {
    const r = await api('login', { password: pw });
    if (!r.ok) { $('login-err').textContent = 'That password didn’t work. Try again.'; $('pw').select(); return; }
    store.set('host.' + r.data.room, r.data.token);
    store.set('lastRoom', r.data.room);
    await checkShortLinks(r.data.room);
    location.href = roomUrl(r.data.room);
  } catch (err) {
    $('login-err').textContent = 'Can’t reach the poll. Check your connection.';
  }
});
$('logout').addEventListener('click', () => {
  // Forget this room in this browser. The room itself stays until it's deleted or cleaned up.
  api('leave').catch(() => {});
  store.del('host.' + room);
  if (store.get('lastRoom', null) === room) store.del('lastRoom');
  location.href = BASE;
});

// ---------- rendering ----------
function show(id) {
  for (const s of ['login', 'ended', 'voter', 'admin']) $(s).hidden = s !== id;
}

function render() {
  $('logout').hidden = !token || ended;
  if (!room) {
    show('login');
    const last = store.get('lastRoom', null);
    $('last-room-p').hidden = !(last && store.get('host.' + last, null));
    if (last) $('last-room').href = roomUrl(last);
    setTimeout(() => $('pw').focus(), 0);
    return;
  }
  if (ended) { show('ended'); return; }
  if (!state) return;
  document.body.classList.toggle('is-admin', state.role === 'admin');
  if (state.role === 'admin') renderAdmin(); else renderVoter();
}

function items(view) {
  const p = view.poll;
  const list = p.options.map((label, i) => ({ label, count: view.results ? view.results.counts[i] : 0, color: COLORS[i % COLORS.length] }));
  if (p.show.nonvoters) list.push({ label: 'Didn’t vote', count: view.results ? view.results.nonvoters : 0, color: NONVOTER_COLOR, muted: true });
  return list;
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

function statsLine(view) {
  const p = view.poll;
  const parts = [];
  if (p.show.counts || !view.results) parts.push(plural(view.voted, 'vote', 'votes'));
  if (p.show.attendees && view.attendees != null) parts.push(plural(view.attendees, 'person', 'people') + ' here');
  return parts.join(' · ');
}

function valueText(it, total, show) {
  const pct = total ? Math.round((it.count / total) * 100) : 0;
  const parts = [];
  if (show.counts) parts.push(String(it.count));
  if (show.percent) parts.push(pct + '%');
  return parts.join(' · ');
}

// Draws results into `box`. Rebuilds only when the shape changes, so bars animate between updates.
function drawResults(box, view, withQuestion) {
  const p = view.poll;
  const list = items(view);
  const total = list.reduce((s, it) => s + it.count, 0);
  const key = [p.id, p.chart, withQuestion, p.show.nonvoters, p.question].join('|');
  if (box._key !== key) {
    box._key = key;
    box.innerHTML = '';
    if (withQuestion) box.appendChild(el('h1', 'question', p.question || 'Results'));
    box.appendChild(el('p', 'stats'));
    if (p.chart === 'pie') buildPie(box, list);
    else if (p.chart === 'numbers') buildNumbers(box, list);
    else buildBars(box, list);
  }
  box.querySelector('.stats').textContent = statsLine(view);
  if (p.chart === 'pie') updatePie(box, list, total, p.show);
  else if (p.chart === 'numbers') updateNumbers(box, list, total, p.show);
  else updateBars(box, list, total, p.show);
}

function buildBars(box, list) {
  const wrap = el('div', 'bars');
  list.forEach((it) => {
    const row = el('div', 'bar-item' + (it.muted ? ' muted-item' : ''));
    const plot = el('div', 'bar-plot');
    const fill = el('div', 'bar-fill');
    fill.style.background = it.color;
    plot.append(el('div', 'bar-val'), fill);
    row.append(plot, el('div', 'bar-label', it.label));
    wrap.appendChild(row);
  });
  box.appendChild(wrap);
}
function updateBars(box, list, total, show) {
  // the tallest column fills the chart; the rest are scaled to it
  const max = Math.max(1, ...list.map((it) => it.count));
  box.querySelectorAll('.bar-item').forEach((row, i) => {
    const it = list[i];
    const share = total ? (it.count / total) * 100 : 0;
    row.querySelector('.bar-val').textContent = valueText(it, total, show) || '\u00a0';
    row.querySelector('.bar-fill').style.height = `calc((100% - 2.2em) * ${it.count / max})`;
    row.title = `${it.label}: ${plural(it.count, 'vote', 'votes')} (${Math.round(share)}%)`;
  });
}

const SVGNS = 'http://www.w3.org/2000/svg';
function buildPie(box, list) {
  const wrap = el('div', 'pie-wrap');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 42 42');
  svg.setAttribute('class', 'pie');
  svg.setAttribute('role', 'img');
  const circle = (cls) => {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '21'); c.setAttribute('cy', '21'); c.setAttribute('r', '15.915');
    return c;
  };
  const ring = circle('pie-track');
  svg.appendChild(ring);
  list.forEach((it) => {
    const c = circle('pie-seg');
    c.style.stroke = it.color;
    const t = document.createElementNS(SVGNS, 'title');
    c.appendChild(t);
    svg.appendChild(c);
  });
  for (const cls of ['pie-total', 'pie-sub']) {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('class', cls);
    t.setAttribute('x', '21');
    t.setAttribute('y', cls === 'pie-total' ? '21.5' : '26');
    svg.appendChild(t);
  }
  const legend = el('ul', 'legend');
  list.forEach((it) => {
    const li = el('li', it.muted ? 'muted-item' : '');
    const sw = el('span', 'swatch');
    sw.style.background = it.color;
    li.append(sw, el('span', 'legend-label', it.label), el('span', 'legend-val'));
    legend.appendChild(li);
  });
  wrap.append(svg, legend);
  box.appendChild(wrap);
}
function updatePie(box, list, total, show) {
  const segs = box.querySelectorAll('.pie-seg');
  const nonzero = list.filter((it) => it.count > 0).length;
  const gap = nonzero > 1 ? 0.8 : 0;
  let start = 0;
  list.forEach((it, i) => {
    const share = total ? (it.count / total) * 100 : 0;
    const len = Math.max(0, share - (share > 0 ? gap : 0));
    segs[i].style.strokeDasharray = `${len} ${100 - len}`;
    segs[i].style.strokeDashoffset = String(25 - start - (share > 0 ? gap / 2 : 0));
    segs[i].querySelector('title').textContent = `${it.label}: ${plural(it.count, 'vote', 'votes')} (${Math.round(share)}%)`;
    start += share;
  });
  const votes = list.filter((it) => !it.muted).reduce((s, it) => s + it.count, 0);
  box.querySelector('.pie-total').textContent = show.counts ? String(votes) : '';
  box.querySelector('.pie-sub').textContent = show.counts ? (votes === 1 ? 'vote' : 'votes') : '';
  box.querySelectorAll('.legend li').forEach((li, i) => { li.querySelector('.legend-val').textContent = valueText(list[i], total, show); });
}

function buildNumbers(box, list) {
  const grid = el('div', 'numbers n' + Math.min(list.length, 4));
  list.forEach((it) => {
    const tile = el('div', 'num-tile' + (it.muted ? ' muted-item' : ''));
    tile.style.borderTopColor = it.color;
    tile.append(el('div', 'num-big'), el('div', 'num-label', it.label), el('div', 'num-sub'));
    grid.appendChild(tile);
  });
  box.appendChild(grid);
}
function updateNumbers(box, list, total, show) {
  box.querySelectorAll('.num-tile').forEach((tile, i) => {
    const it = list[i];
    const pct = (total ? Math.round((it.count / total) * 100) : 0) + '%';
    const usePct = show.percent && !show.counts;
    tile.querySelector('.num-big').textContent = usePct ? pct : String(it.count);
    tile.querySelector('.num-sub').textContent = show.percent && show.counts ? pct : '';
  });
}

// ---------- voter ----------
function renderVoter() {
  show('voter');
  const v = state;
  const p = v.poll;
  $('v-wait').hidden = !!p;
  $('v-poll').hidden = !p;
  if (!p) return;

  $('v-question').textContent = p.question || 'Cast your vote';
  const box = $('v-options');
  if (box._key !== p.id) {
    box._key = p.id;
    box.innerHTML = '';
    p.options.forEach((label, i) => {
      const b = el('button', 'vote-btn');
      b.type = 'button';
      const dot = el('span', 'dot');
      dot.style.background = COLORS[i % COLORS.length];
      b.append(dot, el('span', 'vote-label', label), el('span', 'tick'));
      b.style.setProperty('--c', COLORS[i % COLORS.length]);
      b.addEventListener('click', () => vote(i));
      box.appendChild(b);
    });
  }
  box.querySelectorAll('.vote-btn').forEach((b, i) => {
    b.classList.toggle('chosen', v.myVote === i);
    b.disabled = !p.open;
    b.setAttribute('aria-pressed', v.myVote === i ? 'true' : 'false');
  });
  $('v-note').textContent = !p.open ? 'Voting has closed.'
    : v.myVote == null ? 'Tap an answer. Your vote is anonymous.'
    : 'Vote counted, anonymously. You can change it until voting closes.';

  const showRes = !!v.results;
  $('v-results').hidden = !showRes;
  $('v-hidden').hidden = showRes;
  if (showRes) drawResults($('v-results'), v, false);
  else {
    const here = v.poll.show.attendees && v.attendees != null ? ' · ' + plural(v.attendees, 'person', 'people') + ' here' : '';
    $('v-hidden').textContent = 'Results will appear when the host reveals them. ' + plural(v.voted, 'vote', 'votes') + ' so far' + here + '.';
  }
}

async function vote(i) {
  const p = state.poll;
  if (!p || !p.open) return;
  state.myVote = i;
  renderVoter();
  try {
    const r = await api('vote', { pid: p.id, choice: i });
    if (r.data && r.data.role) apply(r.data);
  } catch (e) {}
}

// ---------- host ----------
function segmented(box, choices, onPick) {
  box.innerHTML = '';
  choices.forEach(([v, label]) => {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.v = v;
    b.addEventListener('click', () => onPick(v));
    box.appendChild(b);
  });
}
function setSeg(box, value) {
  box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(value)));
}
function toggles(box, onFlip) {
  box.innerHTML = '';
  SHOWS.forEach(([k, label]) => {
    const b = el('button', 'toggle', label);
    b.type = 'button';
    b.dataset.k = k;
    b.addEventListener('click', () => onFlip(k));
    box.appendChild(b);
  });
}
function setToggles(box, show) {
  box.querySelectorAll('.toggle').forEach((b) => {
    b.classList.toggle('on', !!show[b.dataset.k]);
    b.setAttribute('aria-pressed', show[b.dataset.k] ? 'true' : 'false');
  });
}

// Setup form state (also remembered between visits).
let draft = Object.assign({}, DEFAULT_PREFS, store.get('prefs', {}));
draft.show = Object.assign({}, DEFAULT_PREFS.show, draft.show);

$('s-live').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { draft.live = b.dataset.v === '1'; syncSetup(); }));
segmented($('s-chart'), CHARTS, (v) => { draft.chart = v; syncSetup(); });
toggles($('s-show'), (k) => { draft.show[k] = !draft.show[k]; syncSetup(); });
$('s-reset').addEventListener('click', () => {
  $('s-options').value = DEFAULT_OPTIONS.join('\n');
  $('s-question').value = '';
  $('s-options').focus();
});
$('s-cancel').addEventListener('click', () => { setupOpen = false; render(); });
$('s-end').addEventListener('click', async () => {
  const r = await api('end');
  if (r.ok) apply(r.data);
});
$('s-options').addEventListener('keydown', submitOnCmdEnter);
$('s-question').addEventListener('keydown', submitOnCmdEnter);
function submitOnCmdEnter(e) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('setup').requestSubmit(); }
}

function syncSetup() {
  setSeg($('s-live'), draft.live ? 1 : 0);
  setSeg($('s-chart'), draft.chart);
  setToggles($('s-show'), draft.show);
  store.set('prefs', draft);
}

function openSetup() {
  setupOpen = true;
  const p = state && state.poll;
  $('s-question').value = '';
  $('s-options').value = (p ? p.options : DEFAULT_OPTIONS).join('\n');
  $('s-err').textContent = '';
  syncSetup();
  render();
  setTimeout(() => $('s-options').focus(), 0);
}

$('setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const options = $('s-options').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (options.length < 2) { $('s-err').textContent = 'Add at least two options, one per line.'; return; }
  if (options.length > 8) { $('s-err').textContent = 'Eight options at most.'; return; }
  $('s-err').textContent = '';
  const r = await api('start', { question: $('s-question').value, options, live: draft.live, chart: draft.chart, show: draft.show });
  if (!r.ok) { $('s-err').textContent = (r.data && r.data.error) || 'Could not start the poll.'; return; }
  setupOpen = false;
  apply(r.data);
});

// Live controls: change the running poll at once.
async function setPoll(change) {
  Object.assign(state.poll, change);
  render();
  const r = await api('set', change);
  if (r.ok) apply(r.data);
}
segmented($('a-chart'), CHARTS, (v) => setPoll({ chart: v }));
toggles($('a-show'), (k) => setPoll({ show: Object.assign({}, state.poll.show, { [k]: !state.poll.show[k] }) }));
$('a-reveal').addEventListener('click', () => {
  const p = state.poll;
  // Live polls flip between live and hidden; others reveal and hide.
  if (p.live || p.revealed) setPoll({ live: false, revealed: false });
  else setPoll({ revealed: true });
});
$('a-open').addEventListener('click', () => setPoll({ open: !state.poll.open }));
$('a-new').addEventListener('click', openSetup);

// ⋯ menu: copy the links, delete the room.
const menu = $('menu');
let menuFor = null;
function closeMenu() {
  menu.hidden = true;
  menuFor = null;
  $('m-delete').classList.remove('confirm');
  $('m-delete').textContent = 'Delete this poll…';
}
document.querySelectorAll('.more-btn').forEach((btn) => btn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (menuFor === btn) { closeMenu(); return; }
  closeMenu();
  menuFor = btn;
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
  // open upwards when the button is near the bottom of the window
  if (r.bottom + menu.offsetHeight + 12 > innerHeight) { menu.style.top = ''; menu.style.bottom = (innerHeight - r.top + 6) + 'px'; }
  else { menu.style.bottom = ''; menu.style.top = (r.bottom + 6) + 'px'; }
}));
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });
window.addEventListener('resize', closeMenu);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3000);
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch (e) { window.prompt('Copy this link:', text); }
}
// The link box can be closed (remembered in this browser); "Show voter link" in the ⋯ menu brings it back.
function setShareClosed(closed) { store.set('shareClosed', closed); render(); }
$('share-close').addEventListener('click', () => setShareClosed(true));
$('m-show-link').addEventListener('click', () => { closeMenu(); setShareClosed(false); });
$('share-copy').addEventListener('click', () => copy(voterLink(), 'Link copied. Paste it into the meeting chat.'));
$('m-link').addEventListener('click', () => { closeMenu(); copy(voterLink(), 'Voter link copied'); });
$('m-host').addEventListener('click', () => { closeMenu(); copy(hostLink(), 'Host link copied. Keep it to yourself.'); });
$('m-delete').addEventListener('click', async () => {
  const b = $('m-delete');
  if (!b.classList.contains('confirm')) {
    b.classList.add('confirm');
    b.textContent = 'Click again to delete it for everyone';
    return;
  }
  closeMenu();
  const r = await api('delete');
  if (r.ok) endRoom();
  else toast('Couldn’t delete it. Try again.');
});

let setupInitialised = false;
function renderAdmin() {
  show('admin');
  if (!renderAdmin.checked) { renderAdmin.checked = true; checkShortLinks(room); }
  const shareClosed = !!store.get('shareClosed', false);
  $('share').hidden = shareClosed;
  $('m-show-link').hidden = !shareClosed;
  $('share-url').textContent = voterLink().replace(/^https?:\/\//, '');
  const p = state.poll;
  if (!setupInitialised) { setupInitialised = true; if (!p) openSetup(); }
  const inSetup = setupOpen || !p;
  $('setup').hidden = !inSetup;
  $('a-live').hidden = inSetup;
  $('s-cancel').hidden = !p;
  $('s-end').hidden = !p;
  if (inSetup) return;

  const shown = !!state.results;
  $('a-reveal').textContent = shown ? 'Hide results' : 'Reveal results';
  $('a-reveal').classList.toggle('primary', !shown);
  $('a-open').textContent = p.open ? 'Close voting' : 'Reopen voting';
  const here = state.attendees != null ? ' · ' + plural(state.attendees, 'person', 'people') + ' here' : '';
  $('a-status').textContent = plural(state.voted, 'vote', 'votes') + here + (p.open ? '' : ' · closed');
  setSeg($('a-chart'), p.chart);
  setToggles($('a-show'), p.show);

  const board = $('a-board');
  if (shown) {
    drawResults(board, state, true);
  } else {
    board._key = null;
    board.innerHTML = '';
    board.appendChild(el('h1', 'question', p.question || 'Voting now'));
    const hid = el('div', 'hidden-board');
    hid.append(el('div', 'big-count', String(state.voted)), el('div', 'muted', state.voted === 1 ? 'vote so far' : 'votes so far'));
    if (p.show.attendees && state.attendees != null) hid.appendChild(el('div', 'fine', plural(state.attendees, 'person', 'people') + ' here'));
    hid.appendChild(el('div', 'chips', p.options.join('  ·  ')));
    board.appendChild(hid);
  }
}

render();
tick();
