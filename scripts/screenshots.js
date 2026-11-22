#!/usr/bin/env node
// UI check + README screenshots in one run. Serves public/ with a stand-in for api.php (no PHP, no server, no real
// data), walks through the host and voter screens, checks the important behaviour, and saves
// docs/screenshots/*.png at 2x. Exits non-zero if a check fails.
//
//   node scripts/screenshots.js
// Needs Playwright (or playwright-core with a Chromium); set PLAYWRIGHT=/path/to/playwright-core if it isn't found.
const fs = require('fs');
const path = require('path');
const pw = (() => {
  for (const m of [process.env.PLAYWRIGHT, 'playwright', 'playwright-core'].filter(Boolean)) {
    try { return require(m); } catch (e) {}
  }
  console.error('Playwright not found: set PLAYWRIGHT=/path/to/playwright-core');
  process.exit(2);
})();

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const SITE = 'https://poll.example/livepoll/';
const PW = 'host';
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css' };

// ---- stand-in for api.php (same responses, kept in memory) ----
const rooms = {};
let roomCount = 0;
let rewrite = true; // false = a server without the short-link rule
const tokenFor = (r) => 'f'.repeat(48) + r;
function view(s, role, c) {
  const people = Object.keys(s.seen).filter((k) => !s.seen[k].admin);
  const v = { role, rev: 1, poll: s.poll, myVote: s.poll && c in s.votes ? s.votes[c] : null,
    voted: Object.keys(s.votes).length, attendees: role === 'admin' ? people.length : null, results: null };
  if (!s.poll) return v;
  if (s.poll.show.attendees) v.attendees = people.length;
  if (s.poll.live || s.poll.revealed) {
    const counts = s.poll.options.map(() => 0);
    Object.values(s.votes).forEach((i) => counts[i]++);
    v.results = { counts, nonvoters: people.filter((k) => !(k in s.votes)).length };
  }
  return v;
}
async function handle(route) {
  const req = route.request();
  const url = new URL(req.url());
  const rel = url.pathname.replace('/livepoll/', '');
  if (rel !== 'api.php') {
    // like .htaccess + room.php: /livepoll/<room> is the page, with a 404 status for an unknown room
    const m = rel.match(/^[a-f0-9]{16}$/);
    if (m && !rewrite) return route.fulfill({ status: 404, body: 'Not found' });
    const file = path.join(PUB, m || rel === '' ? 'index.html' : rel);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
    return route.fulfill({ status: m && !rooms[rel] ? 404 : 200, body: fs.readFileSync(file), contentType: TYPES[file.split('.').pop()] });
  }
  const b = JSON.parse(req.postData());
  const json = (d, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
  if (b.a === 'login') {
    if (b.password !== PW) return json({ error: 'wrong password' }, 401);
    const r = (++roomCount).toString(16).padStart(16, '6a39e359380f6c30');
    rooms[r] = { poll: null, votes: {}, seen: {} };
    return json({ room: r, token: tokenFor(r) });
  }
  const s = rooms[b.r];
  if (!s) return json({ error: 'gone' }, 404);
  const role = b.t === tokenFor(b.r) ? 'admin' : 'voter';
  if (b.c) s.seen[b.c] = { admin: role === 'admin' };
  if (b.a === 'leave') { delete s.seen[b.c]; return json({ ok: true }); }
  if (b.a === 'vote') s.votes[b.c] = b.choice;
  if (role === 'admin') {
    if (b.a === 'start') { s.poll = { id: 'p' + Date.now(), question: b.question, options: b.options, live: b.live, revealed: false, open: true, chart: b.chart, show: b.show }; s.votes = {}; }
    if (b.a === 'set') for (const k of ['revealed', 'open', 'live', 'chart', 'show']) if (k in b) s.poll[k] = b[k];
    if (b.a === 'end') { s.poll = null; s.votes = {}; }
    if (b.a === 'delete') { delete rooms[b.r]; return json({ ok: true }); }
  }
  return json(view(s, role, b.c));
}

// ---- checks ----
let failed = 0;
function check(ok, what) { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await pw.chromium.launch();
  const desk = { viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 };
  const phone = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const open = async (opts) => {
    const ctx = await browser.newContext(opts);
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(SITE).origin });
    await ctx.route('**/*', handle);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'page error: ' + e.message));
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
  const settle = (page) => page.waitForTimeout(1500); // a poll cycle plus the bar animation

  // Host login
  const h = await open(desk);
  await h.goto(SITE);
  await shot(h, '1-start.png');
  await h.fill('#pw', 'wrong'); await h.click('#login-form button[type=submit]');
  await h.waitForFunction(() => document.getElementById('login-err').textContent);
  check(true, 'wrong password is refused');
  await h.fill('#pw', PW); await h.click('#login-form button[type=submit]');
  await h.waitForURL(/\/livepoll\/[a-f0-9]{16}$/);
  const room = h.url().slice(-16);
  check(true, 'login makes a new room at ' + h.url());
  await h.waitForSelector('#setup:not([hidden])');
  check((await h.textContent('#share-url')) === 'poll.example/livepoll/' + room, 'link box shows the voter link');
  await h.fill('#s-question', 'Have you ever felt like an impostor at work?');
  await settle(h);
  await shot(h, '2-host-setup.png');

  // Run the poll, with some pretend voters already in
  await h.click('#setup button[type=submit]');
  await h.waitForSelector('#a-live:not([hidden])');
  const s = rooms[room];
  [0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2].forEach((choice, i) => { s.seen['fake' + i] = { admin: false }; s.votes['fake' + i] = choice; });
  s.seen.fakeidle1 = { admin: false }; s.seen.fakeidle2 = { admin: false };

  const v = await open(phone);
  const res = await v.goto(SITE + room);
  check(res.status() === 200, 'voter link opens without a login');
  await v.waitForSelector('.vote-btn');
  await v.click('.vote-btn >> nth=0');
  await settle(v);
  await shot(v, '3-phone-vote.png');
  await settle(h);
  await shot(h, '4-host-waiting.png');

  // Close the link box: gone from the screen, back from the ⋯ menu
  await h.click('#share-close');
  check(await h.isHidden('#share'), 'link box closes');
  await h.click('#a-live .more-btn');
  check(await h.isVisible('#m-show-link'), '⋯ menu offers "Show voter link" when the box is closed');
  await h.click('#m-show-link');
  check(await h.isVisible('#share'), 'link box comes back from the menu');
  await h.click('#share-close');

  await h.click('#a-reveal');
  await settle(h);
  await shot(h, '5-host-bar.png');
  await h.click('#a-chart button[data-v=pie]'); await settle(h); await shot(h, '6-host-pie.png');
  await h.click('#a-chart button[data-v=numbers]'); await settle(h); await shot(h, '7-host-numbers.png');
  await h.click('#a-chart button[data-v=bar]');
  await settle(v);
  await shot(v, '8-phone-results.png');

  // Host link on another device
  await h.click('#a-live .more-btn'); await h.click('#m-host');
  const hostLink = await h.evaluate(() => navigator.clipboard.readText());
  check(/\/livepoll\/[a-f0-9]{16}#host=[a-f0-9]{64}$/.test(hostLink), 'host link copied');
  const h2 = await open(desk);
  await h2.goto(hostLink);
  await h2.waitForSelector('#admin:not([hidden])');
  check(!h2.url().includes('#'), 'host link opens as host and hides the token from the address bar');

  // Unknown poll: 404 and nothing else
  const x = await open(phone);
  const r404 = await x.goto(SITE + '0123456789abcdef');
  await x.waitForSelector('#ended:not([hidden])');
  check(r404.status() === 404 && (await x.innerText('main')).trim() === '404 Poll not found' && await x.isHidden('#logout'),
    'unknown poll: 404 status, only "404 Poll not found"');

  // Delete: everyone on it sees the 404
  await h.click('#a-live .more-btn'); await h.click('#m-delete'); await h.click('#m-delete');
  await v.waitForSelector('#ended:not([hidden])', { timeout: 5000 });
  check(!rooms[room] && await h.isVisible('#ended'), 'delete removes the room for host and voters');

  // Server without the short-link rule: links fall back to ?p=
  rewrite = false;
  const f = await open(desk);
  await f.goto(SITE); await f.fill('#pw', PW); await f.click('#login-form button[type=submit]');
  await f.waitForURL(/\?p=[a-f0-9]{16}$/);
  await f.waitForSelector('#setup:not([hidden])');
  check((await f.textContent('#share-url')).includes('/?p='), 'without the rewrite, links fall back to ?p=');

  await browser.close();
  console.log(failed ? failed + ' check(s) failed' : 'All checks passed. Screenshots in docs/screenshots/');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
