import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { graphOf, layout, renderPage, esc, serve, serveOrFind, defaultPort, rowSubject, parseReport, focusOf, whoOfRow, whoOfItem, itemDetail, readBoardFile, boardDiff, mdHtml, historyOf } from './page.mjs';
import { foldStore, boardRows, readStore, buildPrompt, parseItem } from './lane.mjs';

process.env.TZ = 'UTC';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-09-05T08:00:00Z');
const item = (file, text) => ({ file, text });
const lane = (name, status, extra = {}) => ({ name, status, session: `${name}-session-id`, peer: null, session_open: false, mtime: NOW - 5000, ...extra });
const data = (results, store, extra = {}) => ({ rows: boardRows(results, store, { now: NOW }), results, items: store.items, lanes: store.lanes, repo: 'repo', storeDir: 'coordinator', ...extra });

test('the graph: lanes and holding items are nodes; after, blocks and until are edges from the waiter to what it waits on', () => {
  const st = foldStore([item('1-d.md', 'DECIDE which?\nblocks: y\n'), item('2-h.md', 'HOLD x\nafter: v\n'), item('3-n.md', 'NOTE handed\nuntil: ok v\n'), item('4-l.md', 'LANE z scope\nafter: x\n'), item('5-i.md', 'IDEA later\n')], 'OK v 07:10 abc');
  const g = graphOf(data([lane('x', 'not_found'), lane('y', 'not_found')], st));
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['item:1', 'item:3', 'lane:v', 'lane:x', 'lane:y', 'lane:z']);
  assert.deepEqual(g.edges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort(), ['item:3 until lane:v', 'lane:x after lane:v', 'lane:y blocks item:1', 'lane:z after lane:x']);
  const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.equal(by['lane:x'].held, true);
  assert.equal(by['lane:v'].status, 'filed');
  assert.equal(by['lane:z'].status, 'planned');
  assert.equal(by['lane:z'].head, 'scope');
  const { depth } = layout(g);
  assert.ok(depth.get('lane:v') < depth.get('lane:x') && depth.get('lane:x') < depth.get('lane:z'), 'waited-on sits left of the waiter');
  assert.ok(depth.get('item:1') < depth.get('lane:y'));
});

test('an item with no edge stays off the graph; lanes always draw', () => {
  const st = foldStore([item('1-d.md', 'DECIDE loose question\n'), item('2-s.md', 'STEP loose step\n'), item('3-n.md', 'NOTE tied\nuntil: ok v\n')], 'OK v 07:10 abc');
  const g = graphOf(data([lane('x', 'not_found')], st));
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['item:3', 'lane:v', 'lane:x']);
});

test('a cycle or a dangling target does not break the layout', () => {
  const st = foldStore([item('1-a.md', 'LANE a\nafter: b\n'), item('2-b.md', 'LANE b\nafter: a\n'), item('3-n.md', 'NOTE n\nuntil: ok ghost\n')]);
  const g = graphOf(data([], st));
  const { pos, width, height } = layout(g);
  assert.equal(pos.size, g.nodes.length);
  assert.ok(width > 0 && height > 0);
  assert.equal(g.nodes.find((n) => n.id === 'lane:ghost').status, 'unknown');
});

test('the page carries every board row and every item, escapes markup, and is pure', () => {
  const st = foldStore([item('1-d.md', 'DECIDE ship <b>now</b> & later?\nblocks: y\n\nbody with <script>\n'), item('2-i.md', 'IDEA hidden by default\n')]);
  const d = data([lane('y', 'not_found')], st);
  const html = renderPage(d, { now: NOW });
  for (const r of d.rows) assert.ok(html.includes(esc(r)), r);
  assert.ok(html.includes('ship &lt;b&gt;now&lt;/b&gt; &amp; later?'));
  assert.ok(html.includes('body with &lt;script&gt;'));
  assert.ok(!html.includes('body with <script>'));
  assert.equal(html.split('<script>').length, 3, 'two script blocks: the theme applied before the stylesheet, and the tail that keeps open cards open and runs the theme button');
  assert.ok(html.includes("sessionStorage.setItem(k") && html.includes("addEventListener('toggle'"));
  assert.ok(/<details class="item idea" id="i2" data-who="ideas"[^>]* hidden>/.test(html), 'ideas are on the page, hidden until the ideas toggle');
  assert.ok(html.includes('data-who="ideas" aria-pressed="false">ideas</button>') && !/<details class="item idea" id="i2"[^>]* hidden>/.test(renderPage(d, { now: NOW, ideas: true })), '--ideas starts with the toggle on');
  assert.equal(renderPage(d, { now: NOW }), html);
  assert.ok(!html.includes('http-equiv="refresh"'));
  assert.ok(renderPage(d, { now: NOW, mode: 'serve', auto: 5 }).includes('<meta http-equiv="refresh" content="5">'));
  const json = JSON.parse(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(json.rows, d.rows);
  assert.equal(json.items[0].body, undefined);
});

test('both modes carry a Refresh button; only serve offers auto-reload', () => {
  const d = data([], foldStore([item('1-n.md', 'NOTE n\n')]));
  const snap = renderPage(d, { now: NOW });
  const served = renderPage(d, { now: NOW, mode: 'serve' });
  const auto = renderPage(d, { now: NOW, mode: 'serve', auto: 5 });
  for (const h of [snap, served, auto]) assert.ok(h.includes('onclick="location.reload()"') && h.includes('>Refresh</button>'));
  assert.ok(snap.includes('· snapshot') && !snap.includes('http-equiv="refresh"') && !snap.includes('href="?auto=5"'));
  assert.ok(served.includes('live on request') && served.includes('href="?auto=5"') && !served.includes('http-equiv="refresh"'));
  assert.ok(auto.includes('auto 5s') && auto.includes('content="5"') && auto.includes('href="?"'));
});

test('the theme toggle: a head script applies the stored choice before the stylesheet, the button cycles system/light/dark, and every dark token also exists on bare :root', async () => {
  const d = data([], foldStore([item('1-n.md', 'NOTE n\n')]));
  for (const html of [renderPage(d, { now: NOW }), renderPage(d, { now: NOW, mode: 'serve' })]) {
    const head = html.split('<style>')[0];
    assert.ok(head.includes("localStorage.getItem(\"board-theme\")") && head.includes("setAttribute('data-theme',t)"), 'theme applied before the stylesheet');
    assert.ok(html.includes('id="theme"') && html.includes('>theme: system</button>'));
    assert.ok(html.includes("order=['system','light','dark']") && html.includes("localStorage.removeItem(\"board-theme\")"));
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
    assert.ok(css.includes(':root[data-theme="dark"]{') && css.includes('@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){'));
    const tokens = (block) => [...block.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]);
    const light = new Set(tokens(/:root\{([\s\S]*?)\}/.exec(css)[1]));
    const dark = tokens(/:root\[data-theme="dark"\]\{([\s\S]*?)\}/.exec(css)[1]);
    assert.ok(dark.length >= 12);
    for (const t of dark) assert.ok(light.has(t), `--${t} has a light definition`);
    const vm = await import('node:vm');
    for (const s of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(s[1]);
  }
});

test('--serve renders the fold per request on a localhost port derived from the cwd, and /board.json is the same data', async () => {
  const dir = path.join(HERE, 'fixtures', 'store');
  const storeDir = path.join(dir, 'coordinator');
  assert.equal(defaultPort(dir), defaultPort(dir));
  assert.ok(defaultPort(dir) >= 7300 && defaultPort(dir) < 7800);
  assert.notEqual(defaultPort(dir), defaultPort(path.join(dir, 'other')));
  const server = await serve({ cwd: dir, store: storeDir, port: 0 });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes('live on request') && html.includes('docs-apply-r51') && html.includes('DONE    15 filed'));
    const auto = await (await fetch(`${base}/?auto=3`)).text();
    assert.ok(auto.includes('content="3"') && auto.includes('auto 3s'));
    const json = await (await fetch(`${base}/board.json`)).json();
    assert.ok(json.rows.includes('DONE    15 filed'));
    assert.equal(json.items.length, 16);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    await assert.rejects(serve({ cwd: dir, store: storeDir, port: server.address().port }), (e) => e.code === 'EADDRINUSE');
  } finally {
    server.close();
  }
});

// A port a throwaway listen(0) got, with the next n-1 also free: serveOrFind
// steps by one. A caller passing port 0 would get the cwd's derived port.
async function freePorts(n) {
  const grab = (p) =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(null));
      s.listen(p, '127.0.0.1', () => {
        const got = s.address().port;
        s.close(() => resolve(got));
      });
    });
  for (let tries = 0; tries < 20; tries++) {
    const base = await grab(0);
    let ok = base != null;
    for (let k = 1; ok && k < n; k++) ok = (await grab(base + k)) != null;
    if (ok) return base;
  }
  throw new Error(`no run of ${n} free ports`);
}

// One request as bytes: fetch and http.request refuse a malformed target.
const rawGet = (port, target, host) =>
  new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => (buf += d));
    s.on('error', reject);
    s.on('close', () => resolve({ status: Number(buf.split(' ')[1]), body: buf.split('\r\n\r\n')[1] || '' }));
  });

const statusWithHost = (port, host, target = '/board.json') =>
  new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, path: target, headers: { Host: host } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      })
      .on('error', reject)
      .end();
  });

test('a taken port is reused when it serves this repo and skipped when it serves another one or something else', async () => {
  const dir = path.join(HERE, 'fixtures', 'store');
  const storeDir = path.join(dir, 'coordinator');
  const other = path.join(HERE, 'fixtures', 'store-bad');
  const p = await freePorts(4);
  const first = await serveOrFind({ cwd: dir, store: storeDir, port: p });
  const servers = [first.server];
  try {
    assert.equal(first.found, false);
    assert.equal(first.port, p);
    const same = await serveOrFind({ cwd: dir, store: storeDir, port: p });
    assert.deepEqual([same.found, same.server, same.url], [true, null, `http://127.0.0.1:${p}/`]);
    const collided = await serveOrFind({ cwd: other, store: path.join(other, 'coordinator'), port: p });
    servers.push(collided.server);
    assert.equal(collided.found, false);
    assert.equal(collided.port, p + 1);
    const json = await (await fetch(collided.url + 'board.json')).json();
    assert.equal(json.cwd, path.resolve(other));
    const stranger = http.createServer((_req, res) => res.end('hi'));
    await new Promise((resolve, reject) => {
      stranger.once('error', reject);
      stranger.listen(p + 2, '127.0.0.1', resolve);
    });
    servers.push(stranger);
    const stepped = await serveOrFind({ cwd: dir, store: storeDir, port: p + 2 });
    servers.push(stepped.server);
    assert.equal(stepped.port, p + 3);
  } finally {
    for (const s of servers) if (s) s.close();
  }
});

test('page.mjs writes the fixture store to --out atomically and never touches the store', (t) => {
  const dir = path.join(HERE, 'fixtures', 'store');
  const storeDir = path.join(dir, 'coordinator');
  const snapshot = () => Object.fromEntries(fs.readdirSync(storeDir).map((f) => [f, fs.statSync(path.join(storeDir, f)).mtimeMs]));
  const before = snapshot();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-page-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const out = path.join(tmp, 'board.html');
  const printed = execFileSync(process.execPath, [path.join(HERE, 'page.mjs'), '--cwd', dir, '--store', storeDir, '--out', out], { encoding: 'utf8' }).trim();
  assert.equal(printed, out);
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<svg'));
  assert.ok(html.includes('docs-apply-r51'));
  assert.ok(html.includes('DONE    15 filed'));
  assert.ok(!fs.existsSync(`${out}.tmp`));
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(fs.readdirSync(storeDir).filter((f) => !f.endsWith('.md') && !/^prompt-.*\.txt$/.test(f) && f !== 'lanes.txt' && f !== 'github.txt' && f !== 'closed'), []);
  const store = readStore(dir, storeDir);
  assert.ok(store.items.length >= 14);
});

test('--help and -h print the usage and exit 0; an unknown flag prints it and exits 1; neither writes a file', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-page-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const out = path.join(tmp, 'board.html');
  const run = (...flags) => spawnSync(process.execPath, [path.join(HERE, 'page.mjs'), ...flags, '--out', out], { encoding: 'utf8' });
  for (const flag of ['--help', '-h']) {
    const r = run(flag);
    assert.equal(r.status, 0, flag);
    assert.ok(r.stdout.includes('page.mjs --serve [--port N]') && r.stdout.includes('page.mjs [--cwd DIR]'), flag);
  }
  const bad = run('--bogus');
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes('unknown flag --bogus') && bad.stderr.includes('page.mjs --serve [--port N]'));
  assert.equal(bad.stdout, '');
  assert.ok(!fs.existsSync(out) && !fs.existsSync(`${out}.tmp`));
});

test('a request target new URL rejects answers 400 and the server lives on', async (t) => {
  const dir = path.join(HERE, 'fixtures', 'store');
  const server = await serve({ cwd: dir, store: path.join(dir, 'coordinator'), port: 0 });
  t.after(() => server.close());
  const port = server.address().port;
  const bad = await rawGet(port, '//[', `127.0.0.1:${port}`);
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/board.json`)).status, 200);
});

test('a throw during render answers 500 with the stack and the server lives on', async (t) => {
  const dir = path.join(HERE, 'fixtures', 'store');
  const server = await serve({ cwd: dir, store: path.join(dir, 'coordinator'), port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const clock = t.mock.method(Date.prototype, 'toISOString', () => {
    throw new Error('clock is broken');
  });
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 500);
  assert.ok((await page.text()).includes('clock is broken'));
  assert.equal((await fetch(`${base}/board.json`)).status, 500);
  clock.mock.restore();
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('?auto: a fraction reloads every whole second, never every 0; a negative, unparseable or infinite value is off', async (t) => {
  const d = data([], foldStore([item('1-n.md', 'NOTE n\n')]));
  const every = (auto) => (/<meta http-equiv="refresh" content="(\d+)">/.exec(renderPage(d, { now: NOW, mode: 'serve', auto })) || [])[1];
  assert.equal(every(0.5), '1');
  assert.equal(every('2.9'), '2');
  assert.equal(every(5), '5');
  for (const off of [0, -3, 'abc', Infinity, null, undefined, '']) assert.equal(every(off), undefined, String(off));
  const dir = path.join(HERE, 'fixtures', 'store');
  const server = await serve({ cwd: dir, store: path.join(dir, 'coordinator'), port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const half = await (await fetch(`${base}/?auto=0.5`)).text();
  assert.ok(half.includes('content="1"') && half.includes('auto 1s') && !half.includes('content="0"'));
  assert.ok(!(await (await fetch(`${base}/?auto=-1`)).text()).includes('http-equiv="refresh"'));
});

test('a Host that is not this server on its port answers 403; 127.0.0.1, localhost and [::1] with the port pass', async (t) => {
  const dir = path.join(HERE, 'fixtures', 'store');
  const server = await serve({ cwd: dir, store: path.join(dir, 'coordinator'), port: 0 });
  t.after(() => server.close());
  const port = server.address().port;
  for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `localhost:${port}.evil.example`]) assert.equal(await statusWithHost(port, host), 403, host);
  assert.equal((await rawGet(port, '/board.json', '')).status, 403, 'an empty Host');
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) assert.equal(await statusWithHost(port, host), 200, host);
  assert.equal(await statusWithHost(port, 'evil.example', '/'), 403);
  assert.equal(await statusWithHost(port, 'evil.example', '/nope'), 403, 'refused before the path is looked at');
});

// A store and lanes that print one row of every shape; `prompts` is the
// map boardData builds, here two files: one written by `lane.mjs prompt`,
// one by hand.
function everyRow() {
  const st = foldStore(
    [item('1-d.md', 'DECIDE ship <b>now</b>?\nblocks: y\nsource: a/REPORT.md open 2\n\nline one\nline two\n'), item('2-s.md', 'STEP deploy\n'), item('3-n.md', 'NOTE tied\nuntil: ok x\n'), item('4-l.md', 'LANE z scope\nafter: x\n'), item('5-i.md', 'IDEA later\n')],
    'OK v 07:10 abc\nOK w 07:00 old evidence\nOK d 07:20 d-evidence https://git/x/d\nOK g 06:00 filed-evidence\n'
  );
  const prompts = { x: buildPrompt('x', { ask: 'show the bar', why: 'asked twice', done: 'rows show it', fences: 'web/ only', pointers: 'https://x.y/issue/1' }), h: 'TASK h\nfree text, no fields\n' };
  const results = [
    lane('x', 'not_found'),
    lane('y', 'not_found'),
    lane('h', 'in_progress', { peer: 'nightshift-05', prompt_at: '2026-09-05T07:00:00Z' }),
    lane('r', 'stopped', { stopped_at: '2026-09-05T07:30:00Z', tail: 'I did some.\nShip it now?', ask: 'Ship it now?', asked: true }),
    lane('f', 'finished', { closed_at: '2026-09-05T07:40:00Z', report: 'REPORT f\nwhat: did the thing,\n  then pivoted\ncommits: abc1234 subject one\nnone\npr: https://x/pr/1\nchecks: tsc: PASS, clean\nopen: none\n' }),
    lane('w', 'finished', { closed_at: '2026-09-05T07:50:00Z', report: 'REPORT w\nwhat: moved on\n' }),
    lane('v', 'finished', { closed_at: '2026-09-05T07:10:00Z', session_open: true, peer: 'p1', report: 'REPORT v\nwhat: v\n' }),
    lane('d', 'finished', { closed_at: '2026-09-05T07:20:00Z', report: 'REPORT d\nwhat: d\n' }),
  ];
  const rows = boardRows(results, st, { now: NOW, prompts: new Map(Object.entries(prompts)) });
  return { rows, results, items: st.items, lanes: st.lanes, prompts, repo: 'repo', storeDir: 'coordinator' };
}

test('every row names its subject from the row text: a lane, an item, several lanes, or nothing', () => {
  const d = everyRow();
  const by = (prefix) => d.rows.find((r) => r.startsWith(prefix));
  const sub = (prefix) => rowSubject(by(prefix));
  assert.deepEqual(sub('RUN     prompt-x'), { tag: 'RUN', kind: 'lane', name: 'x' });
  assert.deepEqual(sub('ANSWER  r'), { tag: 'ANSWER', kind: 'lane', name: 'r' });
  assert.deepEqual(sub('DECIDE  #1'), { tag: 'DECIDE', kind: 'item', id: 1 });
  assert.deepEqual(sub('STEP    #2'), { tag: 'STEP', kind: 'item', id: 2 });
  assert.deepEqual(sub('CLOSE'), { tag: 'CLOSE', kind: 'lanes', names: ['v'], filed: 0 });
  assert.deepEqual(sub('LIVE    h'), { tag: 'LIVE', kind: 'lane', name: 'h' });
  assert.deepEqual(sub('MINE    f  verify'), { tag: 'MINE', kind: 'lane', name: 'f' });
  assert.deepEqual(sub('MINE    y  held'), { tag: 'MINE', kind: 'lane', name: 'y' });
  assert.deepEqual(sub('MINE    z  write prompt'), { tag: 'MINE', kind: 'item', id: 4, name: 'z' });
  assert.deepEqual(sub('MINE    #3'), { tag: 'MINE', kind: 'item', id: 3 });
  assert.deepEqual(sub('MINE    stale'), { tag: 'MINE', kind: 'lane', name: 'w' });
  assert.deepEqual(sub('DONE'), { tag: 'DONE', kind: 'lanes', names: [], verified: 1, filed: 1 }, 'the DONE row is a count; the page names the lanes from the data');
  assert.deepEqual(rowSubject('DONE    15 filed'), { tag: 'DONE', kind: 'lanes', names: [], verified: 0, filed: 15 });
  assert.deepEqual(rowSubject('MINE    file: #6 #7'), { tag: 'MINE', kind: 'items', ids: [6, 7] });
  assert.deepEqual(sub('CTX'), { tag: 'CTX', kind: 'none' });
  assert.deepEqual(rowSubject('BAD     #6 names unknown lane'), { tag: 'BAD', kind: 'none' });
});

test('a REPORT block parses by field, continuation lines kept, text before the first key one unnamed field', () => {
  const rep = parseReport('REPORT f\nwhat: did the thing,\n  then pivoted\ncommits: abc1234 one\ndef5678 two\npr: none\nchecks: tsc: PASS\nopen: none\n');
  assert.equal(rep.name, 'f');
  assert.deepEqual(rep.fields.map((f) => f.key), ['what', 'commits', 'pr', 'checks', 'open']);
  assert.equal(rep.fields[0].text, 'did the thing,\n  then pivoted');
  assert.equal(rep.fields[1].text, 'abc1234 one\ndef5678 two');
  assert.deepEqual(parseReport('REPORT g\nprose only\n').fields, [{ key: '', text: 'prose only' }]);
});

test('every row opens in place to everything behind it: prompt fields, the report by field with pr as a link, the last message and ask, the OK evidence, the whole body with its line breaks, the filed lanes', () => {
  const d = everyRow();
  const html = renderPage(d, { now: NOW });
  const row = (id) => {
    const m = new RegExp(`<details class="row [A-Z]+( changed)?" id="${id.replace(/[:.]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</details>`).exec(html);
    assert.ok(m, `row ${id}`);
    return m[2];
  };
  const run = row('row:RUN:lane:x');
  for (const [label, text] of [['Ask', 'show the bar'], ['Why now', 'asked twice'], ['Done when', 'rows show it'], ['Fences', 'web/ only']]) assert.ok(run.includes(`<b>${label}</b><p class="wrap">${text}</p>`), label);
  assert.ok(run.includes('<a href="https://x.y/issue/1"'), 'a URL in a field is a link');
  assert.ok(run.includes('<h4>prompt-x.txt</h4>'));
  const live = row('row:LIVE:lane:h');
  assert.ok(live.includes('in progress · peer nightshift-05 · session h-sessio · prompt 2026-09-05 07:00:00'));
  assert.ok(live.includes('<pre class="wrap">TASK h\nfree text, no fields</pre>'), 'a hand-written prompt shows whole');
  const fin = row('row:MINE:lane:f');
  assert.ok(fin.includes('<b>what</b><p class="wrap">did the thing,\n  then pivoted</p>'));
  assert.ok(fin.includes('<b>commits</b><ul><li><code>abc1234</code> subject one</li><li>none</li></ul>'));
  assert.ok(fin.includes('<b>pr</b><p class="wrap"><a href="https://x/pr/1" target="_blank" rel="noopener">https://x/pr/1</a></p>'));
  assert.ok(fin.includes('<b>checks</b><ul><li>tsc: PASS, clean</li></ul>') && fin.includes('<b>open</b><p class="wrap">none</p>'));
  assert.ok(fin.includes('report 2026-09-05 07:40:00'));
  const stopped = row('row:ANSWER:lane:r');
  assert.ok(stopped.includes('<b>asked</b><p class="wrap">Ship it now?</p>') && stopped.includes('<h4>last message</h4><pre class="wrap">I did some.\nShip it now?</pre>'));
  const held = row('row:MINE:lane:y');
  assert.ok(held.includes('<h4>items naming it</h4>') && held.includes('#1</a> ship &lt;b&gt;now&lt;/b&gt;?'));
  const decide = row('row:DECIDE:item:1');
  assert.ok(decide.includes('<span class="key">blocks: y</span>') && decide.includes('<pre class="wrap">line one\nline two</pre>') && decide.includes('<p class="file">1-d.md</p>'));
  const plan = row('row:MINE:item:4');
  assert.ok(plan.includes('<span class="key">after: x</span>') && plan.includes('no body'));
  const stale = row('row:MINE:lane:w');
  assert.ok(stale.includes('<h4>verified</h4><p class="mono">OK w 07:00 old evidence</p>') && stale.includes('report 2026-09-05 07:50:00'));
  const done = row('row:DONE:lanes');
  assert.ok(done.includes('<h4>d</h4>') && done.includes('OK d 07:20 d-evidence <a href="https://git/x/d"'), 'a DONE lane shows its OK evidence, links live');
  assert.ok(done.includes('<h4>1 filed: an OK line each, no prompt file</h4>') && done.includes('<li>OK g 06:00 filed-evidence</li>'));
  const close = row('row:CLOSE:lanes');
  assert.ok(close.includes('<h4>v</h4>') && close.includes('peer p1'));
  assert.ok(html.includes('<div class="row BAD"><span class="line">') === false && /<div class="row CTX" data-who="ctx" data-text="ctx [^"]*"><span class="line">CTX/.test(html), 'CTX is a plain line');
  assert.ok(/<template id="t:lane:x">[\s\S]*?<h4>prompt-x\.txt<\/h4>/.test(html) && /<template id="t:item:1">[\s\S]*?line one\nline two/.test(html), 'each graph node has its context in a template');
  assert.ok(html.includes('data-id="lane:x"') && html.includes("e.key!=='Escape'") && html.includes('closeNode()'), 'nodes open by click, Escape closes all');
  const json = JSON.parse(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(json.prompts.x.done, 'rows show it');
  assert.equal(json.results.find((r) => r.name === 'f').report.split('\n')[1], 'what: did the thing,');
  assert.equal(json.results.find((r) => r.name === 'r').ask, 'Ship it now?');
});

test('focus: a node lights what it waits on (left, its blockers when held) and what waits on it (right, what a DECIDE unblocks), transitively; the render writes both sets on the node and the script dims the rest', () => {
  const st = foldStore([item('1-d.md', 'DECIDE which?\nblocks: y\n'), item('2-h.md', 'HOLD x\nafter: v\n'), item('4-l.md', 'LANE z scope\nafter: x\n'), item('3-n.md', 'NOTE handed\nuntil: ok v\n')], 'OK v 07:10 abc');
  const g = graphOf(data([lane('x', 'not_found'), lane('y', 'not_found')], st));
  const sets = (id) => {
    const f = focusOf(g, id);
    return { up: [...f.up].sort(), down: [...f.down].sort() };
  };
  assert.deepEqual(sets('lane:x'), { up: ['lane:v'], down: ['lane:z'] });
  assert.deepEqual(sets('lane:z'), { up: ['lane:v', 'lane:x'], down: [] }, 'transitive: z waits on x, x on v');
  assert.deepEqual(sets('item:1'), { up: [], down: ['lane:y'] }, 'a DECIDE unblocks the lane that waits on it');
  assert.deepEqual(sets('lane:y'), { up: ['item:1'], down: [] }, 'a held lane waits on its blocker');
  assert.deepEqual(sets('lane:v'), { up: [], down: ['item:3', 'lane:x', 'lane:z'] });
  const cyc = graphOf(data([], foldStore([item('1-a.md', 'LANE a\nafter: b\n'), item('2-b.md', 'LANE b\nafter: a\n')])));
  assert.deepEqual([...focusOf(cyc, 'lane:a').up], ['lane:b'], 'a cycle ends where it started');
  const html = renderPage(data([lane('x', 'not_found'), lane('y', 'not_found')], st), { now: NOW });
  assert.ok(html.includes('data-id="lane:z" data-up="lane:x lane:v" data-down=""'), 'the up set is on the node');
  assert.ok(html.includes('data-id="item:1" data-up="" data-down="lane:y"'));
  assert.ok(html.includes('class="edge after" data-from="lane:x" data-to="lane:v"'));
  assert.ok(html.includes("svg.classList.add('focused')") && html.includes("classList.toggle('up'") && html.includes("classList.toggle('lit'") && html.includes('setFocus(null)'), 'the script lights and dims');
  assert.ok(html.includes('svg.focused .node:not(.focus):not(.up):not(.down)'), 'the rest dims by CSS');
});

test('filter: one toggle per who acts, on by default except ideas; every row and item carries who acts and its text; the script hides rows and items and dims nodes', () => {
  const d = everyRow();
  const html = renderPage(d, { now: NOW });
  for (const w of ['you', 'live', 'mine', 'done']) assert.ok(html.includes(`<button type="button" class="tog on" data-who="${w}" aria-pressed="true">${w}</button>`), w);
  assert.ok(html.includes('<input type="search" id="find"'));
  assert.ok(html.includes('id="row:RUN:lane:x" data-who="you" data-text="run     prompt-x.txt  rows show it"'));
  assert.ok(html.includes('id="row:LIVE:lane:h" data-who="live"') && html.includes('id="row:MINE:lane:f" data-who="mine"') && html.includes('id="row:DONE:lanes" data-who="done"'));
  assert.ok(html.includes('<div class="row CTX" data-who="ctx"'));
  assert.ok(html.includes('id="i1" data-who="you" data-text="ship <b>now</b>?"'.replace('<b>now</b>', '&lt;b&gt;now&lt;/b&gt;')) && html.includes('id="i4" data-who="mine" data-text="z scope"') && html.includes('id="i5" data-who="ideas"'));
  assert.ok(/data-id="lane:x" data-up="" data-down="[^"]*lane:z[^"]*" data-text="x not found"/.test(html), 'a node carries its text');
  assert.ok(html.includes("el.hidden=!ok") && html.includes("classList.toggle('off'") && html.includes("sessionStorage.setItem(fk"), 'the script hides, dims and remembers');
  assert.deepEqual([whoOfRow('RUN     x'), whoOfRow('ANSWER  x'), whoOfRow('CLOSE   x'), whoOfRow('LIVE    x'), whoOfRow('MINE    x'), whoOfRow('DONE    x'), whoOfRow('BAD     x'), whoOfRow('CTX     x')], ['you', 'you', 'you', 'live', 'mine', 'done', 'bad', 'ctx']);
});

test('the stamp: the header shows the board.txt stamp, rows it lacks are marked changed, rows it had that are gone are listed struck through; no board.txt says so', () => {
  const d = everyRow();
  const prev = ['RUN     prompt-x.txt  rows show it', 'MINE    old  verify report 06:00', ...d.rows.filter((r) => /^(DECIDE|STEP)/.test(r)), 'CTX     coordinator 1K/1M  repo: 0 lanes  items 0'];
  const bf = readBoardFile(`board repo 2026-09-05 07:59:00\n${prev.join('\n')}\n`);
  assert.deepEqual(bf, { stamp: '2026-09-05 07:59:00', repo: 'repo', rows: prev });
  assert.deepEqual(readBoardFile('garbage\n'), { stamp: null, repo: null, rows: [] });
  const diff = boardDiff(prev, d.rows);
  assert.ok(!diff.added.has(prev[0]) && diff.added.has(d.rows.find((r) => r.startsWith('LIVE'))) && !diff.added.has(d.rows.find((r) => r.startsWith('CTX'))), 'CTX is never a change');
  assert.deepEqual(diff.gone, ['MINE    old  verify report 06:00']);
  const html = renderPage({ ...d, board: bf }, { now: NOW });
  assert.ok(html.includes('board <span class="stamp">2026-09-05 07:59:00</span> · <span class="changed">'));
  assert.ok(html.includes(`<details class="row RUN" id="row:RUN:lane:x"`), 'a row the board has is not marked');
  assert.ok(html.includes(`<details class="row LIVE changed" id="row:LIVE:lane:h" data-who="live" data-text="${esc(d.rows.find((r) => r.startsWith('LIVE')).toLowerCase())}" title="not on board 2026-09-05 07:59:00">`));
  assert.ok(html.includes('<p class="sep">gone since board 2026-09-05 07:59:00</p><div class="row gone" data-who="mine" data-text="mine    old  verify report 06:00"><span class="line">MINE    old  verify report 06:00</span></div>'));
  assert.ok(renderPage({ ...d, board: readBoardFile(`board repo 2026-09-05 07:59:00\n${d.rows.join('\n')}\n`) }, { now: NOW }).includes('</span> · unchanged since</span>'));
  assert.ok(renderPage(d, { now: NOW }).includes('>no board.txt yet</span>') && !renderPage(d, { now: NOW }).includes(' changed"'));
});

test('goals: goals.md renders at the top, collapsed, with headings, bullets, paragraphs and code, escaped', () => {
  assert.equal(mdHtml('# goals\n\n## now\n- ship `x` <b>\n- two\n  continued\n\nA para\nwraps.\n\n* star\n'), '<h3>goals</h3><h4>now</h4><ul><li>ship <code>x</code> &lt;b&gt;</li><li>two continued</li></ul><p>A para wraps.</p><ul><li>star</li></ul>');
  const d = { ...everyRow(), goals: '# goals\n\n## boundaries\n- no lane touches db/\n' };
  const html = renderPage(d, { now: NOW });
  const goals = /<section id="goals"[\s\S]*?<\/section>/.exec(html)[0];
  assert.ok(goals.includes('<details class="fold" id="goals-fold"><summary>') && !goals.includes('<details class="fold" id="goals-fold" open'), 'collapsed by default');
  assert.ok(goals.includes('<div class="md"><h3>goals</h3><h4>boundaries</h4><ul><li>no lane touches db/</li></ul></div>'));
  assert.ok(html.indexOf('<section id="goals"') < html.indexOf('<section id="board"'), 'goals sit above the board');
  assert.ok(renderPage(everyRow(), { now: NOW }).includes('no coordinator/goals.md; lane.mjs init writes the skeleton'));
});

test('history: per lane every OK line in order and the closed items that named it, collapsed; lanes with neither are left out', () => {
  const d = everyRow();
  d.lanes = [...d.lanes, ...foldStore([], 'OK v 07:30 re-verified after a fix\n').lanes];
  d.closed = foldStore([item('9-c.md', 'NOTE handed to v\nuntil: ok v\n\nbody\n'), item('8-x.md', 'DECIDE about w-lane and x\n\nnames w-lane only\n'), item('7-l.md', 'LANE d done\n')]).items;
  const h = historyOf(d);
  assert.deepEqual(h.map((l) => l.name), ['d', 'g', 'v', 'w', 'x']);
  const by = Object.fromEntries(h.map((l) => [l.name, l]));
  assert.deepEqual(by.v.oks.map((l) => l.raw), ['OK v 07:10 abc', 'OK v 07:30 re-verified after a fix']);
  assert.deepEqual(by.v.closed.map((i) => i.id), [9]);
  assert.deepEqual(by.x.closed.map((i) => i.id), [8], 'named in the text');
  assert.deepEqual(by.w.closed, [], 'w-lane is not w');
  assert.deepEqual([by.d.oks.length, by.d.closed.map((i) => i.id)], [1, [7]], 'a closed LANE item names its lane');
  assert.equal(by.g.closed.length, 0);
  const html = renderPage(d, { now: NOW });
  const hist = /<section id="history"[\s\S]*?<\/section>/.exec(html)[0];
  assert.ok(hist.includes('<details class="fold" id="history-fold"><summary>') && hist.includes('<details id="h:v"><summary><code>v</code><span class="hint">2 OK · 1 closed item</span></summary><ol><li>OK v 07:10 abc</li><li>OK v 07:30 re-verified after a fix</li></ol>'));
  assert.ok(hist.includes('#9</a> handed to v') && hist.includes('<pre class="wrap">body</pre>'));
  assert.ok(hist.includes('<details id="lanes-txt"') && hist.includes('OK g 06:00 filed-evidence\n'), 'lanes.txt as written moved here');
});

test('an EFFORT is a row and an item with its own toggle, never a node; its keys show; an until: on a GitHub number draws no edge; every kind\'s REPORT keys parse', () => {
  const effort = parseItem('16-e.md', 'EFFORT slot M naming\nsize: M\npath: research implement\nlanes: research=r14\non: issue 14\n\ncard\n');
  const step = parseItem('17-s.md', 'STEP release\nuntil: merged 12\n');
  const g = graphOf({ items: [effort, step], results: [{ name: 'r14', status: 'not_found' }], lanes: [] });
  assert.deepEqual(g.nodes.map((n) => n.id), ['lane:r14'], 'the effort and the GitHub-waiting step are off the graph');
  assert.deepEqual(g.edges, []);
  assert.deepEqual(rowSubject('EFFORT  slot M  write prompt implement  #16'), { tag: 'EFFORT', kind: 'item', id: 16, name: 'slot' });
  assert.equal(whoOfRow('EFFORT  slot M  write prompt implement  #16'), 'effort');
  assert.equal(whoOfItem(effort), 'effort');
  const html = itemDetail(effort);
  for (const k of ['size: M', 'path: research implement', 'lanes: research=r14', 'on: issue 14']) assert.ok(html.includes(`<span class="key">${k}</span>`), k);
  assert.ok(itemDetail(step).includes('<span class="key">until: merged 12</span>'));
  const rep = parseReport('REPORT r\nwhat: read\nevidence: docs\nverdict: drops\nopen: none\n');
  assert.deepEqual(rep.fields.map((f) => f.key), ['what', 'evidence', 'verdict', 'open']);
  assert.deepEqual(parseReport('REPORT m\nmap: https://x/1\ntickets: https://x/2 research t\nopen: fog\n').fields.map((f) => f.key), ['map', 'tickets', 'open']);
});
