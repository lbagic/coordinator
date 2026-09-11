#!/usr/bin/env node
// page: the board as one self-contained HTML page. The same fold as `lane.mjs
// board`, every row opening in place to everything the data holds behind it
// (prompt fields, the REPORT by field, the OK evidence, an item's whole
// body), the dependency graph drawn and focusable, filter toggles by who
// acts and a find box, the board.txt stamp with the rows changed since it,
// goals.md folded at the top, per-lane history folded at the bottom. It is
// a view: it never writes under coordinator/, and nothing it writes lands in
// the repo.
//
//   page.mjs --serve [--port N] [--cwd DIR] [--store DIR] [--ideas]
//   page.mjs [--cwd DIR] [--store DIR] [--out FILE] [--ideas]
//
// --ideas starts the page with the ideas toggle on; IDEA items are always
// in the page, hidden until that toggle.
// --serve renders the fold on every request from a localhost-only server, so
// the page's Refresh button shows fresh state; `?auto=N` reloads every N
// seconds, `/board.json` is `board --json` plus each lane's report, tail and
// ask and the fields of every prompt file. The port is
// derived from the cwd so a repo's bookmark stays stable; a second `--serve`
// for the same repo finds the port taken, asks it which repo it serves, and
// prints the running URL; a port taken by another repo (a hash collision) or
// by anything else steps to the next free one. Without
// --serve the page is written once as a file (default
// ~/.claude/coordinator/<mangled cwd>/board.html) with the data inlined,
// because a page opened from file:// cannot read the store.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardData, verifiedOf, mangle, promptField, parseItem, PROMPT_FIELDS, BOARD_FILE, GOALS_FILE, CLOSED_DIR } from './lane.mjs';

const PORT_BASE = 7300;
const PORT_SPAN = 500;
const PORT_TRIES = 10;
const NODE_W = 230;
const NODE_H = 46;
const COL_GAP = 300;
const ROW_GAP = 64;
const PAD = 24;
const SUB_CHARS = 34;

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtTs = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
// Escaped text with its URLs made links.
const linked = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

// Which lane or item a board row is about, from the row text alone; the row
// shapes are pinned by lane.test.mjs. `lanes` rows (CLOSE, DONE) name several.
export function rowSubject(row) {
  const tag = row.slice(0, 6).trim();
  const rest = row.slice(8);
  const cols = rest.split('  ');
  const idOf = (s) => {
    const m = /^#(\d+)/.exec(s);
    return m ? Number(m[1]) : null;
  };
  switch (tag) {
    case 'RUN': {
      const m = /^prompt-(\S+)\.txt/.exec(rest);
      return m ? { tag, kind: 'lane', name: m[1] } : { tag, kind: 'none' };
    }
    case 'ANSWER':
    case 'LIVE':
      return { tag, kind: 'lane', name: cols[0] };
    case 'DECIDE':
    case 'STEP': {
      const id = idOf(rest);
      return id == null ? { tag, kind: 'none' } : { tag, kind: 'item', id };
    }
    case 'EFFORT': {
      const id = idOf(cols[cols.length - 1] || '');
      return id == null ? { tag, kind: 'none' } : { tag, kind: 'item', id, name: cols[0].split(' ')[0] };
    }
    case 'CLOSE':
      return { tag, kind: 'lanes', names: cols.map((c) => c.split(' ')[0]), filed: 0 };
    case 'MINE': {
      const id = idOf(rest);
      if (id != null) return { tag, kind: 'item', id };
      if (rest.startsWith('digest: ')) return { tag, kind: 'none' };
      if (rest.startsWith('file: ')) return { tag, kind: 'items', ids: [...rest.matchAll(/#(\d+)/g)].map((m) => Number(m[1])) };
      const stale = /^stale: OK (\S+)/.exec(rest);
      if (stale) return { tag, kind: 'lane', name: stale[1] };
      const plan = /^(\S+)  write prompt .*  #(\d+)$/.exec(rest);
      if (plan) return { tag, kind: 'item', id: Number(plan[2]), name: plan[1] };
      if (cols[0].endsWith('.md')) return { tag, kind: 'item', file: cols[0] };
      return { tag, kind: 'lane', name: cols[0] };
    }
    case 'DONE': {
      // A count: the lanes behind it are named from the data, not the row.
      const n = (word) => Number((new RegExp(`(\\d+) ${word}`).exec(rest) || [0, 0])[1]);
      return { tag, kind: 'lanes', names: [], verified: n('verified'), filed: n('filed') };
    }
    default:
      return { tag, kind: 'none' };
  }
}

// The five fields of a prompt file; all empty for a hand-written prompt.
export function promptFields(text) {
  return Object.fromEntries(PROMPT_FIELDS.map(([key, label]) => [key, promptField(text, label)]));
}

// A REPORT block: the name from its first line, then the keys of any kind's
// template (what, commits, pr, checks, open, evidence, verdict, brief,
// decisions, ruling, case, findings, map, tickets) with their continuation
// lines; text before the first key is one unnamed field.
export function parseReport(text) {
  const out = { name: null, fields: [] };
  let cur = null;
  for (const l of String(text || '').trimEnd().split('\n')) {
    const h = /^REPORT (\S+)\s*$/.exec(l);
    if (h && out.name == null) {
      out.name = h[1];
      continue;
    }
    const m = /^(what|commits|pr|checks|open|evidence|verdict|brief|decisions|ruling|case|findings|map|tickets):\s*(.*)$/.exec(l);
    if (m) {
      cur = { key: m[1], text: m[2] };
      out.fields.push(cur);
      continue;
    }
    if (cur) cur.text += `\n${l}`;
    else {
      cur = { key: '', text: l };
      out.fields.push(cur);
    }
  }
  for (const f of out.fields) f.text = f.text.trim();
  return out;
}

const field = (label, inner) => (inner ? `<div class="f"><b>${esc(label)}</b>${inner}</div>` : '');
const para = (label, text) => field(label, text ? `<p class="wrap">${linked(text)}</p>` : '');

function reportHtml(text) {
  const rep = parseReport(text);
  const list = (f) => {
    const lines = f.text.split('\n').map((s) => s.trim()).filter(Boolean);
    return `<ul>${lines.map((l) => `<li>${f.key === 'commits' ? esc(l).replace(/^([0-9a-f]{7,40})\b/, '<code>$1</code>') : linked(l)}</li>`).join('')}</ul>`;
  };
  return rep.fields.map((f) => field(f.key || 'report', f.key === 'commits' || f.key === 'checks' ? list(f) : `<p class="wrap">${linked(f.text)}</p>`)).join('');
}

function promptHtml(name, text) {
  const f = promptFields(text);
  const any = PROMPT_FIELDS.some(([k]) => f[k]);
  return `<div class="sec"><h4>prompt-${esc(name)}.txt</h4>${any ? PROMPT_FIELDS.map(([k, label]) => para(label, f[k])).join('') : `<pre class="wrap">${esc(text.trim())}</pre>`}</div>`;
}

const keysHtml = (it) =>
  [it.size && `size: ${it.size}`, it.path.length && `path: ${it.path.join(' ')}`, Object.keys(it.lanes).length && `lanes: ${Object.entries(it.lanes).map(([k, v]) => `${k}=${v}`).join(' ')}`, it.on && `on: ${it.on.type} ${it.on.n}`, it.after.length && `after: ${it.after.join(' ')}`, it.blocks.length && `blocks: ${it.blocks.join(' ')}`, it.until && `until: ${it.until.kind} ${it.until.lane || it.until.n}`, it.source && `source: ${it.source}`, it.opened && `opened: ${it.opened}`]
    .filter(Boolean)
    .map((k) => `<span class="key">${esc(k)}</span>`)
    .join('');
const itemRef = (it) => `<a href="#i${it.id ?? ''}"><span class="kind">${esc(it.kind)}</span> #${it.id ?? '?'}</a>${it.name ? ` <code>${esc(it.name)}</code>` : ''} ${esc(it.head)}`;

// Everything the store holds about one item: keys, faults, the whole body
// with its line breaks, the file.
export function itemDetail(it) {
  const keys = keysHtml(it);
  return `<div class="detail item-detail">${keys ? `<div class="keys">${keys}</div>` : ''}${it.bad.length ? `<p class="bad">${it.bad.map(esc).join('<br>')}</p>` : ''}${it.body ? `<pre class="wrap">${esc(it.body)}</pre>` : '<p class="empty">no body</p>'}<p class="file">${esc(it.file)}</p></div>`;
}

// Everything the data holds about one lane: its status line, what it asked,
// the REPORT by field, the last message, the OK that verified it, the prompt
// file's fields (or the whole file when hand-written), the items naming it.
export function laneDetail(name, data) {
  const r = data.results.find((x) => x.name === name);
  const oks = data.lanes.filter((l) => l.tag === 'OK' && l.name === name);
  const ok = oks[oks.length - 1];
  const text = (data.prompts || {})[name];
  const items = data.items.filter((i) => i.name === name || i.blocks.includes(name) || i.after.includes(name) || (i.until && i.until.lane === name));
  const meta = [];
  if (r) {
    meta.push(r.status.replace('_', ' '));
    if (r.peer) meta.push(`peer ${r.peer}`);
    if (r.session) meta.push(`session ${r.session.slice(0, 8)}`);
    if (r.prompt_at) meta.push(`prompt ${fmtTs(r.prompt_at)}`);
    if (r.closed_at) meta.push(`report ${fmtTs(r.closed_at)}`);
    if (r.moved_at) meta.push(`moved ${fmtTs(r.moved_at)}`);
    if (r.stopped_at) meta.push(`stopped ${fmtTs(r.stopped_at)}`);
    if (r.worker_ctx) meta.push(`worker ctx ${r.worker_ctx}`);
  } else meta.push(ok ? 'filed: an OK line, no prompt file' : 'no prompt file, no OK');
  const parts = [`<p class="meta">${meta.map(esc).join(' · ')}</p>`];
  if (r && r.ask) parts.push(`<div class="sec">${para('asked', r.ask)}</div>`);
  if (r && r.report) parts.push(`<div class="sec"><h4>report</h4>${reportHtml(r.report)}</div>`);
  if (r && r.tail) parts.push(`<div class="sec"><h4>last message</h4><pre class="wrap">${esc(r.tail.trim())}</pre></div>`);
  if (ok) parts.push(`<div class="sec"><h4>verified</h4><p class="mono">${linked(ok.raw)}</p></div>`);
  if (text) parts.push(promptHtml(name, text));
  if (items.length) parts.push(`<div class="sec"><h4>items naming it</h4><ul class="refs">${items.map((i) => `<li>${itemRef(i)}</li>`).join('')}</ul></div>`);
  return `<div class="detail lane-detail">${parts.join('')}</div>`;
}

// Who acts on a row or an item, for the filter toggles: you (RUN, ANSWER,
// DECIDE, STEP, CLOSE), live, mine, done, ideas; bad and ctx have no toggle.
const WHO = { RUN: 'you', ANSWER: 'you', DECIDE: 'you', STEP: 'you', CLOSE: 'you', EFFORT: 'effort', LIVE: 'live', MINE: 'mine', DONE: 'done', BAD: 'bad', CTX: 'ctx' };
export const whoOfRow = (row) => WHO[row.slice(0, 6).trim()] || 'mine';
export const whoOfItem = (it) => (it.kind === 'DECIDE' || it.kind === 'STEP' ? 'you' : it.kind === 'IDEA' ? 'ideas' : it.kind === 'EFFORT' ? 'effort' : 'mine');

// coordinator/board.txt: line 1 `board <repo> <date> <time>`, then the rows
// as `lane.mjs delta` wrote them.
export function readBoardFile(text) {
  const [head, ...rest] = String(text || '').split('\n');
  const m = /^board (\S+) (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/.exec(head.trim());
  return { stamp: m ? `${m[2]} ${m[3]}` : null, repo: m ? m[1] : null, rows: rest.filter((r) => r.trim()) };
}

// The rows that appeared since board.txt (added) and the ones it had that
// are gone; CTX is never a change, as in `lane.mjs delta`.
export function boardDiff(prevRows, rows) {
  const body = (rs) => rs.filter((r) => !r.startsWith('CTX'));
  const prev = new Set(body(prevRows || []));
  const next = new Set(body(rows));
  return { added: new Set([...next].filter((r) => !prev.has(r))), gone: [...prev].filter((r) => !next.has(r)) };
}

// goals.md, escaped, with only what the skeleton uses: headings, bullets,
// paragraphs, `code`.
export function mdHtml(md) {
  const out = [];
  let list = [];
  let para = [];
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    list = [];
    para = [];
  };
  for (const raw of String(md || '').split('\n')) {
    const l = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    const b = /^\s*[-*]\s+(.*)$/.exec(l);
    if (h) {
      flush();
      const level = Math.min(h[1].length + 2, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    } else if (b) {
      if (para.length) flush();
      list.push(b[1]);
    } else if (!l.trim()) flush();
    else if (list.length && /^\s/.test(raw)) list[list.length - 1] += ` ${l.trim()}`;
    else {
      if (list.length) flush();
      para.push(l.trim());
    }
  }
  flush();
  return out.join('');
}

// Per lane: every OK line in order, and the closed items that named it in a
// header key, as their lane, or in their text. Lanes with neither are left
// out. `data.closed` is the parsed closed/ directory.
export function historyOf(data) {
  const names = new Set([...data.results.map((r) => r.name), ...data.lanes.filter((l) => l.tag === 'OK' && l.name).map((l) => l.name), ...data.items.filter((i) => i.name).map((i) => i.name)]);
  const closed = data.closed || [];
  const out = [];
  for (const name of [...names].sort()) {
    const re = new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    const oks = data.lanes.filter((l) => l.tag === 'OK' && l.name === name);
    const named = closed.filter((it) => it.name === name || it.after.includes(name) || it.blocks.includes(name) || (it.until && it.until.lane === name) || re.test(`${it.head}\n${it.body}`));
    if (oks.length || named.length) out.push({ name, oks, closed: named });
  }
  return out;
}

// The detail behind one board row, or '' for a row with nothing behind it.
export function rowDetail(subject, data) {
  const byId = (id) => data.items.find((i) => i.id === id);
  const named = (it) => `<div class="sec"><h4>${itemRef(it)}</h4>${itemDetail(it)}</div>`;
  switch (subject.kind) {
    case 'lane':
      return laneDetail(subject.name, data);
    case 'item': {
      const it = subject.file ? data.items.find((i) => i.file === subject.file) : byId(subject.id);
      return it ? itemDetail(it) : `<div class="detail"><p class="empty">not in the store</p></div>`;
    }
    case 'items':
      return `<div class="detail">${subject.ids.map((id) => byId(id)).filter(Boolean).map(named).join('') || '<p class="empty">not in the store</p>'}</div>`;
    case 'lanes': {
      const fileNames = new Set(data.results.map((r) => r.name));
      const filed = subject.filed ? [...new Set(data.lanes.filter((l) => l.tag === 'OK' && l.name && !fileNames.has(l.name)).map((l) => l.name))] : [];
      const lane = (n) => `<div class="sec"><h4>${esc(n)}</h4>${laneDetail(n, data)}</div>`;
      const verified = subject.verified ? verifiedOf(data.results, { lanes: data.lanes }) : null;
      const names = verified ? data.results.filter((r) => verified(r.name) && !r.session_open).map((r) => r.name) : subject.names;
      return `<div class="detail">${names.map(lane).join('')}${filed.length ? `<div class="sec"><h4>${filed.length} filed: an OK line each, no prompt file</h4><ul class="refs">${filed.map((n) => `<li>${linked(data.lanes.filter((l) => l.tag === 'OK' && l.name === n).pop().raw)}</li>`).join('')}</ul></div>` : ''}</div>`;
    }
    default:
      return '';
  }
}

// Nodes are lanes and the items that hold or wait on them. An edge points from
// the waiter to what it waits on: after (lane to lane), blocks (lane to the
// item holding it), until (item to the lane whose OK closes it). IDEA and EFFORT items
// are not drawn. LANE and HOLD items are facts about their lane's node.
export function graphOf(data) {
  const nodes = new Map();
  const edges = [];
  const results = new Map(data.results.map((r) => [r.name, r]));
  const okNames = new Set(data.lanes.filter((l) => l.tag === 'OK' && l.name).map((l) => l.name));
  const planned = new Set(data.items.filter((i) => i.kind === 'LANE' && i.name).map((i) => i.name));
  const laneNode = (name) => {
    const id = `lane:${name}`;
    if (!nodes.has(id)) {
      const r = results.get(name);
      nodes.set(id, { id, type: 'lane', label: name, status: r ? r.status : okNames.has(name) ? 'filed' : planned.has(name) ? 'planned' : 'unknown', peer: (r && r.peer) || null, held: false, head: '' });
    }
    return nodes.get(id);
  };
  for (const r of data.results) laneNode(r.name);
  for (const it of data.items) {
    // An EFFORT names its lanes in `lanes:`; it is a row and an item, never a
    // node: the graph draws what waits on what, and an effort waits on nothing.
    if (it.kind === 'IDEA' || it.kind === 'EFFORT') continue;
    if (it.name) {
      const n = laneNode(it.name);
      if (it.kind === 'HOLD') n.held = true;
      if (it.kind === 'LANE' && it.head) n.head = it.head;
      for (const t of it.after) {
        laneNode(t);
        edges.push({ from: n.id, to: `lane:${t}`, kind: 'after' });
      }
      continue;
    }
    const id = `item:${it.id ?? it.file}`;
    nodes.set(id, { id, type: 'item', kind: it.kind, label: `${it.kind} #${it.id ?? '?'}`, head: it.head || it.raw || '' });
    for (const t of it.blocks) {
      laneNode(t);
      edges.push({ from: `lane:${t}`, to: id, kind: 'blocks' });
    }
    // `until: merged <n>` and `until: closed <n>` wait on GitHub, not a lane.
    if (it.until && it.until.lane) {
      laneNode(it.until.lane);
      edges.push({ from: id, to: `lane:${it.until.lane}`, kind: 'until' });
    }
  }
  // An item with no edge is on the Items list, not in a dependency graph.
  const touched = new Set(edges.flatMap((e) => [e.from, e.to]));
  return { nodes: [...nodes.values()].filter((n) => n.type === 'lane' || touched.has(n.id)), edges };
}

// Columns by depth: a node with nothing to wait on sits in column 0, a waiter
// one column right of the deepest thing it waits on. A cycle (already a BAD
// row) is cut where it is met.
export function layout(graph) {
  const out = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) if (out.has(e.from)) out.get(e.from).push(e.to);
  const depth = new Map();
  const visit = (id, stack) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const d = (out.get(id) || []).reduce((m, t) => Math.max(m, 1 + visit(t, stack)), 0);
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const n of graph.nodes) visit(n.id, new Set());
  const cols = new Map();
  for (const n of graph.nodes) {
    const d = depth.get(n.id) || 0;
    cols.set(d, [...(cols.get(d) || []), n]);
  }
  const pos = new Map();
  let rows = 0;
  for (const [d, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => (a.type === b.type ? a.label.localeCompare(b.label) : a.type === 'lane' ? -1 : 1));
    list.forEach((n, i) => pos.set(n.id, { x: PAD + d * COL_GAP, y: PAD + i * ROW_GAP }));
    rows = Math.max(rows, list.length);
  }
  const ncols = cols.size || 1;
  return { pos, depth, width: PAD * 2 + (ncols - 1) * COL_GAP + NODE_W, height: PAD * 2 + Math.max(rows - 1, 0) * ROW_GAP + NODE_H };
}

// What a node waits on (up: drawn to its left) and what waits on it (down:
// to its right), transitively, along the edges from waiter to waited-on. A
// held lane's up set holds its blockers; a DECIDE's down set what it unblocks.
export function focusOf(graph, id) {
  const out = new Map();
  const inn = new Map();
  for (const e of graph.edges) {
    out.set(e.from, [...(out.get(e.from) || []), e.to]);
    inn.set(e.to, [...(inn.get(e.to) || []), e.from]);
  }
  const walk = (next) => {
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      for (const t of next.get(stack.pop()) || []) {
        if (t === id || seen.has(t)) continue;
        seen.add(t);
        stack.push(t);
      }
    }
    return seen;
  };
  return { up: walk(out), down: walk(inn) };
}

function svgOf(graph) {
  const { pos, width, height } = layout(graph);
  const box = (n) => {
    const p = pos.get(n.id);
    const cls = n.type === 'lane' ? `lane ${n.status}${n.held ? ' held' : ''}` : `item ${n.kind.toLowerCase()}`;
    const sub = n.type === 'lane' ? `${n.held ? 'held' : n.status.replace('_', ' ')}${n.peer ? ` · ${n.peer}` : ''}${n.head && !n.peer ? ` · ${n.head}` : ''}` : n.head;
    const { up, down } = focusOf(graph, n.id);
    return `<g class="node ${esc(cls)}" data-id="${esc(n.id)}" data-up="${esc([...up].join(' '))}" data-down="${esc([...down].join(' '))}" data-text="${esc(`${n.label} ${sub}`.toLowerCase())}" tabindex="0" role="button" aria-label="${esc(n.label)}: focus and open its context"><title>${esc(n.type === 'lane' ? `${n.label}: ${sub}` : n.head)}</title><rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="6"/><text x="${p.x + 10}" y="${p.y + 19}" class="label">${esc(trunc(n.label, SUB_CHARS))}</text><text x="${p.x + 10}" y="${p.y + 36}" class="sub">${esc(trunc(sub, SUB_CHARS))}</text></g>`;
  };
  const line = (e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return '';
    const x1 = a.x;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x + NODE_W;
    const y2 = b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return `<path class="edge ${e.kind}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" marker-end="url(#arrow)"><title>${esc(`${e.kind}: ${e.from.split(':')[1]} → ${e.to.split(':')[1]}`)}</title></path>`;
  };
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>${graph.edges.map(line).join('')}${graph.nodes.map(box).join('')}</svg>`;
}

const KIND_ORDER = ['EFFORT', 'DECIDE', 'STEP', 'LANE', 'HOLD', 'NOTE', 'IDEA'];

// Minimal / Swiss, dense, slate palette with one status green; monospace for
// everything that is also text in the terminal, sans for chrome. Status is
// never colour alone: every node carries its status word and a stroke style.
// No web fonts: the page must open from file:// with nothing to fetch.
// Theme: light tokens on bare :root; the dark set applies under the OS
// preference unless data-theme="light", and under data-theme="dark" always,
// so the toggle wins in both directions. The dark set is written once here
// and emitted twice.
const DARK = `color-scheme:dark;--bg:#0F172A;--fg:#F8FAFC;--card:#1B2336;--muted:#272F42;--muted-fg:#94A3B8;--border:#475569;--ring:#F8FAFC;
--accent:#22C55E;--destructive:#EF4444;--blue:#60A5FA;--violet:#A78BFA;--amber:#FBBF24;--edge:#90A4AE`;
const THEME_KEY = 'board-theme';
const CSS = `
:root{color-scheme:light;
--bg:#F8FAFC;--fg:#0F172A;--card:#FFFFFF;--muted:#F1F5F9;--muted-fg:#475569;--border:#CBD5E1;--ring:#0F172A;
--accent:#15803D;--destructive:#B91C1C;--blue:#1D4ED8;--violet:#6D28D9;--amber:#B45309;--edge:#64748B;
--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px;
--mono:"JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--sans:"IBM Plex Sans","Fira Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
:root[data-theme="dark"]{${DARK}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
*{box-sizing:border-box}html{font-size:16px}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}code{font-family:var(--mono);font-size:.92em}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:4px}
header{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-6);align-items:baseline;padding:var(--space-3) var(--space-6);background:var(--bg);border-bottom:1px solid var(--border)}
header h1{font:500 18px/1.2 var(--mono);margin:0}
header .meta{color:var(--muted-fg);font:12px/1.4 var(--mono)}header .meta b{color:var(--destructive);font-weight:600}
header .stale{color:var(--amber);font-weight:600}
header nav{margin-left:auto;display:flex;gap:var(--space-4);font-size:13px}header nav a{color:var(--muted-fg);text-decoration:none;padding:var(--space-1) 0;border-bottom:1px solid transparent;transition:color .2s,border-color .2s}
header nav a:hover{color:var(--fg);border-color:var(--fg)}
main{padding:var(--space-4) var(--space-6);display:grid;gap:var(--space-6)}main>section{min-width:0}
section h2{font:500 12px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted-fg);margin:0 0 var(--space-2);display:flex;gap:var(--space-3);align-items:baseline}
section h2 .hint{text-transform:none;letter-spacing:0;font-weight:400}
pre{margin:0;background:var(--muted);padding:var(--space-3);border-radius:6px;overflow-x:auto;font:13px/1.5 var(--mono);white-space:pre;color:var(--fg)}
.board{background:var(--muted);padding:var(--space-2) var(--space-3);border-radius:6px;overflow-x:auto;font:13px/1.6 var(--mono);color:var(--fg)}
.board .line{display:block;white-space:pre;padding:0 var(--space-1);border-radius:3px;transition:background .15s}
.board div.row{padding-left:16px}
.board details.row>summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:6px}
.board details.row>summary::-webkit-details-marker{display:none}
.board details.row>summary::before{content:"▸";color:var(--muted-fg);font-size:11px;width:10px;flex:none;transition:transform .2s}.board details.row[open]>summary::before{transform:rotate(90deg)}
.board .row:hover>.line,.board .row:hover>summary>.line{background:var(--card)}
.board .BAD>.line,.board .BAD>summary>.line{color:var(--destructive);font-weight:600}
.board .RUN>summary>.line,.board .ANSWER>summary>.line,.board .DECIDE>summary>.line,.board .STEP>summary>.line,.board .CLOSE>summary>.line{color:var(--amber)}
.board .LIVE>summary>.line,.board .EFFORT>summary>.line{color:var(--accent)}.board .DONE>summary>.line,.board .CTX>.line{color:var(--muted-fg)}
.detail{margin:var(--space-2) 0 var(--space-3) 16px;padding:var(--space-3) var(--space-4);background:var(--card);border:1px solid var(--border);border-radius:6px;font:13px/1.5 var(--sans);color:var(--fg);white-space:normal;max-width:110ch}
.detail .detail{margin-left:0}
.detail .meta{margin:0;font:12px/1.5 var(--mono);color:var(--muted-fg)}.detail .mono{margin:0;font:12.5px/1.5 var(--mono)}
.detail .sec{margin-top:var(--space-3)}.detail h4{margin:0 0 var(--space-1);font:500 11px/1.4 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted-fg)}
.detail h4 a,.detail h4 code{text-transform:none;letter-spacing:0;font-size:12px}
.detail .f{display:grid;grid-template-columns:9ch minmax(0,1fr);gap:var(--space-1) var(--space-3);margin:0 0 var(--space-2)}.detail .f:last-child{margin-bottom:0}
.detail .f b{font:500 12px/1.6 var(--mono);color:var(--muted-fg)}.detail .f p,.detail .f ul{margin:0;min-width:0}.detail ul{padding-left:1.2em}.detail li{margin:0 0 2px}
.detail .refs{list-style:none;padding:0}.detail .refs a{text-decoration:none}.detail .refs a:hover{text-decoration:underline}
.detail pre.wrap{white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 var(--mono);background:var(--muted);padding:var(--space-2) var(--space-3);border-radius:4px;margin:0}
.detail p.wrap{white-space:pre-wrap;word-break:break-word}.detail a{color:var(--blue)}
.detail .keys{display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-2);margin:0 0 var(--space-2)}.detail .file{margin-top:var(--space-2)}
#graph-detail{margin-top:var(--space-2)}#graph-detail .bar{display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);font:12.5px/1.5 var(--mono);color:var(--muted-fg)}
#graph-detail>.detail{margin:var(--space-1) 0 0}
.graph{overflow-x:auto;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:var(--space-2)}
svg text{font:12px var(--mono);fill:var(--fg)}svg text.sub{font-size:10.5px;fill:var(--muted-fg)}
svg .node{cursor:pointer;outline:none;transition:opacity .2s}svg .node:focus-visible rect{stroke:var(--ring);stroke-width:3}
svg.focused .node:not(.focus):not(.up):not(.down),svg .node.off{opacity:.18}svg.focused .edge:not(.lit){opacity:.12}
svg .node.focus rect{stroke:var(--ring)!important;stroke-width:3!important}svg .node.up rect,svg .node.down rect{stroke-width:3}
svg.focused .edge.lit{stroke-opacity:1;stroke-width:2.2}svg .edge{transition:opacity .2s}
svg .node rect{fill:var(--card);stroke:var(--blue);stroke-width:1.5;transition:stroke-width .15s}svg .node:hover rect{stroke-width:3}
svg .in_progress rect,svg .stalled rect{stroke:var(--accent);stroke-width:2.5}
svg .finished rect,svg .continued rect,svg .stopped rect,svg .exited rect{stroke:var(--violet)}
svg .held rect{stroke:var(--amber);stroke-width:2.5;stroke-dasharray:8 3}
svg .filed rect{stroke:var(--muted-fg);stroke-dasharray:3 3}svg .planned rect{stroke:var(--blue);stroke-dasharray:6 3}svg .unknown rect{stroke:var(--destructive);stroke-dasharray:2 2}
svg .item rect{rx:16;fill:var(--muted)}svg .decide rect,svg .step rect{stroke:var(--amber)}svg .note rect{stroke:var(--muted-fg)}
svg .edge{fill:none;stroke:var(--edge);stroke-opacity:.6;stroke-width:1.4}svg .edge.blocks{stroke:var(--amber);stroke-opacity:.9}svg .edge.until{stroke-dasharray:4 3}svg marker path{fill:var(--edge)}
.legend{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-4);margin:var(--space-2) 0 0;padding:0;list-style:none;font:11.5px/1.4 var(--mono);color:var(--muted-fg)}
.legend li{display:flex;align-items:center;gap:6px}.legend i{display:inline-block;width:22px;height:12px;border:1.5px solid var(--blue);border-radius:3px;background:var(--card)}
.legend .l-live{border-color:var(--accent);border-width:2.5px}.legend .l-report{border-color:var(--violet)}.legend .l-held{border-color:var(--amber);border-width:2.5px;border-style:dashed}
.legend .l-filed{border-color:var(--muted-fg);border-style:dotted}.legend .l-planned{border-color:var(--blue);border-style:dashed}.legend .l-unknown{border-color:var(--destructive);border-style:dotted}
.legend .l-item{border-radius:8px;background:var(--muted);border-color:var(--muted-fg)}.legend .l-user{border-radius:8px;background:var(--muted);border-color:var(--amber)}
.legend .l-edge{height:0;border:0;border-top:1.5px solid var(--edge)}.legend .l-blocks{height:0;border:0;border-top:1.5px solid var(--amber)}.legend .l-until{height:0;border:0;border-top:1.5px dashed var(--edge)}
.items{display:grid;gap:var(--space-2)}
details.item{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:var(--space-2) var(--space-3);transition:border-color .2s}details.item:hover{border-color:var(--muted-fg)}
details.item summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--space-1) var(--space-2);min-height:28px}
details.item summary::-webkit-details-marker{display:none}details.item summary::before{content:"▸";color:var(--muted-fg);font-size:11px;width:10px;transition:transform .2s}details.item[open] summary::before{transform:rotate(90deg)}
.kind{display:inline-block;font:11px/1.6 var(--mono);padding:0 6px;border-radius:4px;border:1px solid var(--border);color:var(--muted-fg)}
.decide .kind,.step .kind{border-color:var(--amber);color:var(--amber)}.lane .kind{border-color:var(--blue);color:var(--blue)}.hold .kind{border-color:var(--amber);color:var(--amber)}.idea .kind{border-style:dashed}
.id{color:var(--muted-fg);font:12px var(--mono)}.head{flex:1 1 60ch;min-width:0}
.key{display:inline-block;color:var(--muted-fg);font:11.5px/1.6 var(--mono);background:var(--muted);padding:0 6px;border-radius:4px}
details.item>.detail{margin:var(--space-2) 0 var(--space-1);padding:var(--space-2) 0 0;border:0;border-top:1px solid var(--border);border-radius:0;max-width:none}
.file,.empty{color:var(--muted-fg);font:11px/1.4 var(--mono);margin:var(--space-2) 0 0}.bad{color:var(--destructive);margin:0 0 var(--space-2);font:12.5px/1.5 var(--mono)}
.table{overflow-x:auto}table{border-collapse:collapse;font:12.5px/1.5 var(--mono);min-width:100%}
td,th{text-align:left;padding:var(--space-1) var(--space-4) var(--space-1) 0;border-bottom:1px solid var(--border);vertical-align:top;white-space:nowrap}th{color:var(--muted-fg);font-weight:500}
tr:hover td{background:var(--muted)}
.none{color:var(--muted-fg);font-size:13px;margin:0}
.btn{font:12.5px/1 var(--sans);min-height:30px;padding:0 var(--space-3);border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:border-color .2s,background .2s}
.btn:hover{border-color:var(--fg)}.btn.on{border-color:var(--accent);color:var(--accent)}header nav .btn{padding:0 var(--space-3);border-bottom:1px solid var(--border)}
header .stamp{color:var(--fg);font-weight:600}header .changed{color:var(--amber);font-weight:600}
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);font:12.5px/1.4 var(--sans);color:var(--muted-fg)}
.tog{font:12px/1 var(--mono);min-height:26px;padding:0 10px;border:1px solid var(--border);border-radius:999px;background:var(--card);color:var(--muted-fg);cursor:pointer;transition:border-color .2s,color .2s}
.tog.on{border-color:var(--fg);color:var(--fg)}.tog:hover{border-color:var(--fg)}
.tools input{font:12.5px/1 var(--mono);min-height:26px;padding:0 10px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--fg);min-width:24ch;margin-left:var(--space-2)}
.board .row.changed{box-shadow:inset 3px 0 var(--amber)}.board .row.changed>summary>.line::after,.board .row.changed>.line::after{content:"  changed since board";color:var(--amber);font-size:11px}
.board .row.gone>.line{color:var(--muted-fg);text-decoration:line-through}.board .sep{margin:var(--space-2) 0 0;padding-left:16px;color:var(--muted-fg);font-size:11.5px}
details.fold>summary{cursor:pointer;list-style:none;display:flex;gap:var(--space-2);align-items:baseline}details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::before{content:"▸";color:var(--muted-fg);font-size:11px;width:10px;transition:transform .2s}details.fold[open]>summary::before{transform:rotate(90deg)}
details.fold>summary h2{margin:0}
.md{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:var(--space-3) var(--space-4);max-width:100ch;font-size:13.5px}
.md h3{font:600 14px/1.4 var(--sans);margin:0 0 var(--space-2)}.md h4{font:500 11.5px/1.4 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted-fg);margin:var(--space-3) 0 var(--space-1)}.md h3+h4{margin-top:0}
.md p,.md ul{margin:0 0 var(--space-2)}.md ul{padding-left:1.2em}.md li{margin:0 0 2px}
.hist{display:grid;gap:var(--space-1)}.hist details{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:var(--space-1) var(--space-3)}
.hist summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:baseline;font:12.5px/1.6 var(--mono)}.hist summary::-webkit-details-marker{display:none}
.hist summary::before{content:"▸";color:var(--muted-fg);font-size:11px;width:10px;transition:transform .2s}.hist details[open]>summary::before{transform:rotate(90deg)}
.hist ol{margin:var(--space-1) 0 var(--space-2);padding-left:1.4em;font:12.5px/1.5 var(--mono)}.hist ol li{margin:0 0 2px;white-space:pre-wrap;word-break:break-word}
.hist .detail{margin:var(--space-1) 0 var(--space-2)}
footer{padding:var(--space-3) var(--space-6) var(--space-6);color:var(--muted-fg);font-size:12px}
@media (max-width:640px){header,main,footer{padding-left:var(--space-4);padding-right:var(--space-4)}header{position:static}header nav{margin-left:0}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

// The same payload `lane.mjs board --json` prints, plus when it was written,
// each lane's report, tail and ask, and the fields of every prompt file; `<`
// is escaped so it can sit inside a <script> block.
export function jsonOf(data, written) {
  const results = data.results.map((r) => ({ name: r.name, status: r.status, peer: r.peer || null, session: r.session || null, prompt_at: r.prompt_at || null, closed_at: r.closed_at || null, moved_at: r.moved_at || null, stopped_at: r.stopped_at || null, worker_ctx: r.worker_ctx || null, report: r.report || null, tail: r.tail || null, ask: r.ask || null }));
  const prompts = Object.fromEntries(Object.entries(data.prompts || {}).map(([name, text]) => [name, promptFields(text)]));
  return JSON.stringify({ written, repo: data.repo, cwd: data.cwd || null, rows: data.rows, items: data.items.map(({ body, ...i }) => i), lanes: data.lanes, results, prompts, board: data.board || null }).replace(/</g, '\\u003c');
}

const autoSecs = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 0;
};

// opts.mode: 'snapshot' (a file) or 'serve' (rendered per request; opts.auto
// seconds reloads through ?auto=N).
export function renderPage(data, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const mode = opts.mode || 'snapshot';
  const reloadEvery = mode === 'serve' ? autoSecs(opts.auto) : 0;
  const graph = graphOf(data);
  const items = [...data.items].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.id ?? 0) - (b.id ?? 0));
  const ideas = data.items.filter((i) => i.kind === 'IDEA').length;
  const board = data.board && data.board.stamp ? data.board : null;
  const diff = boardDiff(board ? board.rows : null, data.rows);
  // A row with context behind it is a <details> whose id names its subject,
  // so the open set survives a reload; BAD and CTX rows are plain lines. A
  // row board.txt lacks is marked changed; rows it had that are gone follow.
  const rowHtml = (r) => {
    const s = rowSubject(r);
    const inner = rowDetail(s, data);
    const changed = board && diff.added.has(r) ? ' changed' : '';
    const attrs = `data-who="${whoOfRow(r)}" data-text="${esc(r.toLowerCase())}"${changed ? ` title="not on board ${esc(board.stamp)}"` : ''}`;
    if (!inner) return `<div class="row ${esc(s.tag)}${changed}" ${attrs}><span class="line">${esc(r)}</span></div>`;
    const subject = s.kind === 'lane' ? `lane:${s.name}` : s.kind === 'item' ? `item:${s.id ?? s.file}` : s.kind;
    return `<details class="row ${esc(s.tag)}${changed}" id="row:${esc(s.tag)}:${esc(subject)}" ${attrs}><summary><span class="line">${esc(r)}</span></summary>${inner}</details>`;
  };
  const goneHtml = diff.gone.length ? `<p class="sep">gone since board ${esc(board.stamp)}</p>${diff.gone.map((r) => `<div class="row gone" data-who="${whoOfRow(r)}" data-text="${esc(r.toLowerCase())}"><span class="line">${esc(r)}</span></div>`).join('')}` : '';
  const itemHtml = (it) =>
    `<details class="item ${esc(it.kind.toLowerCase())}" id="i${it.id ?? ''}" data-who="${whoOfItem(it)}" data-text="${esc(`${it.name || ''} ${it.head}`.trim().toLowerCase())}"${it.kind === 'IDEA' && !opts.ideas ? ' hidden' : ''}><summary><span class="kind">${esc(it.kind)}</span><span class="id">#${it.id ?? '?'}</span>${it.name ? `<code>${esc(it.name)}</code>` : ''}<span class="head">${esc(it.head || (it.kind ? '' : it.raw))}</span>${keysHtml(it)}</summary>${itemDetail(it)}</details>`;
  const tog = (who, on) => `<button type="button" class="tog${on ? ' on' : ''}" data-who="${who}" aria-pressed="${on ? 'true' : 'false'}">${who}</button>`;
  const tools = `<div class="tools" role="toolbar" aria-label="filter rows, nodes and items"><span>show</span>${['you', 'effort', 'live', 'mine', 'done'].map((w) => tog(w, true)).join('')}${tog('ideas', !!opts.ideas)}<input type="search" id="find" placeholder="lane or headline" aria-label="find by lane name or headline" autocomplete="off"><span id="found" aria-live="polite"></span></div>`;
  const history = historyOf(data);
  const histHtml = (h) =>
    `<details id="h:${esc(h.name)}"><summary><code>${esc(h.name)}</code><span class="hint">${h.oks.length} OK · ${h.closed.length} closed item${h.closed.length === 1 ? '' : 's'}</span></summary>${h.oks.length ? `<ol>${h.oks.map((l) => `<li>${linked(l.raw)}</li>`).join('')}</ol>` : ''}${h.closed.map((it) => `<div class="sec"><h4>${itemRef(it)}</h4>${itemDetail(it)}</div>`).join('')}</details>`;
  // One template per graph node; a click clones it under the graph.
  const nodeTemplate = (n) => {
    const it = n.type === 'item' && data.items.find((i) => `item:${i.id ?? i.file}` === n.id);
    return `<template id="t:${esc(n.id)}">${n.type === 'lane' ? laneDetail(n.label, data) : it ? itemDetail(it) : ''}</template>`;
  };
  const laneRow = (r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.status.replace('_', ' '))}</td><td>${esc(r.peer || (r.session ? r.session.slice(0, 8) : ''))}</td><td>${esc(r.prompt_at || '')}</td><td>${esc(r.moved_at || r.closed_at || r.stopped_at || '')}</td></tr>`;
  const ctx = data.rows.find((r) => r.startsWith('CTX')) || '';
  const bad = data.rows.filter((r) => r.startsWith('BAD')).length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const ctxNum = (key, fallback) => {
    const m = new RegExp(`\\b${key} (\\d+)`).exec(ctx);
    return m ? Number(m[1]) : fallback;
  };
  const openItems = ctxNum('items', items.length);
  const coordCtx = (/coordinator (\S+)/.exec(ctx) || [])[1] || '?';
  const written = now.toISOString();
  const json = jsonOf(data, written);
  const stamp = written.replace('T', ' ').slice(0, 19);
  const state = mode === 'serve' ? (reloadEvery ? `rendered ${stamp}Z · auto ${reloadEvery}s` : `rendered ${stamp}Z · live on request`) : `written ${stamp}Z · snapshot`;
  const controls =
    `<button type="button" class="btn" onclick="location.reload()" title="${mode === 'snapshot' ? 'reloads this file; run page.mjs again to regenerate it' : 'render the store again'}">Refresh</button>` +
    (mode === 'serve' ? (reloadEvery ? `<a class="btn on" href="?" title="stop reloading">auto ${reloadEvery}s · stop</a>` : `<a class="btn" href="?auto=5" title="reload every 5 seconds">auto 5s</a>`) : '') +
    `<button type="button" class="btn" id="theme" aria-label="theme follows the system; press for light">theme: system</button>`;
  // A node click focuses it (its up set and down set lit, the rest dimmed,
  // read from the data-up/data-down the render wrote) and opens its template
  // under the graph; a second click or Escape resets both. Escape also
  // closes every open row and item.
  const nodeTail = `var gd=document.getElementById('graph-detail'),svg=document.querySelector('.graph svg'),focused=null;function words(el,k){return (el.getAttribute(k)||'').split(' ').filter(Boolean)}function names(ids){return ids.map(function(i){return i.replace(/^lane:/,'').replace(/^item:/,'#')}).join(', ')}function setFocus(id){if(!svg)return;focused=id;var nodes=svg.querySelectorAll('.node'),edges=svg.querySelectorAll('.edge');if(!id){svg.classList.remove('focused');[].forEach.call(nodes,function(n){n.classList.remove('focus','up','down')});[].forEach.call(edges,function(e){e.classList.remove('lit')});return}var f=svg.querySelector('.node[data-id="'+CSS.escape(id)+'"]');if(!f)return;var up=words(f,'data-up'),down=words(f,'data-down'),lit={};lit[id]=1;up.concat(down).forEach(function(i){lit[i]=1});svg.classList.add('focused');[].forEach.call(nodes,function(n){var nid=n.getAttribute('data-id');n.classList.toggle('focus',nid===id);n.classList.toggle('up',up.indexOf(nid)>=0);n.classList.toggle('down',down.indexOf(nid)>=0)});[].forEach.call(edges,function(e){e.classList.toggle('lit',!!(lit[e.getAttribute('data-from')]&&lit[e.getAttribute('data-to')]))})}function closeNode(){if(gd){gd.hidden=true;gd.removeAttribute('data-for');gd.innerHTML=''}setFocus(null)}function showNode(id){if(!gd)return;if(gd.getAttribute('data-for')===id||focused===id)return closeNode();var t=document.getElementById('t:'+id);if(!t)return;var f=svg&&svg.querySelector('.node[data-id="'+CSS.escape(id)+'"]');var up=f?words(f,'data-up'):[],down=f?words(f,'data-down'):[];gd.innerHTML='';var bar=document.createElement('div');bar.className='bar';bar.innerHTML='<span></span><button type="button" class="btn" data-close>close</button>';bar.firstChild.textContent=id.replace(/^(lane|item):/,'$1 ')+(up.length?' · waits on '+names(up):' · waits on nothing')+(down.length?' · waited on by '+names(down):' · nothing waits on it');gd.appendChild(bar);gd.appendChild(t.content.cloneNode(true));gd.setAttribute('data-for',id);gd.hidden=false;setFocus(id)}[].forEach.call(document.querySelectorAll('svg .node[data-id]'),function(n){n.addEventListener('click',function(){showNode(n.getAttribute('data-id'))});n.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();showNode(n.getAttribute('data-id'))}})});if(gd)gd.addEventListener('click',function(e){if(e.target.hasAttribute('data-close'))closeNode()});document.addEventListener('keydown',function(e){if(e.key!=='Escape')return;[].forEach.call(document.querySelectorAll('details[open]'),function(d){d.open=false});closeNode()});`;
  // Applied before the stylesheet so a stored choice never flashes the other palette.
  const themeHead = `<script>(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}})()</script>`;
  // The toggles hide rows and items by who acts; the text box hides rows and
  // items and dims nodes whose name or headline lacks it. Both survive a
  // reload through sessionStorage.
  const filterTail = `var togs=document.querySelectorAll('.tools .tog'),find=document.getElementById('find'),found=document.getElementById('found'),fk='board-filter:'+location.pathname;function applyFilter(){var who={};[].forEach.call(togs,function(b){var on=b.classList.contains('on');who[b.getAttribute('data-who')]=on;b.setAttribute('aria-pressed',on?'true':'false')});var q=find?find.value.trim().toLowerCase():'',shown=0,total=0;[].forEach.call(document.querySelectorAll('[data-who]:not(.tog)'),function(el){var w=el.getAttribute('data-who'),t=el.getAttribute('data-text')||'',ok=who[w]!==false&&(!q||t.indexOf(q)>=0);el.hidden=!ok;if(el.classList.contains('row')){total++;if(ok)shown++}});if(svg)[].forEach.call(svg.querySelectorAll('.node'),function(n){n.classList.toggle('off',!!q&&(n.getAttribute('data-text')||'').indexOf(q)<0)});if(found)found.textContent=q?shown+' of '+total+' rows':'';try{sessionStorage.setItem(fk,JSON.stringify({who:who,q:q}))}catch(e){}}try{var saved=JSON.parse(sessionStorage.getItem(fk)||'null');if(saved){[].forEach.call(togs,function(b){var w=b.getAttribute('data-who');if(w in saved.who)b.classList.toggle('on',!!saved.who[w])});if(find&&saved.q)find.value=saved.q}}catch(e){}[].forEach.call(togs,function(b){b.addEventListener('click',function(){b.classList.toggle('on');applyFilter()})});if(find)find.addEventListener('input',applyFilter);applyFilter();`;
  const themeTail = `var b=document.getElementById('theme');if(b){var order=['system','light','dark'],root=document.documentElement;function cur(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});return t==='light'||t==='dark'?t:'system'}catch(e){return root.getAttribute('data-theme')||'system'}}function show(t){b.textContent='theme: '+t;b.setAttribute('aria-label','theme is '+t+'; press for '+order[(order.indexOf(t)+1)%3])}show(cur());b.addEventListener('click',function(){var n=order[(order.indexOf(cur())+1)%3];if(n==='system')root.removeAttribute('data-theme');else root.setAttribute('data-theme',n);try{if(n==='system')localStorage.removeItem(${JSON.stringify(THEME_KEY)});else localStorage.setItem(${JSON.stringify(THEME_KEY)},n)}catch(e){}show(n)})}`;
  const legend = `<ul class="legend" aria-label="legend"><li><i></i>lane written</li><li><i class="l-live"></i>running</li><li><i class="l-report"></i>reported</li><li><i class="l-held"></i>held</li><li><i class="l-planned"></i>planned (LANE item)</li><li><i class="l-filed"></i>filed (OK, no file)</li><li><i class="l-unknown"></i>unknown lane</li><li><i class="l-user"></i>DECIDE / STEP</li><li><i class="l-item"></i>NOTE</li><li><i class="l-edge"></i>after</li><li><i class="l-blocks"></i>blocks</li><li><i class="l-until"></i>until</li></ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${reloadEvery ? `<meta http-equiv="refresh" content="${reloadEvery}">` : ''}
<title>${esc(data.repo)} board</title>${themeHead}<style>${CSS}</style></head>
<body>
<header><h1>${esc(data.repo)}</h1><span class="meta">coordinator ${esc(coordCtx)} · ${plural(data.results.length, 'lane')} · ${plural(openItems, 'open item')}${ideas ? ` · ${plural(ideas, 'idea')}` : ''}${bad ? ` · <b>${bad} BAD</b>` : ''}</span><span class="meta" id="board-stamp">${board ? `board <span class="stamp">${esc(board.stamp)}</span>${diff.added.size || diff.gone.length ? ` · <span class="changed">${plural(diff.added.size + diff.gone.length, 'row')} changed since</span>` : ' · unchanged since'}` : 'no board.txt yet'}</span><span class="meta" id="age">${esc(state)}</span><nav aria-label="sections"><a href="#goals">Goals</a><a href="#board">Board</a><a href="#graph">Graph</a><a href="#items">Items</a><a href="#lanes">Lanes</a><a href="#history">History</a>${controls}</nav></header>
<main>
${tools}
<section id="goals" aria-labelledby="h-goals"><details class="fold" id="goals-fold"><summary><h2 id="h-goals">Goals <span class="hint">${data.goals ? 'coordinator/goals.md · what every ask is held against' : 'no coordinator/goals.md; lane.mjs init writes the skeleton'}</span></h2></summary>${data.goals ? `<div class="md">${mdHtml(data.goals)}</div>` : ''}</details></section>
<section id="board" aria-labelledby="h-board"><h2 id="h-board">Board <span class="hint">what lane.mjs board prints · open a row for everything behind it · Esc closes all</span></h2><div class="board" role="region" aria-label="board rows">${data.rows.map(rowHtml).join('')}${goneHtml}</div></section>
<section id="graph" aria-labelledby="h-graph"><h2 id="h-graph">Graph <span class="hint">left is waited on, right waits · click a box: what it waits on lights up left, what waits on it right, and its context opens below · click again or Esc resets</span></h2><figure style="margin:0"><div class="graph" role="group" aria-label="dependency graph of ${plural(graph.nodes.length, 'node')} and ${plural(graph.edges.length, 'edge')}; the Items and Lanes sections below carry the same relations as text">${svgOf(graph)}</div><div id="graph-detail" hidden></div><figcaption>${legend}</figcaption></figure>${graph.nodes.map(nodeTemplate).join('')}</section>
<section id="items" aria-labelledby="h-items"><h2 id="h-items">Items <span class="hint">line 1 is the board row; open one for its body${ideas ? ' · ideas show with the ideas toggle' : ''}</span></h2>${items.length ? `<div class="items">${items.map(itemHtml).join('')}</div>` : '<p class="none">No open items.</p>'}</section>
<section id="lanes" aria-labelledby="h-lanes"><h2 id="h-lanes">Lanes <span class="hint">prompt files at the repo root</span></h2>${data.results.length ? `<div class="table"><table><thead><tr><th scope="col">lane</th><th scope="col">status</th><th scope="col">peer</th><th scope="col">prompt</th><th scope="col">last</th></tr></thead><tbody>${data.results.map(laneRow).join('')}</tbody></table></div>` : '<p class="none">No prompt files.</p>'}</section>
<section id="history" aria-labelledby="h-history"><details class="fold" id="history-fold"><summary><h2 id="h-history">History <span class="hint">per lane: its OK lines in order, and the closed items that named it</span></h2></summary>${history.length ? `<div class="hist">${history.map(histHtml).join('')}</div>` : '<p class="none">No OK line and nothing closed yet.</p>'}${data.lanes.length ? `<details id="lanes-txt" style="margin-top:var(--space-2)"><summary class="hint" style="cursor:pointer">lanes.txt as written</summary><pre style="margin-top:var(--space-2)">${data.lanes.map((l) => esc(l.raw)).join('\n')}</pre></details>` : ''}</details></section>
</main>
<footer>A view of <code>${esc(data.storeDir || 'coordinator/')}</code> and the lane transcripts, written by <code>page.mjs</code>. Editing this file changes nothing; edit the store.</footer>
<script type="application/json" id="board-data">${json}</script>
<script>(function(){var k='board-open:'+location.pathname;try{JSON.parse(sessionStorage.getItem(k)||'[]').forEach(function(id){var el=document.getElementById(id);if(el)el.open=true})}catch(e){}document.addEventListener('toggle',function(){try{sessionStorage.setItem(k,JSON.stringify([].map.call(document.querySelectorAll('details[open]'),function(d){return d.id}).filter(Boolean)))}catch(e){}},true);${nodeTail}${filterTail}${themeTail}})()</script>
</body></html>
`;
}

const USAGE = `usage:
  page.mjs --serve [--port N] [--cwd DIR] [--store DIR] [--ideas]
  page.mjs [--cwd DIR] [--store DIR] [--out FILE] [--ideas]
`;

function parseArgs(argv) {
  const args = { _: [], unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (['cwd', 'store', 'out', 'port'].includes(key)) {
      args[key] = argv[i + 1];
      i++;
    } else if (key === 'serve' || key === 'ideas') args[key] = true;
    else args.unknown.push(a);
  }
  return args;
}

export function defaultOut(cwd) {
  return path.join(os.homedir(), '.claude', 'coordinator', mangle(cwd), 'board.html');
}

// One port per repo, so the browser bookmark survives restarts.
export function defaultPort(cwd) {
  let h = 0;
  for (const c of mangle(path.resolve(cwd))) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PORT_BASE + (h % PORT_SPAN);
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// Closed items, parsed like open ones; the board never reads them, the
// page's History does.
function readClosed(dir) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, CLOSED_DIR)).filter((f) => /^\d+-.*\.md$/.test(f)).sort();
  } catch {
    return [];
  }
  return names.map((f) => parseItem(f, readText(path.join(dir, CLOSED_DIR, f))));
}

function dataOf({ cwd, store }) {
  const { rows, results, store: st, prompts } = boardData({ cwd, store });
  const boardText = readText(path.join(st.dir, BOARD_FILE));
  return { rows, results, items: st.items, lanes: st.lanes, prompts: Object.fromEntries(prompts), board: boardText ? readBoardFile(boardText) : null, goals: readText(path.join(st.dir, GOALS_FILE)), closed: readClosed(st.dir), repo: path.basename(cwd), cwd: path.resolve(cwd), storeDir: st.dir };
}

// Which repo a running server on this port describes, or null when nothing
// answers or it is not one of ours.
async function servedCwd(port, host = '127.0.0.1') {
  try {
    const res = await fetch(`http://${host}:${port}/board.json`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j.cwd === 'string' ? j.cwd : null;
  } catch {
    return null;
  }
}

// Serve on the repo's port; when that port already serves this repo, hand back
// its URL instead of a server; when it serves another repo (a hash collision)
// or something else, step to the next port, up to PORT_TRIES times.
export async function serveOrFind(opts) {
  const host = opts.host || '127.0.0.1';
  let port = opts.port || defaultPort(opts.cwd);
  for (let tries = 0; tries < PORT_TRIES; tries++, port++) {
    try {
      const server = await serve({ ...opts, port, host });
      return { server, port, url: `http://${host}:${port}/`, found: false };
    } catch (e) {
      if (!e || e.code !== 'EADDRINUSE') throw e;
      if ((await servedCwd(port, host)) === path.resolve(opts.cwd)) return { server: null, port, url: `http://${host}:${port}/`, found: true };
    }
  }
  throw new Error(`page: no free port in ${port - PORT_TRIES}..${port - 1}; pass --port`);
}

// Binding to localhost does not keep a page on another origin from reading
// /board.json: a name it points at 127.0.0.1 arrives in Host.
const ownHost = (header, port, host) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${host.includes(':') ? `[${host}]` : host}:${port}`].includes(header);

// Localhost only. Resolves with the listening server; rejects with the
// listen error (EADDRINUSE when this repo is already served).
export function serve({ cwd, store, port, host = '127.0.0.1', ideas = false }) {
  const server = http.createServer((req, res) => {
    try {
      if (!ownHost(req.headers.host, server.address().port, host)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad request');
        return;
      }
      if (url.pathname === '/board.json') {
        const body = jsonOf(dataOf({ cwd, store }), new Date().toISOString());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      if (url.pathname !== '/') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const body = renderPage(dataOf({ cwd, store }), { mode: 'serve', auto: url.searchParams.get('auto'), ideas: ideas || url.searchParams.has('ideas') });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String((e && e.stack) || e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.unknown.length) {
    process.stderr.write(`page: unknown flag ${args.unknown[0]}\n${USAGE}`);
    return 1;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  if (args.serve) {
    const wanted = args.port ? Number(args.port) : defaultPort(cwd);
    const { server, url, port } = await serveOrFind({ cwd, store: args.store, port: wanted, ideas: !!args.ideas });
    console.log(url);
    if (!server) {
      console.error(`page: ${path.basename(cwd)} is already served on port ${port}`);
      return 0;
    }
    if (port !== wanted) console.error(`page: port ${wanted} was taken by something else; serving on ${port}`);
    return new Promise(() => {});
  }
  const out = args.out ? path.resolve(args.out) : defaultOut(cwd);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, renderPage(dataOf({ cwd, store: args.store }), { ideas: !!args.ideas }));
  fs.renameSync(tmp, out);
  console.log(out);
  return 0;
}

// argv[1] as typed may reach this file through a symlink; the module URL is
// already real.
function realOf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

if (process.argv[1] && realOf(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
