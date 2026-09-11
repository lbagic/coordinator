#!/usr/bin/env node
// lane: which claude session picked up a coordinator prompt file, whether it
// finished, and the board of what waits on whom. In the repo it touches only
// `coordinator/` (the store and the prompt files) and `.git/info/exclude`;
// sessions and transcripts are read under ~/.claude.
//
//   lane.mjs init [--cwd DIR]                     coordinator/, goals.md skeleton, .git/info/exclude lines
//   lane.mjs init --hook                          print the Notification hook JSON the watch consumes
//   lane.mjs prompt <name> --kind K [--effort E] [--gate] [--runner] [--force] [--from FILE] [--ask T] [--why T] [--done T] [--fences T] [--pointers T]
//                                                 write prompt-<name>.txt: five fields, the kind's protocol, the REPORT block
//   lane.mjs sync [--all] [--cwd DIR]             ask GitHub about every number the ledger names, rewrite coordinator/github.txt
//   lane.mjs who [<lane>] [--all] [--cwd DIR]     every lane that holds something with its session name, tty, status, idle time, cwd; --all: every launched lane
//   lane.mjs relay <lane> <text…> [--cwd DIR]     append SENT <lane> <time> <text>, print the TO-headed message and its session
//   lane.mjs did <effort> <what…> [--cwd DIR]     append DID <effort> <time> <what>: a GitHub act the coordinator did itself
//   lane.mjs set <id|name> <key> <value…>         rewrite one header key of an open item
//   lane.mjs snooze <id|name> <N>d [why…]         set snooze: to today+N (0d wakes it) and log the why as a body line
//   lane.mjs scout <effort> [--cwd DIR]           print the scout prompt for an EFFORT item
//   lane.mjs delta [--cwd DIR]                    rewrite coordinator/board.txt, print BAD rows and one line of what changed
//   lane.mjs board [--all] [--cwd DIR] [--json]   every row, grouped by who acts, CTX last; MINE the newest three and a digest, --all whole
//   lane.mjs resume [--cwd DIR]                   after a restart: per live lane its worktree, uncommitted files, commits and report tail; per open STEP and DECIDE its last dated line
//   lane.mjs check [--cwd DIR]                    the BAD rows only; exit 1 when there are any
//   lane.mjs live [--all] [--cwd DIR]             every lane that holds something with the Fences line of its prompt, capped; --all: every launched lane
//   lane.mjs launch [--cwd DIR]                   the launch block: RUN prompts as `claude -n` lines grouped by disjoint fences, held ones under HELD
//   lane.mjs ok <name> <evidence…> [--cwd DIR]    append OK <name> <time> <evidence>, time taken from the lane's report
//   lane.mjs retire <name> <why…> [--cwd DIR]     append OK <name> <now> retired: <why> and delete the prompt file
//   lane.mjs watch [--cwd DIR] [--poll MS] [--notify FILE] [--gh-poll MS]
//                                                 one line per lane transition, Notification hook line and GitHub state change, runs until killed
//   lane.mjs status <name> [--cwd DIR] [--json]   one-shot; exit 3 while the lane has no report
//   lane.mjs show <id|lane> [--cwd DIR]           one item in full, or every open item naming a lane
//   lane.mjs new KIND [name] <headline…> | --head-file FILE [--body-file FILE] [--after "a b"] [--blocks "x"] [--until "ok x"] [--on "issue N"] [--size S] [--path "…"] [--source S] [--body T]
//                                                 a headline with punctuation goes in a file: argv refuses a backtick or $(
//   lane.mjs file <id> [--cwd DIR]                move an item to coordinator/closed/
//   lane.mjs ctx [--session ID]                   context of the calling session: `ctx 180K/1M`; silent, exit 0, until its transcript holds a usage record
//   every command but ctx takes --cwd DIR (default: the current directory) and --store DIR (default: <cwd>/coordinator)
//
// A lane is a file `prompt-<name>.txt` under `coordinator/` (older ledgers: at
// the repo root; both are read, the store's wins) whose first line is
// `TASK <name>`. Its worker is a session whose transcript holds that TASK line
// typed by a human (pasted prompt, bare or as a slash command's argument) or
// inside a tool_result after a typed message naming `prompt-<name>.txt`, bare
// or as a slash command's argument (the worker read the file), or a peer
// message carrying the argv launch line `claude -n <name> "$(cat
// [coordinator/]prompt-<name>.txt)"` with both names the lane's: that is one
// session launching another. Text inside a Write tool input (the session that
// wrote the file), a task notification, any other peer message, a skill
// expansion, or a sidechain never adopts, and a session that ran /coordinator
// never adopts. A typed `TASK <other>` line, a typed message naming another
// prompt file, or a peer launch line for another lane, ends the lane's part
// of the transcript. The worker is finished when an assistant text block after the
// prompt has a line that is exactly `REPORT <name>`; the last such block is the
// report. It is continued when a later turn ended after that block, with a
// user message between the two; a tool result is not a turn boundary, and a
// thinking-only record never ends a turn. It is stopped when its last turn after the
// prompt ended (stop_reason end_turn) without a report, stalled when its
// transcript has been idle for STALL_MS, exited when it has no report, its
// registry entry is gone or its pid is dead, and its transcript has been idle
// for EXIT_GRACE_MS (a `--resume` brings the same session back under a new
// pid; before the grace runs out the lane keeps its last status). When two
// transcripts adopt one lane the later prompt wins; on a tie the newer file,
// because `--resume` forks a transcript with the timestamps copied.
//
// A prompt file written by `prompt` is a `Kind:` line (the kind, then gate,
// runner or forced), an `Effort:` line when the lane belongs to one, five
// fields of at most FIELD_MAX characters each (Ask, Why now, Done when,
// Fences, Pointers), the kind's protocol paragraph with the address rule
// (`TO <name>` heads every instruction; one headed for another name is not
// the worker's), then the REPORT block with the kind's keys. Kinds:
// research, scoping, prototype, implement, alternative, review, map. A field
// with a `file:line` citation, a Pointers token naming an item id, a name
// that already has an OK, an existing file, an unknown kind, a gate outside
// implement or a runner outside research is refused. Against its effort: a
// kind off the path, a gate on an S effort, an M implement without a gate,
// or a kind that already has a lane is refused unless --force, which the
// Kind line then says. --from reads the fields as `Label:` paragraphs from a
// file; a flag wins over the file. A prompt written with --effort adds
// `<kind>=<name>` to the effort's `lanes:` key. Hand-written prompt files
// still work; only `prompt` enforces the shape.
//
// The store is `coordinator/` at the repo root. `coordinator/lanes.txt` is
// append-only, one line per fact, <time> an ISO instant (older ledgers: the
// local HH:MM the board printed): `OK <name> <time> <evidence>` (the last
// per lane wins), `SENT <lane> <time> <text>` (a ruling relayed to the
// lane's session), `DID <effort> <time> <what>` (a GitHub act the coordinator
// did itself). A `RUN` line from an older store is read and ignored.
// `coordinator/github.txt` is one line per number the ledger names,
// `pr|issue <n> OPEN|CLOSED|MERGED [time] [title]`, written by `sync` and
// the watch (once a minute, terminal states not asked again), read by the
// board; a line it cannot read is a BAD row. Every other file
// `coordinator/<id>-<slug>.md` is one item: line 1 is `KIND [<name>]
// <headline>` with KIND one of EFFORT DECIDE STEP NOTE LANE HOLD IDEA
// (EFFORT, LANE and HOLD carry a name), then `key: value` header lines
// (after, blocks, until, source, opened, size, path, lanes, on, snooze) up to the
// first blank line, then a body the board never reads. An EFFORT carries
// `size: S|M|L`, `path: <kinds>` and `lanes: <kind>=<lane> …`; those keys
// on any other kind are faults. Any item may carry `on: pr <n> | issue <n>`.
// A `snooze: <YYYY-MM-DD>` hides the item's row from board and delta while the
// date is after today (CTX counts `snoozed N`); it satisfies nothing.
// A `.md` file whose name does not start with an id (goals.md, handoff.md)
// is not an item and is never read by the board.
// Every edge target is a lane name: a prompt file, an OK line, or a LANE
// item. `after: <lanes>` on a LANE or HOLD waits for a fresh OK on each;
// `blocks: <lanes>` on any item holds those lanes while the item is open;
// `until: ok <lane>`, `until: prompt <lane>`, `until: merged <n>` or
// `until: closed <n>` closes the item by machine; an item with `on:` and no
// `until:` closes when github.txt says its PR is merged or its issue closed.
// A LANE closes once its prompt file or OK exists, a HOLD once every after:
// lane is verified (a HOLD with no after: is refused by `new`). An EFFORT
// prints one row with its next act: scouting until it has a size, ruling
// until it has a path, then along the path: write the next kind's prompt,
// the lane's own state (run, held, live, answer, verify, re-issue), a
// verified lane still at its gate, a verified implement lane whose `pr:`
// github.txt does not show merged, the close-out of its `on:` issue while
// open; it closes when nothing is left. A lane whose report ends with the
// Gate sentence stopped at its gate: it prints as waiting on the user's
// build word (ANSWER), or as building again once a SENT line after its OK
// carries the word (LIVE), and never on CLOSE, whose sessions are done.
// A satisfied item prints on the `MINE file:` row until it is moved to
// `coordinator/closed/`, which the board never reads. An OK is fresh only when
// <time> is the lane's latest event as its MINE row prints it (`ok` copies it
// for you); an edge is satisfied only by a fresh OK, so a lane that moves
// after verification re-engages every hold and note that named it. Faults
// print as BAD rows first: an unknown lane, a cycle, a duplicate id, an item
// both open and closed, a HOLD or blocks: on a launched lane, an unknown key
// or kind, a missing headline, prose in until:, a stray tag in lanes.txt, a
// github.txt line the board cannot read, a
// bad size, path, lanes or on value, and an unlaunched prompt whose name
// already has an OK (a reused name, or a DONE file left behind). An
// unlaunched prompt is a RUN row with its kind and Done when beside it. `delta` writes
// `coordinator/board.txt` (line 1 `board <repo> <date> <time>`, then the rows)
// and prints the rows that changed since the last write; the board itself
// reads and never writes. Pinned by lane.test.mjs.
//
// A `Notification` hook appends one JSON object per line to
// ~/.claude/coordinator/notify.log; `watch` reads only what was appended since it
// last looked and prints one line per record whose session holds a lane, or
// whose cwd is this repo or one of its worktrees. A first read arms the mark
// and prints nothing, so arming the watch never replays a backlog. Pinned by
// lane.test.mjs.
//
// Context window: the transcript's modelId drops the [1m] suffix (a session
// launched as `--model fable[1m]` records `claude-fable-5-1`), so the window is
// read from the live process argv via the registry, then settings.json's model,
// then the transcript; 1M when nothing names a model. Pinned by lane.test.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tty from 'node:tty';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const SESSIONS = path.join(HOME, '.claude', 'sessions');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const DEFAULT_WINDOW = 1000000;
// Past this many of the session's own context tokens the coordinator starts
// looking for a hand-off; the board prints the HANDOFF row on the first turn
// with nothing unverified. A constant of the session's own context, not a
// fraction of its window: a 1M session does not hand off at 300K.
export const HANDOFF_AT = 350000;
const POLL_MS = 2000;
const NOTIFY_LOG = path.join(HOME, '.claude', 'coordinator', 'notify.log');
const STALL_MS = 10 * 60 * 1000;
export const EXIT_GRACE_MS = 5 * 60 * 1000;
const REPORT_MAX_LINES = 80;
const TAIL_CHARS = 600;
const ASK_CHARS = 120;
export const STORE_DIR = 'coordinator';
export const LANES_FILE = 'lanes.txt';
export const CLOSED_DIR = 'closed';
export const BOARD_FILE = 'board.txt';
export const GOALS_FILE = 'goals.md';
const LANE_TAGS = new Set(['OK', 'RUN', 'SENT', 'DID']);
export const KINDS = new Set(['EFFORT', 'DECIDE', 'STEP', 'NOTE', 'LANE', 'HOLD', 'IDEA']);
const NAMED_KINDS = new Set(['EFFORT', 'LANE', 'HOLD']);
const ITEM_KEYS = new Set(['after', 'blocks', 'until', 'source', 'opened', 'size', 'path', 'lanes', 'on', 'snooze']);
export const SIZES = new Set(['S', 'M', 'L']);
export const LANE_KINDS = new Set(['research', 'scoping', 'prototype', 'implement', 'alternative', 'review', 'map']);
export const GITHUB_FILE = 'github.txt';
const GH_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const GH_POLL_MS = 60 * 1000;
const HEAD_MAX = 96;
const DONE_MAX = 60;
// One wide Fences line must not dominate `live`.
const FENCE_ECHO = 200;
const SLUG_MAX = 40;
export const FIELD_MAX = 2000;
export const PROMPT_FIELDS = [
  ['ask', 'Ask'],
  ['why', 'Why now'],
  ['done', 'Done when'],
  ['fences', 'Fences'],
  ['pointers', 'Pointers'],
];
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const CITE_RE = /\b[\w./-]+\.[a-z]{1,5}:~?\d+/i;

// ---------- names and paths ----------

export function nameOf(file) {
  const m = /^prompt-(.+)\.txt$/.exec(path.basename(file));
  return m ? m[1] : null;
}

export function mangle(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function projectDir(cwd) {
  return path.join(PROJECTS, mangle(cwd));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function taskRe(name) {
  return new RegExp(`^[ \\t]*TASK ${escapeRe(name)}[ \\t]*$`, 'm');
}

export function reportRe(name) {
  return new RegExp(`^[ \\t]*REPORT ${escapeRe(name)}[ \\t]*$`, 'm');
}

// A prompt file reference runs to the end of the text or to a delimiter. A
// trailing `.` closes it only when the end or another delimiter follows, so
// `prompt-x.txt.bak` is a different file and never adopts lane x.
const ARGS_HEAD = "(?:^|[\\s/'\"`(])prompt-";
const ARGS_TAIL = "\\.txt(?=$|[\\s'\"`),:;]|\\.(?:$|[\\s'\"`),:;]))";

export function argsRe(name) {
  return new RegExp(ARGS_HEAD + escapeRe(name) + ARGS_TAIL, 'm');
}

function commandArgs(text) {
  const m = /<command-args>([^]*?)<\/command-args>/.exec(text);
  return m ? m[1] : '';
}

const ANY_TASK = /^[ \t]*TASK (\S+)[ \t]*$/m;
const ANY_ARGS = new RegExp(ARGS_HEAD + "([^\\s'\"`),.:;]+)" + ARGS_TAIL, 'm');

// The lane an argv launch line names, or null. `L launch` prints
// `claude -n <name> "$(cat coordinator/prompt-<name>.txt)"` (older ledgers:
// the bare path); both names must be the same lane, so a line quoting one
// name and another lane's file names neither.
const LAUNCH_RE = /claude -n ([a-z0-9][a-z0-9-]*)\b[^\n]*?\bcat\s+(?:[\w.-]+\/)*prompt-([a-z0-9][a-z0-9-]*)\.txt/;

export function launchLane(text) {
  const m = LAUNCH_RE.exec(text || '');
  return m && m[1] === m[2] ? m[1] : null;
}

// The lane another typed message hands the session to, or null. A prompt file
// named in the bare text counts, the same widening findPrompt makes: what
// adopts a lane also releases it.
function otherLane(text, name) {
  const args = commandArgs(text);
  const m = ANY_TASK.exec(text) || ANY_TASK.exec(args) || ANY_ARGS.exec(args) || ANY_ARGS.exec(text);
  return m && m[1] !== name ? m[1] : null;
}

// ---------- records ----------

export function parseLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line still being written
    }
  }
  return out;
}

function blocksText(content, type) {
  if (typeof content === 'string') return type === 'text' ? content : '';
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === type)
    .map((b) => {
      if (typeof b.text === 'string') return b.text;
      if (typeof b.content === 'string') return b.content;
      if (Array.isArray(b.content)) return b.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
      return '';
    })
    .join('\n');
}

export function isHumanUser(r) {
  if (r.type !== 'user' || r.isSidechain || r.isMeta) return false;
  const kind = r.origin && r.origin.kind;
  return kind == null || kind === 'human';
}

export function humanText(r) {
  return isHumanUser(r) ? blocksText(r.message && r.message.content, 'text') : '';
}

// The body of a cross-session message, or ''. The record is a `user` record
// with `isMeta`, `origin.kind` 'peer' and the body both in `origin.body` and
// wrapped in the `<cross-session-message>` text the session reads.
export function peerText(r) {
  if (r.type !== 'user' || r.isSidechain) return '';
  const o = r.origin;
  if (!o || o.kind !== 'peer') return '';
  return typeof o.body === 'string' && o.body ? o.body : blocksText(r.message && r.message.content, 'text');
}

export function toolResultText(r) {
  if (r.type !== 'user' || r.isSidechain) return '';
  return blocksText(r.message && r.message.content, 'tool_result');
}

export function isToolResult(r) {
  const c = r.message && r.message.content;
  return Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
}

// Non-empty lines of a message outside code fences, trimmed.
function proseLines(text) {
  const out = [];
  let fenced = false;
  for (const raw of (text || '').split('\n')) {
    const l = raw.trim();
    if (l.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (l && !fenced) out.push(l);
  }
  return out;
}

function cap(line) {
  return line.length > ASK_CHARS ? `${line.slice(0, ASK_CHARS - 1)}…` : line;
}

// The line of a worker's message the user has to answer: the last one ending
// in `?` outside a code fence, or null when it asked nothing.
export function question(text) {
  const q = [...proseLines(text)].reverse().find((l) => l.endsWith('?'));
  return q ? cap(q) : null;
}

export function askLine(text) {
  const lines = proseLines(text);
  return question(text) || cap(lines[lines.length - 1] || '');
}

export function assistantText(r) {
  if (r.type !== 'assistant' || r.isSidechain) return '';
  return blocksText(r.message && r.message.content, 'text');
}

export function isCoordinatorSession(records) {
  return records.some((r) => r.type === 'user' && /<command-name>\/coordinator<\/command-name>/.test(humanText(r)));
}

// Index of the record that adopts the lane, or -1. The last adopting record
// wins, so a session that took the same prompt twice reports on the retry.
export function findPrompt(records, name) {
  if (isCoordinatorSession(records)) return -1;
  const task = taskRe(name);
  const args = argsRe(name);
  let found = -1;
  for (let i = 0; i < records.length; i++) {
    // A peer adopts only through the launch line: the coordinator starting a
    // lane in a session it did not open. Every other peer message is talk.
    const p = peerText(records[i]);
    if (p) {
      if (launchLane(p) === name) found = i;
      continue;
    }
    const t = humanText(records[i]);
    if (!t) continue;
    const inArgs = commandArgs(t);
    if (task.test(t) || task.test(inArgs)) {
      found = i;
      continue;
    }
    // A prompt file named anywhere in the typed text, not only inside
    // <command-args>: `follow prompt-x.txt` adopts once the file is read.
    // Both tests are needed — the angle brackets around <command-args> are
    // outside argsRe's delimiter set.
    if (args.test(t) || args.test(inArgs)) {
      for (let j = i + 1; j < records.length; j++) {
        if (task.test(toolResultText(records[j]))) {
          found = i;
          break;
        }
      }
    }
  }
  return found;
}

export function analyze(records, name) {
  const i = findPrompt(records, name);
  if (i < 0) return null;
  const report = reportRe(name);
  const base = { session: records[i].sessionId || null, prompt_at: records[i].timestamp || null };
  let close = null;
  let endTurn = null;
  let lastActive = i;
  let end = records.length;
  for (let j = i + 1; j < end; j++) {
    const p = peerText(records[j]);
    if (p) {
      const l = launchLane(p);
      if (l && l !== name) {
        end = j;
        break;
      }
    }
    const h = humanText(records[j]);
    if (h) {
      if (otherLane(h, name)) {
        end = j;
        break;
      }
      lastActive = j;
    }
    const t = assistantText(records[j]);
    if (!t) continue;
    lastActive = j;
    if (report.test(t)) close = { index: j, text: t, at: records[j].timestamp || null };
    if (records[j].message && records[j].message.stop_reason === 'end_turn') endTurn = { index: j, text: t, at: records[j].timestamp || null };
  }
  let last = null;
  for (let j = end - 1; j >= 0 && !last; j--) last = records[j].timestamp || null;
  if (close) {
    const moved = !!endTurn && endTurn.index > close.index && records.slice(close.index + 1, endTurn.index).some((r) => r.type === 'user' && !r.isSidechain && !isToolResult(r));
    const m = report.exec(close.text);
    const body = close.text.slice(m.index).replace(/^[ \t]+/, '');
    return {
      ...base,
      status: moved ? 'continued' : 'finished',
      close_index: close.index,
      turn_index: moved ? endTurn.index : close.index,
      closed_at: close.at,
      moved_at: moved ? endTurn.at : null,
      report: body,
      tail: moved ? endTurn.text.slice(-TAIL_CHARS) : null,
      ask: moved ? askLine(endTurn.text) : null,
      asked: moved ? question(endTurn.text) !== null : false,
      last_activity: last,
    };
  }
  if (endTurn && endTurn.index === lastActive) {
    return { ...base, status: 'stopped', stopped_at: endTurn.at, tail: endTurn.text.slice(-TAIL_CHARS), ask: askLine(endTurn.text), asked: question(endTurn.text) !== null, last_activity: last };
  }
  return { ...base, status: 'in_progress', last_activity: last };
}

// ---------- context ----------

export function ctxTokens(records) {
  for (let j = records.length - 1; j >= 0; j--) {
    const r = records[j];
    const u = r.type === 'assistant' && !r.isSidechain ? r.message && r.message.usage : null;
    if (u) return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return null;
}

export function windowFromModel(id) {
  if (!id) return null;
  return id.includes('[1m]') ? 1000000 : 200000;
}

export function modelFromArgv(argv) {
  const m = /(?:^|\s)--model(?:=|\s+)(\S+)/.exec(argv || '');
  return m ? m[1] : null;
}

function transcriptModel(records) {
  for (let j = records.length - 1; j >= 0; j--) {
    const r = records[j];
    const id = r.type === 'attachment' && r.attachment && r.attachment.type === 'model' ? r.attachment.identity && r.attachment.identity.modelId : null;
    if (id) return id;
  }
  return null;
}

function settingsModel() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).model || null;
  } catch {
    return null;
  }
}

function argvOf(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function ctxWindow(records, entry) {
  const fromArgv = entry ? modelFromArgv(argvOf(entry.pid)) : null;
  const id = fromArgv || settingsModel() || transcriptModel(records);
  return windowFromModel(id) || DEFAULT_WINDOW;
}

export function short(n) {
  if (n >= 1000000) return `${String(Math.round(n / 100000) / 10).replace(/\.0$/, '')}M`;
  return `${Math.round(n / 1000)}K`;
}

function ctxLine(records, entry) {
  const n = ctxTokens(records);
  return n == null ? '?' : `${short(n)}/${short(ctxWindow(records, entry))}`;
}

// The good moment for a hand-off: past HANDOFF_AT with nothing unverified.
// Unknown context is never due, so a session with no usage record yet is left
// alone.
export function handoffDue(tokens, unverified) {
  return tokens != null && tokens >= HANDOFF_AT && !unverified;
}

// A lane that can still hold something: running, gone without a report, or
// waiting on the user with no OK yet. A finished or verified lane holds
// nothing. The one definition of live: `live`, `who`, the board's DONE count
// and launchBlock all read it, and `--all` is how the rest is asked for.
export function isLive(r, ok) {
  if (r.status === 'in_progress' || r.status === 'exited') return true;
  return ['stopped', 'stalled', 'continued'].includes(r.status) && !ok.has(r.name);
}

// The lane names lanes.txt carries an OK for.
export function okNames(store) {
  return new Set(store.lanes.filter((l) => l.tag === 'OK' && l.name).map((l) => l.name));
}

// ---------- registry ----------

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function readRegistry() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
      if (e && e.sessionId) out.push(e);
    } catch {
      // vanished or half-written
    }
  }
  return out;
}

function findTranscript(sessionId, cwdHint) {
  if (cwdHint) {
    const p = path.join(projectDir(cwdHint), `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const d of fs.readdirSync(PROJECTS)) {
      const p = path.join(PROJECTS, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // no projects dir
  }
  return null;
}

function ownSessionId() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  const pid = process.env.CLAUDE_PID;
  if (pid) {
    try {
      return JSON.parse(fs.readFileSync(path.join(SESSIONS, `${pid}.json`), 'utf8')).sessionId || null;
    } catch {
      return null;
    }
  }
  return null;
}

function worktrees(cwd) {
  const set = new Set([path.resolve(cwd)]);
  try {
    const out = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) if (line.startsWith('worktree ')) set.add(path.resolve(line.slice(9).trim()));
  } catch {
    // not a git repo
  }
  return set;
}

// Running `lane.mjs watch` processes on this machine, any repo. More than one
// usually means an earlier coordinator session still holds its watch.
export function watchCount() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return out.split('\n').filter((l) => /^\s*\d+\s+(?:\S*\/)?node\s+\S*lane\.mjs watch(?:\s|$)/.test(l)).length;
  } catch {
    return 0;
  }
}

// ---------- scanning ----------

class Transcripts {
  constructor() {
    this.cache = new Map();
  }

  // Parsed records of a file, re-read only when its mtime moved.
  read(file) {
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      this.cache.delete(file);
      return null;
    }
    const prev = this.cache.get(file);
    if (prev && prev.mtime === mtime) return prev;
    let records;
    try {
      records = parseLines(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    const entry = { mtime, records };
    this.cache.set(file, entry);
    return entry;
  }
}

// A lane with no report whose session is gone (no registry entry for it, or
// a dead pid) is exited only once its transcript has been idle past the
// grace: a `--resume` brings the session back under a new pid.
// The instant a lane last did something: its last transcript record's
// timestamp, the file's mtime only when no record carries one. A touch that
// appends nothing moves no status.
export function activeAt(res, mtime) {
  return Date.parse(res.last_activity || '') || mtime;
}

// The status the transcript alone cannot give: exited once the session is gone
// past the grace, stalled once in progress and idle past STALL_MS, both on
// activeAt's clock.
export function settle(res, entry, open, now, mtime) {
  const idle = now - activeAt(res, mtime);
  if (exited(res, entry, open, idle)) return 'exited';
  if (res.status === 'in_progress' && idle > STALL_MS) return 'stalled';
  return res.status;
}

export function exited(res, entry, open, idleMs) {
  if (res.report) return false;
  // An entry with no live pid is gone, and so is one that carries no pid at all.
  const gone = (!entry && !!res.session) || (!!entry && !open);
  return gone && idleMs > EXIT_GRACE_MS;
}

// Which of two adopting transcripts is the lane's worker.
export function newer(a, b) {
  const pa = String(a.prompt_at);
  const pb = String(b.prompt_at);
  return pa > pb || (pa === pb && a.mtime > b.mtime);
}

export class Lanes {
  constructor(cwd, opts = {}) {
    this.cwd = path.resolve(cwd);
    this.store = storeDir(this.cwd, opts.store);
    this.dir = projectDir(this.cwd);
    this.own = opts.own === undefined ? ownSessionId() : opts.own;
    this.transcripts = new Transcripts();
    this.adopted = new Map();
    this.now = opts.now || (() => Date.now());
  }

  promptFiles() {
    const byName = new Map();
    for (const dir of [this.cwd, this.store]) {
      if (dir !== this.cwd && dir === this.cwd) continue;
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of names) {
        const name = nameOf(f);
        if (!name) continue;
        const file = path.join(dir, f);
        try {
          const head = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
          if (taskRe(name).test(head)) byName.set(name, { name, file, rel: path.relative(this.cwd, file), mtime: fs.statSync(file).mtimeMs });
        } catch {
          // vanished
        }
      }
    }
    return [...byName.values()].sort((a, b) => a.mtime - b.mtime);
  }

  // Transcripts worth reading for one lane: live sessions in this repo or its
  // worktrees, files in the project dir of the repo or any worktree written
  // since the prompt, and whatever adopted the lane before. Never the caller's
  // own session. The prompt file's mtime is the lower bound, so a prompt file
  // edited after launch loses its worker in a fresh process.
  candidates(lane, registry, trees) {
    const files = new Map();
    for (const e of registry) {
      if (!e.cwd || !trees.has(path.resolve(e.cwd))) continue;
      const f = findTranscript(e.sessionId, e.cwd);
      if (f) files.set(f, e);
    }
    for (const tree of trees) {
      const dir = projectDir(tree);
      let listed = [];
      try {
        listed = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of listed) {
        const p = path.join(dir, f);
        if (files.has(p)) continue;
        try {
          if (fs.statSync(p).mtimeMs >= lane.mtime - 60000) files.set(p, null);
        } catch {
          // vanished
        }
      }
    }
    const prev = this.adopted.get(lane.name);
    if (prev && !files.has(prev)) files.set(prev, null);
    if (this.own) files.delete(path.join(this.dir, `${this.own}.jsonl`));
    return files;
  }

  status(lane, registry = readRegistry(), trees = worktrees(this.cwd)) {
    const bySession = new Map(registry.map((e) => [e.sessionId, e]));
    let best = null;
    for (const [file, hint] of this.candidates(lane, registry, trees)) {
      const t = this.transcripts.read(file);
      if (!t) continue;
      const res = analyze(t.records, lane.name);
      if (!res) continue;
      if (this.own && res.session === this.own) continue;
      const entry = bySession.get(res.session) || hint;
      const open = !!(entry && entry.pid && alive(entry.pid));
      const r = { ...res, name: lane.name, file, mtime: t.mtime, active: activeAt(res, t.mtime), worker_ctx: ctxLine(t.records, entry), peer: entry ? entry.name || null : null, registry: entry ? entry.status || 'unknown' : null, session_open: open };
      r.status = settle(res, entry, open, this.now(), t.mtime);
      if (!best || newer(r, best)) best = r;
    }
    if (best) this.adopted.set(lane.name, best.file);
    const out = best || { name: lane.name, status: 'not_found' };
    out.prompt_file = lane.file;
    out.rel = lane.rel || path.relative(this.cwd, lane.file);
    return out;
  }

  coordinatorCtx() {
    const t = this.coordinatorTranscript();
    if (!t) return null;
    const entry = readRegistry().find((e) => e.sessionId === this.own) || null;
    return ctxLine(t.records, entry);
  }

  coordinatorCtxTokens() {
    const t = this.coordinatorTranscript();
    return t ? ctxTokens(t.records) : null;
  }

  // The directory a lane's session sits in: the registry entry's cwd while the
  // session lives, the last transcript record's `cwd` after it dies.
  sessionCwd(r, registry = readRegistry()) {
    const entry = r.session ? registry.find((e) => e.sessionId === r.session) : null;
    if (entry && entry.cwd) return entry.cwd;
    const t = r.file ? this.transcripts.read(r.file) : null;
    for (let j = t ? t.records.length - 1 : -1; j >= 0; j--) if (t.records[j].cwd) return t.records[j].cwd;
    return null;
  }

  coordinatorTranscript() {
    if (!this.own) return null;
    const f = findTranscript(this.own, this.cwd);
    return (f && this.transcripts.read(f)) || null;
  }

  // Live sessions in this repo or its worktrees whose transcript ran
  // /coordinator, the caller's own included.
  coordinators(registry = readRegistry(), trees = worktrees(this.cwd)) {
    let n = 0;
    for (const e of registry) {
      if (!e.cwd || !trees.has(path.resolve(e.cwd)) || !(e.pid && alive(e.pid))) continue;
      const f = findTranscript(e.sessionId, e.cwd);
      const t = f && this.transcripts.read(f);
      if (t && isCoordinatorSession(t.records)) n++;
    }
    return n;
  }
}

// ---------- rendering ----------

// Local wall-clock time, the clock the board rows use.
function fmtTs(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function indent(text) {
  return text.replace(/^/gm, '  ');
}

export function render(r, coordCtx, now = Date.now()) {
  const who = r.session ? `session ${r.session.slice(0, 8)}${r.peer ? ` peer ${r.peer}` : ''}` : '';
  const head = `${r.name}: ${r.status}`;
  switch (r.status) {
    case 'not_found':
      return `${head}  no session has taken prompt-${r.name}.txt`;
    case 'in_progress':
      return `${head}  ${who}  prompt ${fmtTs(r.prompt_at)}  registry ${r.registry || '?'}`;
    case 'stalled':
      return `${head}  ${who}  idle ${fmtDur(now - (r.active || r.mtime))}  registry ${r.registry || '?'}  worker ctx ${r.worker_ctx}`;
    case 'exited':
      return [`${head}  ${who}  no report, session gone  worker ctx ${r.worker_ctx}`, ...(r.tail ? ['  --- last message ---', indent(r.tail.trim()), '  ---'] : [])].join('\n');
    case 'stopped':
      return [`${head}  ${who}  turn ended ${fmtTs(r.stopped_at)} without REPORT  worker ctx ${r.worker_ctx}`, '  --- last message ---', indent(r.tail.trim()), '  ---'].join('\n');
    case 'continued':
      return [`${head}  ${who}  turn ended ${fmtTs(r.moved_at)} after report ${fmtTs(r.closed_at)}  worker ctx ${r.worker_ctx}`, '  --- last message ---', indent(r.tail.trim()), '  ---'].join('\n');
    case 'finished': {
      const lines = r.report.trimEnd().split('\n');
      const body = lines.length > REPORT_MAX_LINES ? [...lines.slice(0, REPORT_MAX_LINES), `… ${lines.length - REPORT_MAX_LINES} more lines`] : lines;
      return [`${head}  ${who}  closed ${fmtTs(r.closed_at)}  worker ctx ${r.worker_ctx}${coordCtx ? `  coordinator ctx ${coordCtx}` : ''}`, ...body].join('\n');
    }
    case 'gone':
      return `${head}  prompt-${r.name}.txt removed`;
    default:
      return `${head}`;
  }
}

// ---------- notifications ----------

// A `Notification` hook appends one JSON object per line to NOTIFY_LOG when a
// session wants the user: a permission prompt, or a worker idle at a question.
// Nothing else writes the file, and no lane transition carries the fact, so
// the watch is the only consumer.
export function parseNotify(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && (o.session_id || o.cwd)) out.push(o);
    } catch {
      // hand-edited, or a line the hook wrote half of
    }
  }
  return out;
}

// Reads only the bytes appended since the last call, and a first call reads
// none: arming the watch must not replay the backlog of a previous session. A
// trailing partial line is left for the next call.
export class NotifyTail {
  constructor(file = NOTIFY_LOG) {
    this.file = file;
    this.offset = null;
  }

  read() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      if (this.offset === null) this.offset = 0;
      return [];
    }
    if (this.offset === null) {
      this.offset = size;
      return [];
    }
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return [];
    let text = '';
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const cut = text.lastIndexOf('\n');
    if (cut < 0) return [];
    this.offset += Buffer.byteLength(text.slice(0, cut + 1));
    return parseNotify(text.slice(0, cut + 1));
  }
}

export function renderNotify(n, name) {
  const who = n.session_id ? `session ${String(n.session_id).slice(0, 8)}` : 'session ?';
  const where = name || (n.cwd ? path.basename(n.cwd) : '?');
  const msg = String(n.message || '').replace(/\s+/g, ' ').trim();
  return `${where}: notify  ${who}  ${fmtTs(n.at)}  ${msg || 'wants the user'}`;
}

// ---------- store ----------

// lanes.txt: tag first and normalised; OK and RUN name a lane as their second
// word; an indented line continues the line above.
export function parseBoardLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    if (/^\s/.test(raw) && out.length) {
      const prev = out[out.length - 1];
      prev.rest = `${prev.rest} ${raw.trim()}`.trim();
      prev.raw = `${prev.raw} ${raw.trim()}`;
      continue;
    }
    const [first, ...words] = raw.trim().split(/\s+/);
    const tag = first.replace(/:$/, '').toUpperCase();
    const name = LANE_TAGS.has(tag) ? words.shift() || null : null;
    out.push({ tag, name, rest: words.join(' '), raw: raw.trim() });
  }
  return out;
}

export function slugOf(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX)
      .replace(/-+$/, '') || 'item'
  );
}

// One item file. The id is the filename's; line 1 is `KIND [<lane>] <headline>`;
// header keys run to the first blank line; anything wrong is a fault in `bad`,
// never silently prose.
export function parseItem(file, text) {
  const base = path.basename(file);
  const m = /^(\d+)-(.*)\.md$/.exec(base);
  const id = m ? Number(m[1]) : null;
  const bad = [];
  const ref = id == null ? base : `#${id}`;
  if (!m) bad.push(`${base}: not <id>-<slug>.md`);
  const lines = text.split('\n');
  const raw = (lines[0] || '').trim();
  const [tag, ...words] = raw.split(/\s+/);
  const kind = (tag || '').toUpperCase();
  const it = { id, file: base, kind, raw, name: null, head: '', after: [], blocks: [], until: null, source: null, opened: null, size: null, path: [], lanes: {}, on: null, snooze: null, body: '', bad };
  if (!KINDS.has(kind)) bad.push(`${ref} kind ${kind || '(empty)'} unknown`);
  if (NAMED_KINDS.has(kind)) it.name = words.shift() || null;
  it.head = words.join(' ');
  if (NAMED_KINDS.has(kind) ? !it.name : KINDS.has(kind) && !it.head) bad.push(`${ref} no ${NAMED_KINDS.has(kind) ? (kind === 'EFFORT' ? 'name' : 'lane') : 'headline'}`);
  let i = 1;
  for (; i < lines.length && lines[i].trim() !== ''; i++) {
    const km = /^([a-z]+):\s*(.*)$/.exec(lines[i]);
    if (!km || !ITEM_KEYS.has(km[1])) {
      bad.push(`${ref} header line not a known key: '${lines[i].trim().slice(0, 40)}'`);
      continue;
    }
    const v = km[2].trim();
    if (km[1] === 'after' || km[1] === 'blocks') it[km[1]].push(...v.split(/\s+/).filter(Boolean));
    else if (km[1] === 'until') {
      const um = /^(ok|prompt)\s+(\S+)$/.exec(v);
      const gm = /^(merged|closed)\s+#?(\d+)$/.exec(v);
      if (um) it.until = { kind: um[1], lane: um[2] };
      else if (gm) it.until = { kind: gm[1], n: Number(gm[2]) };
      else bad.push(`${ref} until: '${v}' is not 'ok <lane>', 'prompt <lane>', 'merged <n>' or 'closed <n>'`);
    } else if (km[1] === 'on') {
      const om = /^(pr|issue)\s+#?(\d+)$/.exec(v);
      if (om) it.on = { type: om[1], n: Number(om[2]) };
      else bad.push(`${ref} on: '${v}' is not 'pr <n>' or 'issue <n>'`);
    } else if (km[1] === 'size') {
      if (SIZES.has(v)) it.size = v;
      else bad.push(`${ref} size: '${v}' is not S, M or L`);
    } else if (km[1] === 'path') {
      it.path = v.split(/\s+/).filter(Boolean);
      for (const k of it.path) if (!LANE_KINDS.has(k)) bad.push(`${ref} path names '${k}': not one of ${[...LANE_KINDS].join(' ')}`);
    } else if (km[1] === 'lanes') {
      for (const tok of v.split(/\s+/).filter(Boolean)) {
        const lm = /^([a-z]+)=(\S+)$/.exec(tok);
        if (lm && LANE_KINDS.has(lm[1])) it.lanes[lm[1]] = lm[2];
        else bad.push(`${ref} lanes: '${tok}' is not <kind>=<lane>`);
      }
    } else if (km[1] === 'snooze') {
      if (/^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(v))) it.snooze = v;
      else bad.push(`${ref} snooze: '${v}' is not a date YYYY-MM-DD`);
    } else it[km[1]] = v;
  }
  if (kind === 'EFFORT') {
    for (const k of Object.keys(it.lanes)) if (it.path.length && !it.path.includes(k)) bad.push(`${ref} lanes: ${k} is not on the path`);
  } else {
    for (const k of ['size', 'path', 'lanes']) if (k === 'size' ? it.size : k === 'path' ? it.path.length : Object.keys(it.lanes).length) bad.push(`${ref} ${k}: only an EFFORT carries it`);
  }
  it.body = lines.slice(i).join('\n').trim();
  return it;
}

// github.txt: one line per number the ledger names, `pr|issue <n> <STATE>
// <iso time> <title>`, written by `sync` and the watch, read by the board.
// The number alone is the key: GitHub gives issues and PRs one sequence. A
// line the board cannot read is a fault, never silently a state.
export function parseGithub(text) {
  const out = new Map();
  const bad = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(pr|issue)\s+#?(\d+)\s+([A-Z]+)(?:\s+(\d{4}-\d\d-\d\dT[\d:.]+Z))?(?:\s+(.*))?$/.exec(line);
    if (!m || !GH_STATES.has(m[3])) {
      bad.push(line.slice(0, 60));
      continue;
    }
    out.set(Number(m[2]), { type: m[1], n: Number(m[2]), state: m[3], at: m[4] || null, title: (m[5] || '').trim() });
  }
  return { states: out, bad };
}

export function githubLine(g) {
  return `${g.type} ${g.n} ${g.state}${g.at ? ` ${g.at}` : ''}${g.title ? ` ${g.title}` : ''}`;
}

// Pure: files are [{ file, text }] of the open directory, lanesText is
// lanes.txt, closed is the file names under closed/, githubText is github.txt.
export function foldStore(files, lanesText = '', closed = [], githubText = '') {
  const items = files.map((f) => parseItem(f.file, f.text)).sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity));
  const closedIds = new Map();
  for (const f of closed) {
    const id = Number((/^(\d+)-/.exec(f) || [])[1]);
    if (id) closedIds.set(id, [...(closedIds.get(id) || []), f]);
  }
  const gh = parseGithub(githubText);
  return { items, closedIds, lanes: parseBoardLines(lanesText), github: gh.states, githubBad: gh.bad };
}

export function storeDir(cwd, override) {
  return override ? path.resolve(cwd, override) : path.join(cwd, STORE_DIR);
}

function listMd(d) {
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

export function readStore(cwd, override) {
  const dir = storeDir(cwd, override);
  const files = [];
  for (const f of listMd(dir)) {
    if (!/^\d+-/.test(f)) continue;
    try {
      files.push({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') });
    } catch {
      // vanished
    }
  }
  const readOr = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  const store = foldStore(files, readOr(LANES_FILE), listMd(path.join(dir, CLOSED_DIR)), readOr(GITHUB_FILE));
  store.dir = dir;
  return store;
}

export function nextId(dir) {
  let max = 0;
  for (const d of [dir, path.join(dir, CLOSED_DIR)]) {
    for (const f of listMd(d)) {
      const m = /^(\d+)-/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

// Create `<id>-<slug>.md` with the next free id, refusing an existing filename
// (O_EXCL) and stepping past an id another writer took meanwhile.
export function mintItem(dir, slugSource, text) {
  fs.mkdirSync(path.join(dir, CLOSED_DIR), { recursive: true });
  const slug = slugOf(slugSource);
  for (let id = nextId(dir), tries = 0; tries < 100; id++, tries++) {
    const file = path.join(dir, `${id}-${slug}.md`);
    try {
      fs.writeFileSync(file, text, { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    const twins = listMd(dir).filter((f) => f.startsWith(`${id}-`) && f !== path.basename(file));
    if (!twins.length) return { file, id };
    fs.unlinkSync(file);
  }
  throw new Error('mint: no free id after 100 tries');
}

// ---------- board ----------

function clock(ts, now) {
  if (!ts) return '?';
  const d = new Date(ts);
  const n = new Date(now);
  const pad = (x) => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

// The local calendar date of a time, the form a `snooze:` value takes.
function isoDate(ms) {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const TIME_TOKEN = /^(?:\d\d-\d\d )?(\d\d:\d\d)(?=\s|$)/;

// The time a lane's MINE row prints for its latest event, which is the time
// an OK must carry to be fresh.
export function latestTime(r, now = Date.now()) {
  return clock(r.status === 'continued' ? r.moved_at : r.closed_at, now);
}

// The same event as an ISO instant, whole seconds: what `ok` writes.
export function latestInstant(r) {
  const ts = r.status === 'continued' ? r.moved_at : r.closed_at;
  return ts ? isoSec(ts) : '?';
}

function isoSec(ts) {
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nowIso() {
  return isoSec(Date.now());
}

const ISO_TOKEN = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(?=\s|$)/;

function capTo(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function capHead(s) {
  return capTo(s, HEAD_MAX);
}

// ---------- prompt files ----------

// One field of a prompt file: the text after `<label>:` on its line, with
// indented continuation lines joined. Empty when the file has no such line.
export function promptField(text, label) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${label}:`));
  if (i < 0) return '';
  let out = lines[i].slice(label.length + 1).trim();
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) out += ` ${lines[j].trim()}`;
  return out;
}

// The PR number a REPORT names on its `pr:` line, or null (`pr: none`).
export function reportPr(report) {
  const m = /^[ \t]*pr:\s*(.*)$/m.exec(report || '');
  if (!m) return null;
  const n = /\/pull\/(\d+)|#(\d+)/.exec(m[1]);
  return n ? Number(n[1] || n[2]) : null;
}

// A gated implement lane stops at its gate with the Gate sentence as the last
// line of its report: it has done its recon and waits for the user's build
// word. Such a lane is never a session to close, however it was verified.
export function gateStop(report) {
  const lines = String(report || '').trim().split('\n');
  const last = (lines[lines.length - 1] || '').trim();
  return /^Gated\b/i.test(last) && /\bbuild\b/i.test(last);
}

// Faults in the fields of a prompt to be written: itemIds are the ids in the
// store, open and closed, which a Pointers token may not name.
export function promptFaults(name, fields, itemIds = new Set(), opts = {}) {
  const faults = [];
  if (!NAME_RE.test(name || '')) faults.push(`name '${name}' is not lower-case letters, digits and dashes`);
  if (!LANE_KINDS.has(opts.kind || '')) faults.push(`kind '${opts.kind || ''}' is not one of ${[...LANE_KINDS].join(' ')}`);
  if (opts.gate && opts.kind !== 'implement') faults.push('--gate belongs to an implement lane');
  if (opts.runner && opts.kind !== 'research') faults.push('--runner belongs to a research lane');
  for (const [key, label] of PROMPT_FIELDS) {
    const v = fields[key] || '';
    if (!v && (key === 'ask' || key === 'done' || key === 'fences')) faults.push(`${label} is empty`);
    if (v.length > FIELD_MAX) faults.push(`${label} is ${v.length} characters; at most ${FIELD_MAX}`);
    const cite = CITE_RE.exec(v.replace(/\S+:\/\/\S+/g, ''));
    if (cite) faults.push(`${label} cites ${cite[0]}: a plan, not intent`);
  }
  for (const tok of (fields.pointers || '').split(/\s+/)) {
    const m = /^#(\d+)$/.exec(tok);
    if (m && itemIds.has(Number(m[1]))) faults.push(`Pointers names item #${m[1]}: an item is the coordinator's, never a worker's`);
  }
  return faults;
}

// Faults of a prompt against the effort it belongs to: the kind must be on
// the path (or forced), the gate follows the size (S never, M implement
// always), and a kind already holding a lane is not written twice.
export function effortFaults(effort, opts = {}) {
  const faults = [];
  if (!effort) return ['no open EFFORT item of that name'];
  if (!effort.path.length) faults.push(`effort ${effort.name} has no path: rule the card first (L set ${effort.name} path "…")`);
  else if (!effort.path.includes(opts.kind) && !opts.force) faults.push(`kind ${opts.kind} is not on the path of ${effort.name} (${effort.path.join(' ')}); --force to write it anyway`);
  if (effort.size === 'S' && opts.gate) faults.push('an S effort has no gate: it goes straight to the PR');
  if (effort.size && effort.size !== 'S' && opts.kind === 'implement' && !opts.gate && !opts.force) faults.push(`an ${effort.size} effort's implement lane needs --gate (claim, verify, amendments, stop for build); --force to skip it`);
  if (effort.lanes[opts.kind] && !opts.force) faults.push(`${effort.name} already has ${/^[aeiou]/.test(opts.kind) ? 'an' : 'a'} ${opts.kind} lane: ${effort.lanes[opts.kind]}; retire it or --force`);
  return faults;
}

// The five fields read from a file: `Label:` starts a field, following lines
// continue it until the next label or a blank line; anything before the first
// label is ignored, so a draft may carry a heading.
// A draft label that starts like one of the five but is not it (`Why:`,
// `Fence:`) would fold its text into the field above; it is refused instead.
const NEAR_LABELS = new Map([['ask', 'Ask'], ['why', 'Why now'], ['done', 'Done when'], ['fence', 'Fences'], ['fences', 'Fences'], ['pointer', 'Pointers'], ['pointers', 'Pointers']]);
export function labelFaults(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = /^([A-Za-z]+(?: [A-Za-z]+)?):/.exec(raw);
    if (!m) continue;
    const want = NEAR_LABELS.get(m[1].split(' ')[0].toLowerCase());
    if (want && m[1].toLowerCase() !== want.toLowerCase()) out.push(`--from: '${m[1]}:' is not '${want}:'`);
  }
  return out;
}

export function parseFields(text) {
  const labels = new Map(PROMPT_FIELDS.map(([key, label]) => [label.toLowerCase(), key]));
  const fields = {};
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const m = /^([A-Za-z ]+):\s*(.*)$/.exec(raw);
    const key = m ? labels.get(m[1].trim().toLowerCase()) : null;
    if (key) {
      cur = key;
      fields[key] = m[2].trim();
      continue;
    }
    if (!cur) continue;
    if (!raw.trim()) {
      cur = null;
      continue;
    }
    fields[cur] = `${fields[cur]} ${raw.trim()}`.trim();
  }
  return fields;
}

const addressRule = (name) => `Instructions for you arrive headed \`TO ${name}\`; one headed \`TO\` another name is not yours: say so and stop. Anything outside the Fences is a stop and a question, never a guess.`;

const REPORT_KEYS = {
  research: ['what: what was read, where it pivoted, what it could not settle', 'evidence: where each finding was read, one per line', 'verdict: the answer in one line', 'open: follow-up work named, not created; questions only the user can answer'],
  scoping: ['brief: where it lives', 'decisions: each with its pick, one per line', 'open: what stayed unsettled and why'],
  prototype: ['commits: <hash> <subject> on the throwaway branch, never pushed', 'ruling: what the user chose, in one line, and where it is recorded', 'open: what the build lane must still settle'],
  implement: ['what: what changed, where it pivoted and why, what it caught and amended along the way', 'commits: <hash> <subject>, one per line, or none', 'pr: <url>, or none', 'checks: <check>: PASS|FAIL, <evidence>', 'open: findings not fixed, departures from the ask, questions only the user can answer'],
  alternative: ['case: the approach in one line and where the full case is posted', 'evidence: where each claim was read or measured', 'open: what would have to be true for it to win'],
  review: ['findings: <path>: <problem>, <fix>, one per line, or none', 'verdict: approve, or what blocks', 'open: questions only the user can answer'],
  map: ['map: <url>', 'tickets: <url> <kind> <title>, one per line', 'open: fog that could not be charted'],
};

// The protocol paragraph of a kind: the standing fences and the acts the
// worker owes, the same under any skill or none. `opts.later` says the
// effort's path has a leg after this one, so a kind that would close the
// effort's issue leaves it open instead: the issue outlives its first lane.
export function protocolOf(name, opts = {}) {
  const ticket = opts.ticket ? `#${opts.ticket}` : null;
  const where = (what) => (ticket ? `${what} on ${ticket}` : `${what} where the Done when says`);
  switch (opts.kind) {
    case 'research':
      return [
        `Protocol (research, on your own): answer the question from primary sources, the repo, the docs, the data, and say where each claim was read. Read-only: no code, no worktree, no PR, no test files. ${ticket ? `Claim ${ticket} first (assign yourself); ${opts.later ? `the answer is its resolution comment and the gist line on its map. Leave ${ticket} open: a later lane of this effort closes it, not you.` : `the answer is its resolution comment, then close it and add the gist line on its map.`}` : 'Write the findings where the Done when says.'} Name follow-up work in the REPORT; create nothing.`,
        ...(opts.runner ? ['Production reads go through a runner: write a non-interactive read-only script in your scratchpad and print the command; the user runs it with ! in this session and tees the output to a file with no credentials in it; you read the file. Confirm the target before every connection; SELECT and EXPLAIN only. Two passes are normal.'] : []),
      ].join('\n');
    case 'scoping':
      return `Protocol (scoping, with the user): settle the ask into a written brief: the destination in one line, every decision the build waits on with its options and the user's pick, what is out of scope. Grill in numbered rounds, a recommendation with its evidence on each; facts come from reading, decisions from the user, never from you. No code, no worktree, no PR. ${where('The brief goes')}. The build is another lane's: do not start it.`;
    case 'prototype':
      return `Protocol (prototype, with the user): raise the fidelity of the question with something to react to: two or three rough variants in your own throwaway worktree, never pushed, never a PR. Show them, grill to a ruling, ${where('record the ruling')}. The build is another lane's: do not start it.`;
    case 'implement':
      return [
        `Protocol (implement): deliver the way the Fences say this repo works: a worktree and a PR babysat to CI green with every review-bot thread answered, or commits on main with the issue number in the subject; the Fences name the base and the route. Do your own recon; one concern per PR or commit; checks scoped to the diff, run by you, their evidence quoted. You never merge and never push: that is the user's.`,
        ...(ticket ? [`Ticket ${ticket}: claim it first (assign yourself), verify its text against origin/main, post amendments or "none" as a comment. After the user says merged: resolution comment, close, gist line on its map.`] : []),
        ...(opts.gate ? [`Gate: after the amendments, stop and wait. Build only on a message headed \`TO ${name}\` that carries the word build. Never ask for it through a question tool; the wait is the point. End the report with the line "Gated. Waiting for a message headed TO ${name} carrying the word build." and nothing after it: that line is what keeps your session open on the board.`] : []),
      ].join('\n');
    case 'alternative':
      return `Protocol (alternative, on your own): make the case for a different approach to the same question, against the one on the table: what it changes, what it costs, the evidence behind each claim, in at most 40 lines. A throwaway spike is allowed in your own worktree, never pushed, never a PR. ${where('Post the case')}. Decide nothing; the user picks.`;
    case 'review':
      return `Protocol (review, on your own): review the named PR or branch against the ask and the repo's standards; every finding is a location, the problem and the fix, one line each. No code changes, no commits. ${ticket ? `Post the findings as review comments on ${ticket}.` : 'Post the findings where the Done when says.'} End with a verdict.`;
    case 'map':
      return `Protocol (map, with the user): chart the effort as a map issue: destination, notes, decisions so far, not yet specified, out of scope; tickets as child issues, each one question sized to one session, labelled by kind, wired with native blocked-by edges in a second pass. Chart, never build: charting is this session's whole work.`;
    default:
      return '';
  }
}

export function buildPrompt(name, fields, opts = {}) {
  const one = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim();
  const body = PROMPT_FIELDS.map(([key, label]) => `${label}: ${one(fields[key])}`);
  const kindLine = [opts.kind, ...(opts.gate ? ['gate'] : []), ...(opts.runner ? ['runner'] : []), ...(opts.force ? ['forced'] : [])].filter(Boolean).join(' ');
  return [
    `TASK ${name}`,
    ...(kindLine ? [`Kind: ${kindLine}`] : []),
    ...(opts.effort ? [`Effort: ${opts.effort}`] : []),
    '',
    ...body,
    '',
    ...(opts.kind ? [protocolOf(name, opts), addressRule(name), ''] : []),
    'prompt-*.txt and coordinator/ are never committed. Pointers are leads to read, not facts: verify before building on them.',
    '',
    'Your last message, headed exactly as shown:',
    `REPORT ${name}`,
    ...(REPORT_KEYS[opts.kind] || REPORT_KEYS.implement),
    '',
  ].join('\n');
}

// One header key of an item's text set or replaced; the header runs to the
// first blank line. Pure.
export function setHeaderKey(text, key, value) {
  const lines = text.split('\n');
  let end = 1;
  while (end < lines.length && lines[end].trim() !== '') end++;
  const i = lines.findIndex((l, j) => j > 0 && j < end && l.startsWith(`${key}:`));
  const line = `${key}: ${String(value).trim()}`;
  if (i >= 0) lines[i] = line;
  else lines.splice(end, 0, line);
  return lines.join('\n');
}

export function scoutPrompt(cwd, effort) {
  return [
    `Read-only; edit nothing. Repo ${cwd}. Effort ${effort.name}: ${effort.head}`,
    ...(effort.body ? ['', effort.body, ''] : ['']),
    'Answer in at most 250 words as a scope card. Size: S (no product question, one PR), M (a product or design question to settle first), or L (more than one session can hold it; a map). Facts: which directories the work touches, what exists today, what is unknown or contested. Decisions: each product or design question as a lettered line, the options and the data beside them, your pick marked. Path: the lane kinds in order, from research, scoping, prototype, implement, alternative, review, map. Then anything that makes the ask ill-formed.',
  ].join('\n');
}

export const HOOK_JSON = `{ "hooks": { "Notification": [ { "hooks": [ { "type": "command", "command":
  "mkdir -p \\"$HOME/.claude/coordinator\\" && jq -c --arg at \\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\" '{at: $at, session_id: .session_id, cwd: .cwd, message: .message}' >> \\"$HOME/.claude/coordinator/notify.log\\"" } ] } ] } }`;

export const GOALS_TEMPLATE = [
  '# goals',
  '<one sentence: what done looks like for this repo>',
  '',
  'You write this file; the coordinator proposes a line and waits. A line is a rule, never a reading: dates, ids and evidence live in the DECIDE item. Every ask is held against a line here.',
  '',
  '## now',
  '- <ranked, one line each; order is precedence>',
  '- <example: ship the utilization columns and stop; one defect per PR>',
  '',
  '## never',
  '- <what no lane touches; the coordinator refuses the ask and names the line>',
  '- <example: production databases are read-only for every lane>',
  '',
  '## ask',
  '- <what needs a DECIDE before a lane runs>',
  '- <example: auth middleware and routes; you review that diff before merge>',
  '- GitHub issue bookkeeping (effort issue, resolution comment, close, gist line, labels, blocked-by edges) is the coordinator\'s on your word, logged as DID; PRs, reviews and merges never.',
  '',
  '## delivery',
  '- <the route: a worktree and a PR, or commits on main with the issue number in the subject>',
  '- <checks per lane, scoped to the diff>',
  '- <who merges: you>',
  '',
].join('\n');

// The end of a lane's last message on one line, for a row: the newest words.
function tailText(tail) {
  const said = (tail || '').replace(/\s+/g, ' ').trim();
  return said.length > ASK_CHARS ? `…${said.slice(-ASK_CHARS)}` : said;
}

// An OK is fresh only when its time is the lane's latest event, so a lane
// that moves after its OK is unverified again.
export function okIsFresh(r, l, now = Date.now()) {
  if (r.status !== 'finished' && r.status !== 'continued') return false;
  const iso = ISO_TOKEN.exec(l.rest);
  if (iso) return iso[1] === latestInstant(r);
  const m = TIME_TOKEN.exec(l.rest);
  return !!m && m[1] === latestTime(r, now).slice(-5);
}

// The board's verified predicate: a fresh OK, or an OK on a lane whose prompt
// file is gone (filed, and the watch cannot see it move any more). The page
// names the lanes the DONE row counts by this same rule.
export function verifiedOf(results, store, now = Date.now()) {
  const lanes = new Map(results.map((r) => [r.name, r]));
  const ok = new Map(store.lanes.filter((l) => l.tag === 'OK' && l.name).map((l) => [l.name, l]));
  return (name) => ok.has(name) && (lanes.has(name) ? okIsFresh(lanes.get(name), ok.get(name), now) : true);
}

// results: one status() result per prompt file, in prompt-file mtime order.
// store: foldStore()/readStore(). Rows come out grouped by who acts: the
// hand-off line (HANDOFF) when one is due, faults (BAD), the user (RUN, ANSWER,
// DECIDE, STEP, CLOSE), nobody (LIVE), the coordinator (MINE), nobody (DONE),
// then CTX. CLOSE and DONE are one line each.
export function boardRows(results, store, opts = {}) {
  const prompts = opts.prompts || new Map();
  const now = opts.now || Date.now();
  const row = (tag, ...cols) => `${tag.padEnd(6)}  ${cols.join('  ')}`;
  const peer = (r) => r.peer || (r.session || '?').slice(0, 8);
  const lanes = new Map(results.map((r) => [r.name, r]));
  const last = (tag) => new Map(store.lanes.filter((l) => l.tag === tag && l.name).map((l) => [l.name, l]));
  const ok = last('OK');
  const reported = (r) => r.status === 'finished' || r.status === 'continued';
  const latest = (r) => latestTime(r, now);
  const okFresh = (r, l) => okIsFresh(r, l, now);
  const verified = verifiedOf(results, store, now);
  const launched = (name) => lanes.has(name) && lanes.get(name).status !== 'not_found';
  const items = store.items;
  const ref = (it) => (it.id == null ? it.file : `#${it.id}`);
  const known = new Set([...lanes.keys(), ...ok.keys(), ...items.filter((i) => i.kind === 'LANE' && i.name).map((i) => i.name)]);

  const untilLane = (it) => (it.until && it.until.lane ? [it.until.lane] : []);
  const gh = (n) => (store.github && store.github.get(n)) || null;
  const ghMerged = (n) => !!gh(n) && gh(n).state === 'MERGED';
  const ghClosed = (n) => !!gh(n) && gh(n).state !== 'OPEN';

  const bad = [];
  for (const l of store.githubBad || []) bad.push(`${GITHUB_FILE}: '${l}' is not pr|issue <n> OPEN|CLOSED|MERGED <time> <title>`);
  for (const l of store.lanes) if (!LANE_TAGS.has(l.tag) || !l.name) bad.push(`${LANES_FILE}: '${l.raw.slice(0, 60)}' is not OK|SENT|DID <lane> <time> <text>`);
  const ids = new Map();
  for (const it of items) {
    bad.push(...it.bad);
    if (it.id != null) {
      ids.set(it.id, [...(ids.get(it.id) || []), it.file]);
      if (store.closedIds.has(it.id)) bad.push(`#${it.id} open and closed: ${it.file}, ${CLOSED_DIR}/${store.closedIds.get(it.id)[0]}`);
    }
    for (const t of [...it.after, ...it.blocks, ...untilLane(it), ...Object.values(it.lanes)]) if (!known.has(t)) bad.push(`${ref(it)} names unknown lane '${t}'`);
    if (it.kind === 'HOLD' && it.name && launched(it.name)) bad.push(`${ref(it)} HOLD ${it.name}: already launched`);
    for (const t of it.blocks) if (launched(t)) bad.push(`${ref(it)} blocks ${t}: already launched`);
  }
  for (const [id, files] of ids) if (files.length > 1) bad.push(`dup id ${id}: ${files.join(' ')}`);
  // Cycles over lane names: a lane waits on what its LANE or HOLD item names in
  // after:, and on whatever the items that block it wait on.
  const waits = new Map();
  const wait = (a, b) => waits.set(a, [...(waits.get(a) || []), b]);
  for (const it of items) {
    if (it.name) for (const t of it.after) wait(it.name, t);
    for (const b of it.blocks) for (const t of [...it.after, ...untilLane(it)]) wait(b, t);
  }
  const state = new Map();
  const seen = new Set();
  const dfs = (n, stack) => {
    if (state.get(n) === 1) {
      const c = [...stack.slice(stack.indexOf(n)), n];
      const key = [...new Set(c)].sort().join(' ');
      if (!seen.has(key)) {
        seen.add(key);
        bad.push(`cycle: ${c.join(' -> ')}`);
      }
      return;
    }
    if (state.get(n) === 2) return;
    state.set(n, 1);
    for (const t of waits.get(n) || []) dfs(t, [...stack, n]);
    state.set(n, 2);
  };
  for (const n of waits.keys()) dfs(n, []);

  const unmet = (it) => it.after.filter((a) => !verified(a));
  // A verified implement lane's PR, from the `pr:` line of its report.
  const lanePr = (name) => {
    const r = lanes.get(name);
    return r && r.report ? reportPr(r.report) : null;
  };
  // A lane whose report ends at its gate waits for the user's build word, so
  // it is never a session to close. The word is a SENT line after the OK that
  // verified the stop; the ledger is append-only, so order decides. A later OK
  // clears the word only once the lane's report no longer stops at the gate:
  // the ledger keeps no report per OK, so an OK re-verifying the gate stop
  // while the build runs leaves the word standing.
  const gated = (name) => {
    const r = lanes.get(name);
    return !!r && reported(r) && gateStop(r.report);
  };
  const buildSent = (name) => {
    const stillGated = gated(name);
    let ok = false;
    let sent = null;
    for (const l of store.lanes) {
      if (l.name !== name) continue;
      if (l.tag === 'OK') {
        ok = true;
        if (!stillGated) sent = null;
      } else if (ok && l.tag === 'SENT' && /\bbuild\b/i.test(l.rest || '')) sent = l;
    }
    return sent;
  };
  const sentClock = (l) => {
    const iso = ISO_TOKEN.exec(l.rest);
    if (iso) return clock(iso[1], now);
    const m = TIME_TOKEN.exec(l.rest);
    return m ? m[1] : '';
  };
  // An effort's next act, walking its path: the first kind with no lane, a
  // lane not yet verified, a verified lane whose PR is not merged, then the
  // close-out of its issue. Done when nothing is left.
  // `detail` is false while `open` is still being computed (satisfied calls
  // this): the held/run distinction needs the open items and waits for the row.
  const effortNext = (it, detail = false) => {
    if (!it.size) return 'scoping: scout, then the card';
    if (!it.path.length) return 'rule the card';
    for (const kind of it.path) {
      const lane = it.lanes[kind];
      if (!lane) return `write prompt ${kind}`;
      const r = lanes.get(lane);
      if (!verified(lane)) {
        if (!r || r.status === 'not_found') return `${lane} (${kind}) ${detail && blockers(lane).length ? `held: ${holdText(lane)}` : 'run it'}`;
        if (r.status === 'in_progress') return `${lane} (${kind}) live`;
        if (r.status === 'stopped' && !r.asked) return `${lane} (${kind}) stopped, no question`;
        if (r.status === 'stopped' || r.status === 'stalled') return `${lane} (${kind}) answer it`;
        if (r.status === 'exited') return `${lane} (${kind}) exited, re-issue`;
        return `${lane} (${kind}) verify`;
      }
      if (gated(lane)) return `${lane} (${kind}) ${!buildSent(lane) ? 'gated: waiting on your build word' : r && !r.session_open ? 'build word sent, session gone: re-issue' : 'building since the build word'}`;
      const pr = lanePr(lane);
      if (pr && !ghMerged(pr)) return `${lane} (${kind}) PR #${pr} ${gh(pr) ? gh(pr).state.toLowerCase() : 'open'}, merge is yours`;
    }
    if (it.on && it.on.type === 'issue' && !ghClosed(it.on.n)) return `close out #${it.on.n}: resolution comment, close, gist line`;
    return null;
  };
  const satisfied = (it) => {
    if (it.until) {
      if (it.until.kind === 'merged') return ghMerged(it.until.n);
      if (it.until.kind === 'closed') return ghClosed(it.until.n);
      return it.until.kind === 'ok' ? verified(it.until.lane) : lanes.has(it.until.lane) || ok.has(it.until.lane);
    }
    if (it.kind === 'EFFORT') return effortNext(it) === null;
    if (it.on) return it.on.type === 'pr' ? ghMerged(it.on.n) : ghClosed(it.on.n);
    if (it.kind === 'LANE') return !!it.name && (lanes.has(it.name) || ok.has(it.name));
    if (it.kind === 'HOLD') return unmet(it).length === 0;
    return false;
  };
  const open = items.filter((i) => !satisfied(i));
  // Display only: a snoozed item keeps its edges and its faults; its own row
  // waits for the date.
  const today = isoDate(now);
  const shown = open.filter((i) => !(i.snooze && i.snooze > today));
  const blockers = (lane) => open.filter((i) => i.blocks.includes(lane) || (i.kind === 'HOLD' && i.name === lane));
  const holdText = (lane) => blockers(lane).map((b) => `${ref(b)}${b.kind === 'HOLD' && unmet(b).length ? ` after ${unmet(b).join(' ')}` : ''}`).join(', ');
  const edgeText = (it) => (it.blocks.length ? `  blocks: ${it.blocks.join(' ')}` : '');

  // An unlaunched prompt is a RUN row with its Done when beside it, so the
  // user can pick the session to open; a name that already has an OK is a
  // reused name or a DONE file left behind.
  const runnable = [];
  for (const r of results) {
    if (r.status !== 'not_found' || blockers(r.name).length) continue;
    if (ok.has(r.name)) {
      bad.push(`prompt-${r.name}.txt: name already verified (${ok.get(r.name).raw.slice(0, 40)}); delete the file if it is that lane, else pick a new name`);
      continue;
    }
    const text = prompts.get(r.name) || '';
    const done = promptField(text, 'Done when');
    const kind = promptField(text, 'Kind');
    runnable.push(row('RUN', `prompt-${r.name}.txt`, ...(kind ? [kind] : []), ...(done ? [capTo(done, DONE_MAX)] : [])));
  }
  const out = [];
  // The hand-off line: the session's own context past HANDOFF_AT and no report
  // of another session's work left to verify. It carries no number, so `delta`
  // reports it once, on the turn the moment arrives, and not again as the
  // context grows.
  const unverified = results.some((r) => !verified(r.name) && r.status !== 'not_found' && r.status !== 'in_progress');
  if (handoffDue(opts.ctxTokens == null ? null : opts.ctxTokens, unverified)) {
    out.push(row('HANDOFF', 'hand off now', `past ${short(HANDOFF_AT)} with nothing unverified: everything is on disk; handoff.md only for what no item holds`));
  }
  for (const b of bad) out.push(row('BAD', b));
  out.push(...runnable);
  for (const r of results) {
    if (r.status === 'stopped' && r.asked) out.push(row('ANSWER', r.name, peer(r), `asked: ${r.ask || ''}`));
    else if (r.status === 'stalled') out.push(row('ANSWER', r.name, peer(r), `idle ${fmtDur(now - (r.active || r.mtime))}, no activity`));
    else if (r.status === 'continued' && r.session_open && r.asked && !verified(r.name)) out.push(row('ANSWER', r.name, peer(r), `after report: ${r.ask}`));
    else if (gated(r.name) && verified(r.name) && !buildSent(r.name)) out.push(row('ANSWER', r.name, peer(r), 'gated: waiting on your build word'));
  }
  for (const it of shown) if (it.kind === 'DECIDE') out.push(row('DECIDE', ref(it), capHead(it.head) + edgeText(it)));
  for (const it of shown) if (it.kind === 'STEP') out.push(row('STEP', ref(it), capHead(it.head) + edgeText(it)));
  for (const it of shown) if (it.kind === 'EFFORT' && it.name) out.push(row('EFFORT', `${it.name}${it.size ? ` ${it.size}` : ''}`, effortNext(it, true), ref(it)));
  const close = results.filter((r) => verified(r.name) && r.session_open && !gated(r.name)).map((r) => `${r.name} (${peer(r)})`);
  if (close.length) out.push(row('CLOSE', ...close));
  for (const r of results) {
    if (r.status === 'in_progress') out.push(row('LIVE', r.name, peer(r), `since ${clock(r.prompt_at, now)}`));
    else if (gated(r.name) && verified(r.name) && buildSent(r.name) && r.session_open) out.push(row('LIVE', r.name, peer(r), `building since the build word ${sentClock(buildSent(r.name))}`));
  }
  // MINE newest first: the rows about a lane by its last activity, then the
  // rows about an item by id, highest first. foldMine keeps the newest few.
  const mine = [];
  const laneAt = (r) => (r && r.status !== 'not_found' ? Date.parse(r.last_activity || r.moved_at || r.closed_at || r.stopped_at || r.prompt_at || '') || r.mtime || 0 : 0);
  const byLane = (r, text) => mine.push({ group: 1, at: laneAt(r), text });
  const byItem = (id, text) => mine.push({ group: 0, at: id || 0, text });
  for (const r of results) {
    if (r.status === 'exited') byLane(r, row('MINE', r.name, 'exited without report, re-issue'));
    // A lane that ended its turn on a statement asked the user nothing: reading
    // it is the coordinator's act, never an ANSWER row.
    else if (r.status === 'stopped' && !r.asked) byLane(r, row('MINE', r.name, 'stopped, no question: verify or re-issue', tailText(r.tail)));
    // The build word went to a session that is gone: nothing is building.
    else if (gated(r.name) && verified(r.name) && buildSent(r.name) && !r.session_open) byLane(r, row('MINE', r.name, 'build word sent, session gone: re-issue'));
    else if (r.status === 'finished' && !verified(r.name)) byLane(r, row('MINE', r.name, `verify report ${latest(r)}`));
    else if (r.status === 'continued' && !verified(r.name)) byLane(r, row('MINE', r.name, `re-verify ${latest(r)}`));
    else if (r.status === 'not_found' && blockers(r.name).length) byLane(r, row('MINE', r.name, `held: ${holdText(r.name)}`));
  }
  for (const it of shown) {
    if (it.kind !== 'LANE' || !it.name) continue;
    const waitsOn = [...unmet(it), ...blockers(it.name).filter((b) => b !== it).map(ref)];
    byItem(it.id, row('MINE', it.name, `write prompt ${waitsOn.length ? `after ${waitsOn.join(' ')}` : 'now'}`, ref(it)));
  }
  for (const it of shown) {
    if (it.kind === 'NOTE') byItem(it.id, row('MINE', ref(it), capHead(it.head) + (it.until ? `  until: ${it.until.kind} ${it.until.lane || it.until.n}` : '')));
    else if (!KINDS.has(it.kind)) byItem(it.id, row('MINE', ref(it), capHead(it.raw)));
  }
  const filable = items.filter(satisfied);
  if (filable.length) byItem(Math.max(...filable.map((i) => i.id || 0)), row('MINE', `file: ${filable.map(ref).join(' ')}`));
  for (const l of store.lanes) {
    if (l.tag !== 'OK' || !l.name || l !== ok.get(l.name)) continue;
    const r = lanes.get(l.name);
    if (r && !okFresh(r, l)) byLane(r, row('MINE', `stale: ${l.raw}`));
  }
  mine.sort((a, b) => b.group - a.group || b.at - a.at);
  for (const m of mine) out.push(m.text);
  // A count, never the names: the names of verified lanes are what `L who
  // --all` is for, and naming them here is four fifths of the board's bytes.
  const doneNamed = results.filter((r) => verified(r.name) && !r.session_open).length;
  const filed = [...ok.keys()].filter((n) => !lanes.has(n)).length;
  if (doneNamed || filed) out.push(row('DONE', [...(doneNamed ? [`${doneNamed} verified`] : []), ...(filed ? [`${filed} filed`] : [])].join(', ')));
  const ideas = shown.filter((i) => i.kind === 'IDEA').length;
  const extra = [`items ${shown.length - ideas}`];
  if (ideas) extra.push(`ideas ${ideas}`);
  if (open.length > shown.length) extra.push(`snoozed ${open.length - shown.length}`);
  if (opts.coordinators > 1) extra.push(`coordinators ${opts.coordinators}`);
  if (opts.watches > 1) extra.push(`watches ${opts.watches}`);
  out.push(row('CTX', `coordinator ${opts.ctx || '?'}`, `${opts.repo || '?'}: ${results.length} lane${results.length === 1 ? '' : 's'}`, ...extra));
  return out;
}

// The MINE rows past the newest `keep` fold into one digest row. The digest
// carries a count and no date, so it moves only when the count does and a
// board where nothing changed is still no change. Items stay open.
export const MINE_KEEP = 3;
export function foldMine(rows, keep = MINE_KEEP) {
  const at = rows.map((r, i) => (r.startsWith('MINE') ? i : -1)).filter((i) => i >= 0);
  if (at.length <= keep) return rows;
  const folded = new Set(at.slice(keep));
  const out = rows.filter((_, i) => !folded.has(i));
  out.splice(at[keep - 1] + 1, 0, `MINE    digest: ${folded.size} older, --all`);
  return out;
}

// One line of what changed between two boards, then the counts by who acts:
// `board <stamp> · +RUN prompt-x.txt … · -MINE x verify report 07:40 · you 2 · live 1 · mine 3`.
// CTX is never a change. Pinned by lane.test.mjs.
export function deltaLine(prevRows, rows, stamp, opts = {}) {
  const body = (rs) => (opts.fold ? foldMine(rs, opts.fold) : rs).filter((r) => !r.startsWith('CTX'));
  const squash = (r) => capTo(r.replace(/\s{2,}/g, ' ').trim(), 56);
  const prev = new Set(body(prevRows || []));
  const next = new Set(body(rows));
  const parts = [];
  if (!prevRows) parts.push('first');
  else {
    for (const r of next) if (!prev.has(r)) parts.push(`+${squash(r)}`);
    for (const r of prev) if (!next.has(r)) parts.push(`-${squash(r)}`);
    if (!parts.length) parts.push('no change');
  }
  const count = (tags) => rows.filter((r) => tags.some((t) => r.startsWith(t))).length;
  const bad = count(['BAD']);
  const efforts = count(['EFFORT']);
  return [`board ${stamp}`, ...parts, ...(bad ? [`bad ${bad}`] : []), `you ${count(['RUN', 'ANSWER', 'DECIDE', 'STEP', 'CLOSE'])}`, ...(efforts ? [`efforts ${efforts}`] : []), `live ${count(['LIVE'])}`, `mine ${count(['MINE'])}`].join(' · ');
}

// ---------- commands ----------

const VALUE_FLAGS = new Set(['head-file', 'body-file', 'cwd', 'poll', 'notify', 'session', 'store', 'after', 'blocks', 'until', 'source', 'body', 'ask', 'why', 'done', 'fences', 'pointers', 'kind', 'effort', 'from', 'size', 'path', 'on', 'gh-poll']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (VALUE_FLAGS.has(key)) {
      args[key] = argv[i + 1];
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function statusCommand(args) {
  const name = args._[1];
  if (!name) {
    console.error('usage: lane.mjs status <name> [--cwd DIR] [--json]');
    return 1;
  }
  const lanes = new Lanes(args.cwd || process.cwd(), { store: args.store });
  const lane = lanes.promptFiles().find((l) => l.name === name);
  if (!lane) {
    console.error(`status: no prompt-${name}.txt`);
    return 1;
  }
  const r = lanes.status(lane);
  const coord = lanes.coordinatorCtx();
  if (args.json) console.log(JSON.stringify({ ...r, coordinator_ctx: coord }));
  else console.log(render(r, coord));
  return r.report ? 0 : 3;
}

// Everything one board needs, for `board`, `check` and page.mjs: args are
// { cwd, store }. Every prompt file is read into `prompts`: the board prints
// the Done when of the unlaunched ones, the page every field of all of them.
export function boardData(args) {
  const lanes = new Lanes(args.cwd || process.cwd(), { store: args.store });
  const registry = readRegistry();
  const trees = worktrees(lanes.cwd);
  const results = lanes.promptFiles().map((lane) => lanes.status(lane, registry, trees));
  const store = readStore(lanes.cwd, args.store);
  const prompts = new Map();
  for (const r of results) {
    try {
      prompts.set(r.name, fs.readFileSync(r.prompt_file, 'utf8'));
    } catch {}
  }
  const rows = boardRows(results, store, { ctx: lanes.coordinatorCtx(), ctxTokens: lanes.coordinatorCtxTokens(), prompts, repo: path.basename(lanes.cwd), coordinators: lanes.coordinators(registry, trees), watches: watchCount() });
  return { rows, results, store, prompts, lanes, registry };
}

// The numbers the ledger names: `on:` and `until:` of open items, and the
// `pr:` line of every reported lane. Pure; the value says which kind is
// assumed when nothing is known yet.
export function githubRefs(store, results, satisfied = () => false) {
  const refs = new Map();
  for (const it of store.items) {
    if (satisfied(it)) continue;
    if (it.on) refs.set(it.on.n, it.on.type);
    if (it.until && it.until.n) refs.set(it.until.n, it.until.kind === 'merged' ? 'pr' : 'issue');
  }
  for (const r of results) {
    const n = r.report ? reportPr(r.report) : null;
    if (n) refs.set(n, 'pr');
  }
  return refs;
}

// One number's state from GitHub, through the issues endpoint, which serves
// PRs too. Throws when gh cannot answer.
export function ghLookup(cwd, n) {
  let out;
  try {
    out = execFileSync('gh', ['api', `repos/{owner}/{repo}/issues/${n}`, '--jq', '{number,state,title,closed_at,merged_at:(.pull_request.merged_at // null),pr:(.pull_request!=null)}'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = String(e.stderr || '').split('\n').find((l) => l.trim()) || e.message;
    throw new Error(e.code === 'ENOENT' ? 'gh is not installed' : err.trim());
  }
  const o = JSON.parse(out);
  return { type: o.pr ? 'pr' : 'issue', n: o.number, state: o.merged_at ? 'MERGED' : o.state === 'closed' ? 'CLOSED' : 'OPEN', at: o.merged_at || o.closed_at || null, title: String(o.title || '').trim() };
}

// Refresh github.txt for the numbers the ledger names. Numbers already in a
// terminal state are asked again only with `all`; a lookup that fails keeps
// the line it had. Returns the transitions as printable lines.
export function syncGithub(cwd, store, results, opts = {}) {
  const lookup = opts.lookup || ((n) => ghLookup(cwd, n));
  const known = new Map(store.github || []);
  const refs = githubRefs(store, results);
  const changed = [];
  const failed = [];
  let reason = null;
  for (const [n, type] of refs) {
    const prev = known.get(n);
    if (prev && prev.state !== 'OPEN' && !opts.all) continue;
    let cur;
    try {
      cur = lookup(n);
    } catch (e) {
      failed.push(n);
      reason = reason || (e && e.message) || 'no answer';
      if (!prev) changed.push(`#${n}: no answer from gh (${type})`);
      continue;
    }
    known.set(n, cur);
    if (!prev) changed.push(`#${n}: ${cur.state.toLowerCase()} (${cur.type}) ${cur.title}`);
    else if (prev.state !== cur.state) changed.push(`#${n}: ${prev.state.toLowerCase()} -> ${cur.state.toLowerCase()} (${cur.type}) ${cur.title}`);
  }
  const lines = [...known.values()].filter((g) => refs.has(g.n)).sort((a, b) => a.n - b.n).map(githubLine);
  return { lines, changed, failed, reason };
}

// Whole-file writes the watch and the page read go through a rename, so a
// reader never sees a half-written file.
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

function writeGithub(dir, lines) {
  writeAtomic(path.join(dir, GITHUB_FILE), lines.length ? `${lines.join('\n')}\n` : '');
}

function syncCommand(args) {
  const { results, store } = boardData(args);
  const { lines, changed, failed, reason } = syncGithub(path.resolve(args.cwd || process.cwd()), store, results, { all: !!args.all });
  writeGithub(store.dir, lines);
  console.log(changed.length ? changed.join('\n') : `${GITHUB_FILE}: ${lines.length} number${lines.length === 1 ? '' : 's'}, no change`);
  if (failed.length) {
    console.error(`sync: gh failed for ${failed.map((n) => `#${n}`).join(' ')}: ${reason}`);
    return 1;
  }
  return 0;
}

function gitRun(cmd, argv) {
  return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// What a worktree holds, read with `run` (execFileSync-shaped): its top level,
// the uncommitted files, and the commits not on the base ref. A read that fails
// is null, printed as (unreadable), never an exception.
export function worktreeFacts(cwd, run = gitRun) {
  const read = (argv) => {
    if (!cwd) return null;
    try {
      return run('git', ['-C', cwd, ...argv]);
    } catch {
      return null;
    }
  };
  const top = read(['rev-parse', '--show-toplevel']);
  const status = top == null ? null : read(['status', '--porcelain']);
  const base = top == null ? null : ['origin/HEAD', 'origin/main', 'main'].find((ref) => read(['rev-parse', '--verify', '--quiet', ref]) != null) || null;
  const log = base ? read(['log', '--format=%h %s', `${base}..HEAD`]) : null;
  const lines = (s) => (s == null ? null : s.split('\n').filter((l) => l.trim()));
  return { worktree: top == null ? cwd || null : top.trim(), base, dirty: status == null ? null : lines(status).map((l) => l.slice(3)), ahead: lines(log) };
}

// The last `key:` field of a REPORT block with its continuation lines.
export function lastReportSection(report) {
  const lines = (report || '').split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !/^[a-z]+:/.test(lines[i])) i--;
  return i < 0 ? null : capTo(lines.slice(i).map((l) => l.trim()).filter(Boolean).join(' '), TAIL_CHARS);
}

// The last body line of an item that carries a date.
export function lastDatedLine(body) {
  const dated = (body || '').split('\n').filter((l) => /\d{4}-\d\d-\d\d/.test(l));
  return dated.length ? capHead(dated[dated.length - 1].trim()) : null;
}

// The resume view: per live lane its status, session, worktree, uncommitted
// files, commits ahead of the base and its report's last section; per open
// STEP or DECIDE its headline and its last dated body line. factsOf(r) is
// worktreeFacts for the lane's session directory. Pure but for factsOf.
export function resumeRows(live, items, factsOf) {
  const out = [];
  const listed = (xs, sep) => (xs == null ? '(unreadable)' : xs.length ? xs.join(sep) : 'none');
  for (const r of live) {
    const f = factsOf(r);
    out.push(`LIVE    ${r.name}  ${r.status}  ${r.peer || (r.session || '?').slice(0, 8)}  ${f.worktree || '(unreadable)'}`);
    out.push(`  uncommitted: ${listed(f.dirty, ' ')}`);
    out.push(`  ahead of ${f.base || 'the base'}: ${listed(f.ahead, '; ')}`);
    out.push(`  report: ${lastReportSection(r.report) || 'none yet'}`);
  }
  for (const it of items) out.push(`${it.kind.padEnd(6)}  #${it.id}  ${capHead(it.head)}  last: ${lastDatedLine(it.body) || 'no dated line'}`);
  return out.length ? out : ['nothing live, no open STEP or DECIDE'];
}

function resumeCommand(args) {
  const { rows, results, store, lanes, registry } = boardData(args);
  const ok = okNames(store);
  const live = results.filter((r) => isLive(r, ok)).map((r) => ({ ...r, cwd: lanes.sessionCwd(r, registry) }));
  const onBoard = new Set(rows.map((r) => /^(?:STEP|DECIDE)\s+#(\d+)/.exec(r)).filter(Boolean).map((m) => Number(m[1])));
  const items = store.items.filter((i) => (i.kind === 'STEP' || i.kind === 'DECIDE') && onBoard.has(i.id));
  console.log(resumeRows(live, items, (r) => worktreeFacts(r.cwd)).join('\n'));
  return 0;
}

// Rows of `who`: the lanes that can still hold something, with the session the
// human can find each by. ttyOf maps a pid to its terminal. `opts.ok` is the
// OK set isLive reads and `opts.all` prints every launched lane instead. Pure.
export function whoRows(results, registry, ttyOf, now = Date.now(), opts = {}) {
  const bySession = new Map(registry.map((e) => [e.sessionId, e]));
  const ok = opts.ok || new Set();
  const out = [];
  for (const r of results) {
    if (!r.session) continue;
    if (!opts.all && !isLive(r, ok)) continue;
    const e = bySession.get(r.session);
    const cols = [r.name, r.peer || e?.name || r.session.slice(0, 8), e && e.pid ? ttyOf(e.pid) || '?' : 'gone', e ? e.status || '?' : r.status, `idle ${fmtDur(now - (r.active || r.mtime || now))}`, e && e.cwd ? e.cwd.replace(HOME, '~') : ''];
    out.push(cols.join('  '));
  }
  return out;
}

function ttyOf(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'tty='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function whoCommand(args) {
  const lanes = new Lanes(args.cwd || process.cwd(), { store: args.store });
  const registry = readRegistry();
  const trees = worktrees(lanes.cwd);
  const only = args._[1];
  const results = lanes.promptFiles().filter((l) => !only || l.name === only).map((lane) => lanes.status(lane, registry, trees));
  const all = !!args.all || !!only;
  const ok = okNames(readStore(lanes.cwd, args.store));
  const rows = whoRows(results, registry, ttyOf, lanes.now(), { all, ok });
  console.log(rows.length ? rows.join('\n') : only ? `${only}: no session holds it` : all ? 'no launched lane' : 'no lane holds anything: --all for every launched lane');
  if (!all) {
    const hidden = whoRows(results, registry, ttyOf, lanes.now(), { all: true, ok }).length - rows.length;
    if (hidden > 0) console.log(`${hidden} finished, --all`);
  }
  return 0;
}

// The message the coordinator sends to a lane's session, and the SENT line
// that records it: the user's words, verbatim, under a `TO` heading.
export function relayText(name, text) {
  return `TO ${name}\n${text}`;
}

function relayCommand(args) {
  const [, name, ...rest] = args._;
  const text = rest.join(' ') || (args.body || '');
  if (!name || !text.trim()) {
    console.error('usage: lane.mjs relay <lane> <text…> [--cwd DIR]');
    return 1;
  }
  const lanes = new Lanes(args.cwd || process.cwd(), { store: args.store });
  const lane = lanes.promptFiles().find((l) => l.name === name);
  if (!lane) {
    console.error(`relay: no prompt-${name}.txt`);
    return 1;
  }
  const r = lanes.status(lane);
  if (!r.session) {
    console.error(`relay: ${name} is ${r.status}; no session to send to`);
    return 1;
  }
  const line = `SENT ${name} ${nowIso()} ${text.replace(/\s+/g, ' ').trim()}`;
  appendLane(storeDir(lanes.cwd, args.store), line);
  console.log(`to: ${r.peer || r.session}\n${relayText(name, text)}\n${line}`);
  return 0;
}

function didCommand(args) {
  const [, name, ...rest] = args._;
  if (!name || !rest.length) {
    console.error('usage: lane.mjs did <effort> <what…> [--cwd DIR]');
    return 1;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  if (!readStore(cwd, args.store).items.some((it) => it.kind === 'EFFORT' && it.name === name)) {
    console.error(`did: no open EFFORT named ${name}`);
    return 1;
  }
  const line = `DID ${name} ${nowIso()} ${rest.join(' ')}`;
  appendLane(storeDir(cwd, args.store), line);
  console.log(line);
  return 0;
}

// The open item an id or a name points at, with its path and text.
function findItem(dir, what) {
  const store = readStore(path.dirname(dir), dir);
  const it = /^#?\d+$/.test(what) ? store.items.find((i) => i.id === Number(what.replace('#', ''))) : store.items.find((i) => i.name === what);
  if (!it) return null;
  const file = path.join(dir, it.file);
  return { item: it, file, text: fs.readFileSync(file, 'utf8') };
}

function setCommand(args) {
  const [, what, key, ...rest] = args._;
  const value = rest.join(' ');
  if (!what || !key || !ITEM_KEYS.has(key)) {
    console.error(`usage: lane.mjs set <id|name> <key> <value…> [--cwd DIR]\nkey is one of ${[...ITEM_KEYS].join(' ')}`);
    return 1;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  const hit = findItem(storeDir(cwd, args.store), what);
  if (!hit) {
    console.error(`set: no open item ${what}`);
    return 1;
  }
  const text = setHeaderKey(hit.text, key, value);
  const faults = parseItem(hit.file, text).bad;
  if (faults.length) {
    console.error(`set: ${faults.join('\n     ')}`);
    return 1;
  }
  fs.writeFileSync(hit.file, text);
  console.log(`${STORE_DIR}/${hit.item.file}: ${key}: ${value}`);
  return 0;
}

// today+N as a `snooze:` date through `set`, then the why as a body line.
function snoozeCommand(args) {
  const [, what, days, ...why] = args._;
  const dm = /^(\d+)d$/.exec(days || '');
  if (!what || !dm) {
    console.error('usage: lane.mjs snooze <id|name> <N>d [why…] [--cwd DIR]');
    return 1;
  }
  const d = new Date();
  d.setDate(d.getDate() + Number(dm[1]));
  const date = isoDate(d.getTime());
  const code = setCommand({ ...args, _: ['set', what, 'snooze', date] });
  if (code || !why.length) return code;
  const cwd = path.resolve(args.cwd || process.cwd());
  const hit = findItem(storeDir(cwd, args.store), what);
  const line = `snoozed ${clock(Date.now(), Date.now())} until ${date}: ${why.join(' ')}`;
  const text = hit.text.trimEnd();
  fs.writeFileSync(hit.file, `${text}${/\n\s*\n/.test(text) ? '\n' : '\n\n'}${line}\n`);
  console.log(line);
  return 0;
}

function scoutCommand(args) {
  const what = args._[1];
  if (!what) {
    console.error('usage: lane.mjs scout <effort> [--cwd DIR]');
    return 1;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  const hit = findItem(storeDir(cwd, args.store), what);
  if (!hit || hit.item.kind !== 'EFFORT') {
    console.error(`scout: no open EFFORT ${what}`);
    return 1;
  }
  console.log(scoutPrompt(cwd, hit.item));
  return 0;
}

function boardCommand(args) {
  const { rows, results, store } = boardData(args);
  if (args.json) {
    const items = store.items.map(({ body, ...it }) => it);
    console.log(JSON.stringify({ rows, items, lanes: store.lanes, results: results.map((r) => ({ name: r.name, status: r.status, session: r.session || null, peer: r.peer || null })) }));
  } else console.log((args.all ? rows : foldMine(rows)).join('\n'));
  return 0;
}

function checkCommand(args) {
  const bad = boardData(args).rows.filter((r) => r.startsWith('BAD'));
  if (bad.length) console.log(bad.join('\n'));
  return bad.length ? 1 : 0;
}

function showCommand(args) {
  const what = args._[1];
  if (!what) {
    console.error('usage: lane.mjs show <id|lane> [--cwd DIR]');
    return 1;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  const dir = storeDir(cwd, args.store);
  const print = (rel, text) => console.log(`--- ${rel} ---\n${text.trimEnd()}`);
  if (/^#?\d+$/.test(what)) {
    const id = Number(what.replace('#', ''));
    let hits = 0;
    for (const [sub, d] of [['', dir], [`${CLOSED_DIR}/`, path.join(dir, CLOSED_DIR)]]) {
      for (const f of listMd(d)) {
        if (!f.startsWith(`${id}-`)) continue;
        print(`${STORE_DIR}/${sub}${f}`, fs.readFileSync(path.join(d, f), 'utf8'));
        hits++;
      }
    }
    if (!hits) console.error(`show: no item #${id}`);
    return hits ? 0 : 1;
  }
  const store = readStore(cwd, args.store);
  const hits = store.items.filter((it) => it.name === what || it.after.includes(what) || it.blocks.includes(what) || (it.until && it.until.lane === what) || Object.values(it.lanes).includes(what));
  for (const it of hits) print(`${STORE_DIR}/${it.file}`, fs.readFileSync(path.join(dir, it.file), 'utf8'));
  for (const l of store.lanes) if (l.name === what) console.log(`${LANES_FILE}: ${l.raw}`);
  if (!hits.length) console.error(`show: no open item names lane ${what}`);
  return hits.length ? 0 : 1;
}

function newCommand(args) {
  const [, kindRaw, ...rest] = args._;
  const kind = (kindRaw || '').toUpperCase();
  const usage = 'usage: lane.mjs new KIND [name] <headline…> | --head-file FILE [--body-file FILE] [--after "a b"] [--blocks "x y"] [--until "ok x"] [--on "issue N"] [--size S|M|L] [--path "research implement"] [--source S] [--body T] [--cwd DIR]';
  if (!KINDS.has(kind)) {
    console.error(`${usage}\nKIND is one of ${[...KINDS].join(' ')}`);
    return 1;
  }
  const name = NAMED_KINDS.has(kind) ? rest.shift() || null : null;
  const fromFile = (flag) => {
    try {
      return fs.readFileSync(path.resolve(args.cwd || process.cwd(), String(args[flag])), 'utf8');
    } catch (e) {
      throw new Error(`new: --${flag} ${args[flag]}: ${e.code || e.message}`);
    }
  };
  let head = rest.join(' ');
  let fileBody = null;
  try {
    if (args['head-file']) {
      if (head) {
        console.error('new: the headline comes from --head-file or from argv, not both');
        return 1;
      }
      head = (fromFile('head-file').split('\n').find((l) => l.trim()) || '').trim();
    } else if (/`|\$\(/.test(head)) {
      // By the time a backtick or $( inside double quotes reaches this process the
      // shell has already run it; one that arrives unexpanded is refused before
      // anyone copies it back into a shell.
      console.error(`new: the headline carries ${head.includes('`') ? 'a backtick' : '$('}, which a shell runs as a command before lane.mjs sees it; write the headline to a file and pass --head-file FILE`);
      return 1;
    }
    if (args['body-file']) fileBody = fromFile('body-file');
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  if (NAMED_KINDS.has(kind) ? !name : !head) {
    console.error(`new: ${kind} needs a ${NAMED_KINDS.has(kind) ? 'name' : 'headline'}\n${usage}`);
    return 1;
  }
  if (kind === 'HOLD' && !String(args.after || '').trim()) {
    console.error('new: a HOLD waits on --after lanes; to hold a lane by hand, put blocks: on a NOTE or STEP');
    return 1;
  }
  const header = [[kind, name, head].filter(Boolean).join(' ')];
  for (const k of ['after', 'blocks', 'until', 'source', 'size', 'path', 'on']) if (args[k]) header.push(`${k}: ${String(args[k]).trim()}`);
  let body = fileBody != null ? fileBody : args.body || '';
  if (!body && fileBody == null && !tty.isatty(0)) {
    try {
      body = fs.readFileSync(0, 'utf8');
    } catch (e) {
      console.error(`new: stdin: ${e.code || e.message}`);
      return 1;
    }
  }
  const text = `${header.join('\n')}\n${body.trim() ? `\n${body.trim()}\n` : ''}`;
  const cwd = path.resolve(args.cwd || process.cwd());
  const dir = storeDir(cwd, args.store);
  const faults = parseItem(`${nextId(dir)}-x.md`, text).bad;
  if (name) {
    const taken = readStore(cwd, args.store).items.find((it) => NAMED_KINDS.has(it.kind) && it.name === name);
    if (taken) faults.push(`${name} is already ${taken.kind} #${taken.id}; a name is never reused`);
  }
  if (faults.length) {
    console.error(`new: ${faults.join('\n     ')}`);
    return 1;
  }
  const { file } = mintItem(dir, name || head, text);
  console.log(path.relative(cwd, file));
  return 0;
}

function fileCommand(args) {
  const id = Number(String(args._[1] || '').replace('#', ''));
  if (!id) {
    console.error('usage: lane.mjs file <id> [--cwd DIR]');
    return 1;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  const dir = storeDir(cwd, args.store);
  const hits = listMd(dir).filter((f) => f.startsWith(`${id}-`));
  if (hits.length !== 1) {
    console.error(hits.length ? `file: ${hits.length} open items with id ${id}: ${hits.join(' ')}` : `file: no open item #${id}`);
    return 1;
  }
  fs.mkdirSync(path.join(dir, CLOSED_DIR), { recursive: true });
  fs.renameSync(path.join(dir, hits[0]), path.join(dir, CLOSED_DIR, hits[0]));
  console.log(`${STORE_DIR}/${CLOSED_DIR}/${hits[0]}`);
  return 0;
}

async function watchCommand(args) {
  const lanes = new Lanes(args.cwd || process.cwd(), { store: args.store });
  const poll = args.poll === undefined ? POLL_MS : Number(args.poll);
  const ghPoll = args['gh-poll'] === undefined ? GH_POLL_MS : Number(args['gh-poll']);
  if (!(poll > 0) || !(ghPoll > 0)) {
    console.error('usage: lane.mjs watch [--cwd DIR] [--poll MS] [--notify FILE] [--gh-poll MS]   (MS is a positive number)');
    return 1;
  }
  const notify = new NotifyTail(args.notify ? path.resolve(lanes.cwd, args.notify) : NOTIFY_LOG);
  const seen = new Map();
  const laneOf = new Map();
  let ghAt = 0;
  let first = true;
  for (;;) {
    const registry = readRegistry();
    const trees = worktrees(lanes.cwd);
    const files = lanes.promptFiles();
    const summary = [];
    for (const lane of files) {
      const r = lanes.status(lane, registry, trees);
      if (r.session) laneOf.set(r.session, lane.name);
      const key = `${r.status}:${r.session || ''}:${r.close_index ?? ''}:${r.turn_index ?? ''}`;
      if (first) {
        summary.push(`${lane.name}=${r.status}`);
        seen.set(lane.name, key);
        continue;
      }
      if (seen.get(lane.name) === key) continue;
      seen.set(lane.name, key);
      console.log(render(r, r.status === 'finished' ? lanes.coordinatorCtx() : null));
    }
    for (const name of [...seen.keys()]) {
      if (files.some((l) => l.name === name)) continue;
      seen.delete(name);
      console.log(render({ name, status: 'gone' }));
    }
    // The log is machine-wide; a session that has not adopted a lane yet is
    // still worth a line when it sits in this repo or one of its worktrees.
    for (const n of notify.read()) {
      if (n.session_id && n.session_id === lanes.own) continue;
      const name = laneOf.get(n.session_id) || null;
      if (!name && !(n.cwd && trees.has(path.resolve(n.cwd)))) continue;
      console.log(renderNotify(n, name));
    }
    // GitHub once a minute: the numbers the ledger names, printed only when
    // a state moves; the first pass arms the file and prints nothing new.
    if (ghPoll > 0 && lanes.now() - ghAt >= ghPoll) {
      ghAt = lanes.now();
      try {
        const store = readStore(lanes.cwd, args.store);
        const results = files.map((l) => lanes.status(l, registry, trees));
        const { lines, changed } = syncGithub(lanes.cwd, store, results);
        writeGithub(store.dir, lines);
        if (!first) for (const c of changed) console.log(`github: ${c}`);
      } catch {
        // gh unavailable; the file keeps what it had
      }
    }
    if (first) {
      const coord = lanes.coordinatorCtx();
      console.log(`lane watch ${path.basename(lanes.cwd)}: ${summary.length ? summary.join('  ') : 'no prompt files'}${coord ? `  coordinator ctx ${coord}` : ''}`);
      first = false;
    }
    await sleep(poll);
  }
}

function ctxCommand(args) {
  const sid = args.session || ownSessionId();
  if (!sid) {
    console.error('ctx: no --session and neither CLAUDE_CODE_SESSION_ID nor CLAUDE_PID is set');
    return 1;
  }
  const entry = readRegistry().find((e) => e.sessionId === sid) || null;
  const file = findTranscript(sid, entry ? entry.cwd : process.cwd());
  // Claude Code writes the transcript only once the first prompt is in, so
  // a hook on that prompt runs before it exists: nothing to report, not a fault.
  if (!file) return 0;
  const records = parseLines(fs.readFileSync(file, 'utf8'));
  const n = ctxTokens(records);
  if (n == null) return 0;
  console.log(`ctx ${short(n)}/${short(ctxWindow(records, entry))}`);
  return 0;
}

function appendLane(dir, line) {
  fs.mkdirSync(path.join(dir, CLOSED_DIR), { recursive: true });
  fs.appendFileSync(path.join(dir, LANES_FILE), `${line}\n`);
}

// The exclude file of the repo, found through git so a worktree (whose
// `.git` is a file) resolves to the shared one; null outside a repo.
function excludeFile(cwd) {
  try {
    const p = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.resolve(cwd, p);
  } catch {
    return null;
  }
}

// The one line that makes `L` real in a shell: a function naming this file by
// its absolute path, resolved from the module itself because only the skill
// loader expands ${CLAUDE_SKILL_DIR}. A function dies with its shell call, so
// the line goes at the head of every call that runs `L`.
export function shorthandLine(file = fileURLToPath(import.meta.url)) {
  return `L() { node '${file.replace(/'/g, "'\\''")}' "$@"; }`;
}

function initCommand(args) {
  if (args.hook) {
    console.log(HOOK_JSON);
    console.error('paste into the repo\'s .claude/settings.local.json (merge into an existing "hooks" key); the command needs jq');
    return 0;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  const dir = storeDir(cwd, args.store);
  const had = fs.existsSync(dir);
  fs.mkdirSync(path.join(dir, CLOSED_DIR), { recursive: true });
  console.log(`${path.relative(cwd, dir)}/${had ? ': exists' : ''}`);
  const goals = path.join(dir, GOALS_FILE);
  if (!fs.existsSync(goals)) {
    fs.writeFileSync(goals, GOALS_TEMPLATE);
    console.log(`${path.relative(cwd, goals)}: skeleton, fill it in`);
  }
  const exclude = excludeFile(cwd);
  const rel = path.relative(cwd, dir);
  const wanted = [...(rel.startsWith('..') || path.isAbsolute(rel) ? [] : [`/${rel}/`]), '/prompt-*.txt'];
  if (!exclude) {
    console.log(`not a git repo: ${wanted.join(' ')} not excluded`);
    console.log(shorthandLine());
    return 0;
  }
  let text = '';
  try {
    text = fs.readFileSync(exclude, 'utf8');
  } catch {}
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const missing = wanted.filter((l) => !have.has(l) && !have.has(l.slice(1)));
  if (missing.length) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${text.endsWith('\n') || !text ? '' : '\n'}${missing.join('\n')}\n`);
    console.log(`${path.relative(cwd, exclude)}: added ${missing.join(' ')}`);
  }
  console.log(shorthandLine());
  return 0;
}

function promptCommand(args) {
  const name = args._[1];
  if (!name) {
    console.error('usage: lane.mjs prompt <name> --kind K [--effort E] [--gate] [--runner] [--force] [--from FILE | --ask T --done T --fences T …] [--cwd DIR]');
    return 1;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  const dir = storeDir(cwd, args.store);
  let fromText = '';
  if (args.from) {
    try {
      fromText = fs.readFileSync(path.resolve(cwd, args.from), 'utf8');
    } catch {
      console.error(`prompt: --from ${args.from}: not found`);
      return 1;
    }
  }
  const fromFile = parseFields(fromText);
  const fields = Object.fromEntries(PROMPT_FIELDS.map(([k]) => [k, String(args[k] || fromFile[k] || '').replace(/\s*\n\s*/g, ' ').trim()]));
  const opts = { kind: args.kind || '', gate: !!args.gate, runner: !!args.runner, force: !!args.force, effort: args.effort || null, ticket: null };
  const ids = new Set();
  for (const d of [dir, path.join(dir, CLOSED_DIR)]) for (const f of listMd(d)) if (/^\d+-/.test(f)) ids.add(Number(f.split('-')[0]));
  const faults = [...promptFaults(name, fields, ids, opts), ...labelFaults(fromText)];
  const store = readStore(cwd, args.store);
  let effort = null;
  if (opts.effort && LANE_KINDS.has(opts.kind)) {
    effort = store.items.find((i) => i.kind === 'EFFORT' && i.name === opts.effort) || null;
    faults.push(...effortFaults(effort, opts));
    if (effort && effort.on && effort.on.type === 'issue') opts.ticket = effort.on.n;
    const leg = effort ? effort.path.indexOf(opts.kind) : -1;
    opts.later = leg >= 0 && leg < effort.path.length - 1;
  }
  const file = path.join(dir, `prompt-${name}.txt`);
  if (name && [file, path.join(cwd, `prompt-${name}.txt`)].some((f) => fs.existsSync(f))) faults.push(`prompt-${name}.txt exists; a launched file is never edited, so pick a new name`);
  if (store.lanes.some((l) => l.tag === 'OK' && l.name === name)) faults.push(`${name} already has an OK; a name is never reused`);
  if (faults.length) {
    console.error(`prompt: ${faults.join('\n        ')}`);
    return 1;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buildPrompt(name, fields, opts), { flag: 'wx' });
  console.log(path.relative(cwd, file));
  if (effort) {
    const ef = path.join(dir, effort.file);
    const lanes = { ...effort.lanes, [opts.kind]: name };
    fs.writeFileSync(ef, setHeaderKey(fs.readFileSync(ef, 'utf8'), 'lanes', Object.entries(lanes).map(([k, v]) => `${k}=${v}`).join(' ')));
    console.log(`${STORE_DIR}/${effort.file}: lanes: ${opts.kind}=${name}`);
  }
  return 0;
}

function okCommand(args) {
  const [, name, ...rest] = args._;
  if (!name) {
    console.error('usage: lane.mjs ok <name> <evidence…> [--cwd DIR]');
    return 1;
  }
  const lanes = new Lanes(args.cwd || process.cwd(), { store: args.store });
  const lane = lanes.promptFiles().find((l) => l.name === name);
  if (!lane) {
    console.error(`ok: no prompt-${name}.txt; a lane whose file is gone is retired, not verified`);
    return 1;
  }
  const r = lanes.status(lane);
  if (!r.report) {
    console.error(`ok: ${name} is ${r.status}, nothing to verify yet`);
    return 1;
  }
  const line = `OK ${name} ${latestInstant(r)} ${rest.join(' ') || 'none'}`;
  appendLane(storeDir(lanes.cwd, args.store), line);
  console.log(line);
  return 0;
}

function retireCommand(args) {
  const [, name, ...rest] = args._;
  if (!name || !rest.length) {
    console.error('usage: lane.mjs retire <name> <why…> [--cwd DIR]');
    return 1;
  }
  if (!NAME_RE.test(name)) {
    console.error(`retire: name '${name}' is not lower-case letters, digits and dashes`);
    return 1;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  const dir = storeDir(cwd, args.store);
  const store = readStore(cwd, args.store);
  const files = [path.join(dir, `prompt-${name}.txt`), path.join(cwd, `prompt-${name}.txt`)].filter((f) => fs.existsSync(f));
  const named = (it) => it.name === name || it.after.includes(name) || it.blocks.includes(name) || (it.until && it.until.lane === name) || Object.values(it.lanes).includes(name);
  if (!files.length && !store.items.some(named) && !store.lanes.some((l) => l.name === name)) {
    console.error(`retire: no lane named ${name}`);
    return 1;
  }
  const line = `OK ${name} ${nowIso()} retired: ${rest.join(' ')}`;
  appendLane(dir, line);
  const out = [line];
  for (const f of files) {
    try {
      fs.unlinkSync(f);
      out.push(`removed ${path.relative(cwd, f)}`);
    } catch {}
  }
  for (const it of store.items) {
    if (it.kind !== 'EFFORT' || !Object.values(it.lanes).includes(name)) continue;
    const kept = Object.entries(it.lanes).filter(([, v]) => v !== name);
    const ef = path.join(dir, it.file);
    fs.writeFileSync(ef, setHeaderKey(fs.readFileSync(ef, 'utf8'), 'lanes', kept.map(([k, v]) => `${k}=${v}`).join(' ')));
    out.push(`${STORE_DIR}/${it.file}: lanes: ${kept.length ? kept.map(([k, v]) => `${k}=${v}`).join(' ') : 'none'}`);
  }
  console.log(out.join('\n'));
  return 0;
}

// One row of `live`: the lane, its status, the session, and the prompt's Fences
// line capped so one wide claim cannot dominate the output. Pure.
export function liveRow(name, r, fences) {
  return `${name}  ${r.status}  ${r.peer || (r.session || '?').slice(0, 8)}  fences: ${fences ? capTo(fences, FENCE_ECHO) : '(no Fences line)'}`;
}

function liveCommand(args) {
  const lanes = new Lanes(args.cwd || process.cwd(), { store: args.store });
  const registry = readRegistry();
  const trees = worktrees(lanes.cwd);
  const ok = okNames(readStore(lanes.cwd, args.store));
  let n = 0;
  let hidden = 0;
  for (const lane of lanes.promptFiles()) {
    const r = lanes.status(lane, registry, trees);
    if (r.status === 'not_found') continue;
    if (!args.all && !isLive(r, ok)) {
      hidden++;
      continue;
    }
    let fences = '';
    try {
      fences = promptField(fs.readFileSync(lane.file, 'utf8'), 'Fences');
    } catch {}
    console.log(liveRow(lane.name, r, fences));
    n++;
  }
  if (!n) console.log(args.all ? 'no launched lane' : 'no lane holds anything: --all for every launched lane');
  if (hidden) console.log(`${hidden} finished, --all`);
  return 0;
}

// Fence tokens every prompt carries that hold nothing: the base ref, the
// worktree and review roots, the rules, the ledger.
const FENCE_NOISE = new Set(['origin/main', 'main', '.claude/worktrees', '.claude/worktrees/', '.claude/reviews', '.claude/reviews/', '.claude/rules/', 'coordinator/', 'CLAUDE.md', 'goals.md']);

// The path-like tokens of a Fences line: anything with a directory segment,
// quotes and trailing punctuation stripped, URLs and the noise skipped. A bare
// file name (`nightshift.yml`, `REPORT.md`, `prompt-*.txt`) names no place in
// the tree, so two prompts that both mention one are not overlapping; the same
// reason fenceOverlap discards a single-segment directory.
export function fenceTokens(fences) {
  const out = [];
  for (const raw of (fences || '').split(/\s+/)) {
    const t = raw.replace(/^[`'"([{<]+/, '').replace(/[`'"),\]}>;:.]+$/, '').replace(/^\.\//, '');
    if (!t || /^http/i.test(t) || FENCE_NOISE.has(t) || t.startsWith('coordinator/') || !t.includes('/')) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// The token two fence lists share: the same path, or a directory of at least
// two segments above the other; null when disjoint. A single-segment directory
// (`web/`, `dakr/`) is a tree-wide claim or exclusion, boilerplate-grade, and
// never counts, not even as an exact match: two lanes claiming one whole
// top-level tree are not caught here; `L live` is that check.
export function fenceOverlap(a, b) {
  const bare = (t) => /^[^/]+\/$/.test(t);
  const under = (dir, p) => !bare(dir) && p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
  for (const x of a) for (const y of b) if ((x === y && !bare(x)) || under(x, y) || under(y, x)) return x.length <= y.length ? x : y;
  return null;
}

// The launch block the coordinator hands the user: every RUN row of the board
// as a `claude -n <name> "$(cat prompt-<name>.txt)"` line, the prompt handed to
// the session as its first argument so nothing is pasted, grouped greedily in
// board order so a block's fences are disjoint, a later block naming the token
// it shares with the one above; a prompt the board holds, or whose fences meet
// a live lane's, goes under HELD with the reason. Live is in_progress, or
// stopped, stalled or continued with no OK yet; a finished or verified lane
// holds nothing. Names and file names only, never prompt text. Pinned by
// lane.test.mjs.
export function launchBlock(rows, results, prompts, store) {
  const tokens = (name) => fenceTokens(promptField(prompts.get(name) || '', 'Fences'));
  const ok = okNames(store);
  const live = results.filter((r) => isLive(r, ok)).map((r) => [r.name, tokens(r.name)]);
  const held = [];
  for (const r of rows) {
    const m = /^MINE\s+(\S+)  (held: .*)$/.exec(r);
    if (m) held.push([m[1], m[2]]);
  }
  const groups = [];
  for (const r of rows) {
    const m = /^RUN\s+prompt-(\S+)\.txt(?:\s|$)/.exec(r);
    if (!m) continue;
    const name = m[1];
    const t = tokens(name);
    const clash = live.map(([lane, lt]) => [lane, fenceOverlap(t, lt)]).find(([, on]) => on);
    if (clash) {
      held.push([name, `overlaps live ${clash[0]} on ${clash[1]}`]);
      continue;
    }
    let on = null;
    const g = groups.find((g) => !(on = g.members.map((m) => fenceOverlap(t, m.tokens)).find(Boolean) || null));
    if (g) g.members.push({ name, tokens: t });
    else groups.push({ members: [{ name, tokens: t }], on });
  }
  const names = [...groups.flatMap((g) => g.members.map((m) => m.name)), ...held.map(([n]) => n)];
  if (!names.length) return ['no prompt to launch'];
  const w = Math.max(...names.map((n) => `claude -n ${n}`.length));
  const relOf = (name) => (results.find((r) => r.name === name) || {}).rel || `prompt-${name}.txt`;
  const cmd = (name) => `${`claude -n ${name}`.padEnd(w)} "$(cat ${relOf(name)})"`;
  const wide = Math.max(...names.map((n) => cmd(n).length));
  const line = (name, note) => `  ${note ? `${cmd(name).padEnd(wide)}     # ${note}` : cmd(name)}`;
  const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const out = [];
  groups.forEach((g, i) => {
    const n = g.members.length;
    if (i) out.push(`RUN, after the block above (fences overlap on ${g.on}):`);
    else out.push(n === 1 ? 'RUN, one prompt:' : `RUN, ${WORDS[n - 1] || n} prompts, fences disjoint, launch together:`);
    for (const m of g.members) out.push(line(m.name));
  });
  if (held.length) {
    out.push('HELD, not now:');
    for (const [name, why] of held) out.push(line(name, why));
  }
  return out;
}

function launchCommand(args) {
  const { rows, results, prompts, store } = boardData(args);
  console.log(launchBlock(rows, results, prompts, store).join('\n'));
  return 0;
}

function deltaCommand(args) {
  const { rows, store } = boardData(args);
  if (!fs.existsSync(store.dir)) {
    console.error(`delta: no ${path.relative(path.resolve(args.cwd || process.cwd()), store.dir)}/: run lane.mjs init first`);
    return 1;
  }
  const file = path.join(store.dir, BOARD_FILE);
  let prev = null;
  try {
    prev = fs.readFileSync(file, 'utf8').split('\n').slice(1).filter(Boolean);
  } catch {}
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  writeAtomic(file, `board ${path.basename(path.resolve(args.cwd || process.cwd()))} ${date} ${time}\n${rows.join('\n')}\n`);
  for (const r of rows) if (r.startsWith('BAD')) console.log(r);
  console.log(deltaLine(prev, rows, time, { fold: args.all ? 0 : MINE_KEEP }));
  return 0;
}

const USAGE = [
  'usage: lane.mjs init [--cwd DIR] | init --hook       init prints last the line that defines L',
  '       lane.mjs prompt <name> --kind K [--effort E] [--gate] [--runner] [--force] [--from FILE] [--ask T] [--why T] [--done T] [--fences T] [--pointers T]',
  '       lane.mjs sync [--all] [--cwd DIR]',
  '       lane.mjs who [<lane>] [--all] [--cwd DIR]',
  '       lane.mjs relay <lane> <text…> [--cwd DIR]',
  '       lane.mjs did <effort> <what…> [--cwd DIR]',
  '       lane.mjs set <id|name> <key> <value…> [--cwd DIR]',
  '       lane.mjs snooze <id|name> <N>d [why…] [--cwd DIR]',
  '       lane.mjs scout <effort> [--cwd DIR]',
  '       lane.mjs delta [--cwd DIR]',
  '       lane.mjs board [--all] [--cwd DIR] [--json]',
  '       lane.mjs resume [--cwd DIR]',
  '       lane.mjs check [--cwd DIR]',
  '       lane.mjs live [--all] [--cwd DIR]',
  '       lane.mjs launch [--cwd DIR]',
  '       lane.mjs ok <name> <evidence…> [--cwd DIR]',
  '       lane.mjs retire <name> <why…> [--cwd DIR]',
  '       lane.mjs watch [--cwd DIR] [--poll MS] [--notify FILE] [--gh-poll MS]',
  '       lane.mjs status <name> [--cwd DIR] [--json]        exit 3: the lane has no report yet',
  '       lane.mjs show <id|lane> [--cwd DIR]',
  '       lane.mjs new KIND [name] <headline…> | --head-file FILE [--body-file FILE] [--after "a b"] [--blocks "x"] [--until "ok x"] [--on "issue N"] [--size S] [--path "…"] [--source S] [--body T]',
  '       lane.mjs file <id> [--cwd DIR]',
  '       lane.mjs ctx [--session ID]                     prints nothing until the session has a transcript with usage',
  'every command but ctx takes --cwd DIR (default: the current directory) and --store DIR (default: <cwd>/coordinator)',
].join('\n');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._[0] === 'help' || args._[0] === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (args.cwd !== undefined) {
    try {
      args.cwd = fs.realpathSync(args.cwd);
      if (!fs.statSync(args.cwd).isDirectory()) throw new Error();
    } catch {
      console.error(`lane: --cwd ${args.cwd}: not a directory`);
      return 1;
    }
  }
  switch (args._[0]) {
    case 'init':
      return initCommand(args);
    case 'prompt':
      return promptCommand(args);
    case 'sync':
      return syncCommand(args);
    case 'who':
      return whoCommand(args);
    case 'relay':
      return relayCommand(args);
    case 'did':
      return didCommand(args);
    case 'set':
      return setCommand(args);
    case 'snooze':
      return snoozeCommand(args);
    case 'scout':
      return scoutCommand(args);
    case 'delta':
      return deltaCommand(args);
    case 'live':
      return liveCommand(args);
    case 'launch':
      return launchCommand(args);
    case 'ok':
      return okCommand(args);
    case 'retire':
      return retireCommand(args);
    case 'watch':
      return watchCommand(args);
    case 'board':
      return boardCommand(args);
    case 'resume':
      return resumeCommand(args);
    case 'check':
      return checkCommand(args);
    case 'status':
      return statusCommand(args);
    case 'show':
      return showCommand(args);
    case 'new':
      return newCommand(args);
    case 'file':
      return fileCommand(args);
    case 'ctx':
      return ctxCommand(args);
    default:
      console.error(USAGE);
      return 1;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    console.error(`lane: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
