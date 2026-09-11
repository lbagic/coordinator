import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { exited, launchBlock, EXIT_GRACE_MS, promptField, promptFaults, buildPrompt, deltaLine, latestTime, GOALS_TEMPLATE, analyze, findPrompt, nameOf, ctxTokens, windowFromModel, modelFromArgv, argsRe, render, newer, parseBoardLines, parseItem, foldStore, readStore, boardRows, nextId, mintItem, slugOf, isCoordinatorSession, question, askLine, boardData, labelFaults, parseNotify, NotifyTail, renderNotify, parseGithub, githubLine, reportPr, effortFaults, parseFields, protocolOf, setHeaderKey, scoutPrompt, HOOK_JSON, githubRefs, syncGithub, whoRows, relayText, FIELD_MAX, LANE_KINDS, fenceTokens, fenceOverlap, launchLane, peerText, gateStop, handoffDue, HANDOFF_AT, isLive, okNames, liveRow, shorthandLine, worktreeFacts, resumeRows, lastReportSection, lastDatedLine, foldMine, MINE_KEEP, settle, activeAt, fenceClaims } from './lane.mjs';

process.env.TZ = 'UTC';

const NAME = 'commit-when-green';
const PROMPT = `TASK ${NAME}\nYou commit when CI is green.\nWrite scope: none.\n\nYour last message is the REPORT block.`;

let n = 0;
const rec = (type, content, extra = {}) => ({ type, sessionId: 's1', timestamp: `2026-09-05T00:00:${String(n++).padStart(2, '0')}Z`, message: { content }, ...extra });
const user = (text, extra = {}) => rec('user', text, extra);
const human = (text, extra = {}) => user(text, { origin: { kind: 'human' }, ...extra });
const toolResult = (text) => rec('user', [{ type: 'tool_result', tool_use_id: 'x', content: text }]);
const assistant = (text, stop = 'tool_use', extra = {}) => ({ ...rec('assistant', [{ type: 'text', text }], extra), message: { content: [{ type: 'text', text }], stop_reason: stop } });
const write = (text) => rec('assistant', [{ type: 'tool_use', name: 'Write', input: { file_path: `prompt-${NAME}.txt`, content: text } }]);
const slash = (args) => human(`<command-message>do</command-message>\n<command-name>/do</command-name>\n<command-args>${args}</command-args>`);

// store fixtures
const item = (file, text) => ({ file, text });
const store = (files, lanesText = '', closed = [], githubText = '') => foldStore(files, lanesText, closed, githubText);
const T = (hm, day = '2026-09-05') => `${day}T${hm}:00Z`;
const NOW = Date.parse('2026-09-05T08:00:00Z');
const lane = (name, status, extra = {}) => ({ name, status, session: `${name}-session-id`, peer: null, session_open: false, mtime: NOW - 5000, ...extra });
const rows = (results, st, opts = {}) => boardRows(results, st, { now: NOW, ...opts });
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Subprocess tests run with an empty home so the real session registry, transcripts and settings never leak in.
const HERMETIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-home-'));
const HERMETIC = { ...process.env, HOME: HERMETIC_HOME, CLAUDE_CODE_SESSION_ID: '' };
after(() => fs.rmSync(HERMETIC_HOME, { recursive: true, force: true }));

test('name is the basename between prompt- and .txt', () => {
  assert.equal(nameOf('/repo/prompt-docs-apply.txt'), 'docs-apply');
  assert.equal(nameOf('coordinator-handoff.txt'), null);
  assert.equal(nameOf('prompt-.txt'), null);
});

test('a pasted prompt adopts; the writer, a cat, a notification, a peer, a skill expansion, a sidechain never do', () => {
  assert.equal(findPrompt([human(PROMPT)], NAME), 0);
  assert.equal(findPrompt([user(PROMPT)], NAME), 0);
  assert.equal(findPrompt([write(PROMPT), assistant('written')], NAME), -1);
  assert.equal(findPrompt([toolResult(PROMPT)], NAME), -1);
  assert.equal(findPrompt([user(PROMPT, { origin: { kind: 'task-notification' } })], NAME), -1);
  assert.equal(findPrompt([user(PROMPT, { origin: { kind: 'peer' } })], NAME), -1);
  assert.equal(findPrompt([user(PROMPT, { isMeta: true })], NAME), -1);
  assert.equal(findPrompt([user(PROMPT, { isSidechain: true })], NAME), -1);
});

// The record shape is the relay of 2026-09-10T00:19:32Z into session 7d82b90f:
// a `user` record with isMeta, origin.kind 'peer', the body in origin.body and
// wrapped in the <cross-session-message> text the session reads.
const peer = (body) => user(
  `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/35179.sock" from-name="nightshift-f0" from-mode="prompting">\n${body}\n</cross-session-message>\n\nThis came from another Claude session.`,
  { isMeta: true, origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/35179.sock', name: 'nightshift-f0', body } },
);

test('a peer message adopts through the argv launch line and nothing else; one for another lane ends the span', () => {
  const launch = `claude -n ${NAME} "$(cat coordinator/prompt-${NAME}.txt)"`;
  assert.equal(launchLane(launch), NAME);
  assert.equal(findPrompt([peer(launch)], NAME), 0);
  assert.equal(findPrompt([peer(`claude -n ${NAME} "$(cat prompt-${NAME}.txt)"`)], NAME), 0, 'the bare-path form');
  assert.equal(findPrompt([peer(`RUN, one prompt:\n  ${launch}\n`)], NAME), 0, 'inside the launch block');
  assert.equal(findPrompt([user(`x\n${launch}\n`, { isMeta: true, origin: { kind: 'peer' } })], NAME), 0, 'no origin.body: the wrapped text');
  assert.equal(findPrompt([peer(`TO ${NAME}\nRULED 02:19 by the user: build`)], NAME), -1, 'a relay is talk');
  assert.equal(findPrompt([peer(PROMPT)], NAME), -1, 'the prompt text pasted by a peer');
  assert.equal(findPrompt([peer(`follow prompt-${NAME}.txt`), toolResult(PROMPT)], NAME), -1, 'the file named without the launch line');
  assert.equal(findPrompt([peer(`claude -n other "$(cat coordinator/prompt-${NAME}.txt)"`)], NAME), -1, 'the two names must agree');
  assert.equal(findPrompt([peer(`claude -n ${NAME} "$(cat coordinator/prompt-other.txt)"`)], NAME), -1);
  assert.equal(findPrompt([peer(launch), human(`TASK ${NAME}\nbody`)], NAME), 1, 'the last adopting record still wins');
  assert.equal(peerText(human(launch)), '', 'a typed message is not a peer message');
  const closes = assistant(`REPORT ${NAME}\nwhat: done`, 'end_turn');
  assert.equal(analyze([human(PROMPT), closes], NAME).status, 'finished');
  assert.equal(analyze([human(PROMPT), peer(`claude -n other-lane "$(cat coordinator/prompt-other-lane.txt)"`), closes], NAME).status, 'in_progress', 'handed to another lane');
  assert.equal(analyze([human(PROMPT), peer(`TO ${NAME}\nbuild`), closes], NAME).status, 'finished', 'a relay does not end it');
});

test('a prompt pasted as a slash command argument adopts', () => {
  assert.equal(findPrompt([slash(PROMPT)], NAME), 0);
  assert.equal(findPrompt([slash(`TASK probe-${NAME}\nbody`)], NAME), -1);
});

test('a slash invocation adopts only once the session has read the file', () => {
  assert.equal(findPrompt([slash(`prompt-${NAME}.txt`)], NAME), -1);
  assert.equal(findPrompt([slash(`prompt-${NAME}.txt`), toolResult(PROMPT)], NAME), 0);
  assert.equal(findPrompt([slash(`run prompt-${NAME}.txt now`), assistant('reading'), toolResult(PROMPT)], NAME), 0);
});

test('a bare typed message naming the prompt file adopts once the session has read it', () => {
  assert.equal(findPrompt([human(`follow prompt-${NAME}.txt`)], NAME), -1);
  assert.equal(findPrompt([human(`follow prompt-${NAME}.txt`), toolResult(PROMPT)], NAME), 0);
  assert.equal(findPrompt([human(`follow prompt-${NAME}.txt`), assistant('reading'), toolResult(PROMPT)], NAME), 0);
  assert.equal(findPrompt([human(`follow prompt-probe-${NAME}.txt`), toolResult(PROMPT)], NAME), -1);
  assert.equal(findPrompt([human(`follow prompt-${NAME}.txt.bak`), toolResult(PROMPT)], NAME), -1);
  assert.equal(findPrompt([human(`follow prompt-${NAME}.txt.`), toolResult(PROMPT)], NAME), 0);
  assert.equal(argsRe(NAME).test(`prompt-${NAME}.txt.bak`), false);
  assert.equal(argsRe(NAME).test(`prompt-${NAME}.txt.`), true);
});

test('a bare typed message naming another prompt file ends the lane, like a slash invocation', () => {
  const closes = assistant(`REPORT ${NAME}\nwhat: done`, 'end_turn');
  assert.equal(analyze([human(PROMPT), closes], NAME).status, 'finished');
  assert.equal(analyze([human(PROMPT), human('now follow prompt-other-lane.txt'), closes], NAME).status, 'in_progress');
  assert.equal(analyze([human(PROMPT), human(`re-read prompt-${NAME}.txt`), closes], NAME).status, 'finished');
});

test('the notify log parses one JSON object per line and skips what it cannot read', () => {
  const good = '{"at":"2026-09-08T16:51:08Z","session_id":"abcdef0123","cwd":"/repo","message":"Claude needs your permission to use Bash"}';
  assert.deepEqual(parseNotify(`${good}\n`).map((n) => n.session_id), ['abcdef0123']);
  assert.deepEqual(parseNotify(`\n${good}\nnot json\n{"a":1}\n[]\n`).length, 1);
  assert.deepEqual(parseNotify(''), []);
});

test('a notify line names its lane when one holds the session, else its directory', () => {
  const n = { at: '2026-09-08T16:51:08Z', session_id: 'abcdef0123456', cwd: '/w/nightshift', message: 'needs\n  permission' };
  assert.equal(renderNotify(n, 'red-conflict-pick'), 'red-conflict-pick: notify  session abcdef01  2026-09-08 16:51:08  needs permission');
  assert.equal(renderNotify(n, null), 'nightshift: notify  session abcdef01  2026-09-08 16:51:08  needs permission');
  assert.equal(renderNotify({ cwd: '/w/nightshift' }, null), 'nightshift: notify  session ?  ?  wants the user');
  const asked = { status: 'stopped', asked: true, ask: `Which branch should I rebase onto, ${'main '.repeat(40)}?`, tail: 'long tail' };
  const line = renderNotify(n, 'red-conflict-pick', asked);
  assert.ok(line.startsWith('red-conflict-pick: notify  session abcdef01  2026-09-08 16:51:08  needs permission  asked: Which branch should I rebase onto, main'), line);
  assert.ok(line.endsWith('…') && line.length === 'red-conflict-pick: notify  session abcdef01  2026-09-08 16:51:08  needs permission  asked: '.length + 120, 'the ask is capped');
  assert.equal(renderNotify(n, 'red-conflict-pick', { status: 'stopped', asked: false, ask: 'Suite running.', tail: 'Pushed 4 commits.\nSuite running.' }), 'red-conflict-pick: notify  session abcdef01  2026-09-08 16:51:08  needs permission  said: Pushed 4 commits. Suite running.', 'a lane that asked nothing carries its tail');
  assert.equal(renderNotify(n, 'red-conflict-pick', { status: 'in_progress' }), 'red-conflict-pick: notify  session abcdef01  2026-09-08 16:51:08  needs permission', 'nothing to add mid-turn');
  assert.equal(renderNotify(n, null, null), 'nightshift: notify  session abcdef01  2026-09-08 16:51:08  needs permission', 'a session holding no lane is unchanged');
});

test('the notify tail arms on its first read, then returns only what was appended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
  const file = path.join(dir, 'lane-notify.log');
  const line = (id) => `{"at":"2026-09-08T16:51:08Z","session_id":"${id}","cwd":"/repo","message":"m"}\n`;
  const tail = new NotifyTail(file);

  assert.deepEqual(tail.read(), []);              // no file yet
  fs.writeFileSync(file, line('one'));
  assert.deepEqual(tail.read().map((n) => n.session_id), ['one']);
  assert.deepEqual(tail.read(), []);
  fs.appendFileSync(file, line('two') + line('three'));
  assert.deepEqual(tail.read().map((n) => n.session_id), ['two', 'three']);

  const half = '{"session_id":"four","cwd":"/repo"';
  fs.appendFileSync(file, half);
  assert.deepEqual(tail.read(), []);              // no newline: left for later
  fs.appendFileSync(file, ',"message":"m"}\n');
  assert.deepEqual(tail.read().map((n) => n.session_id), ['four']);

  fs.writeFileSync(file, line('five'));           // truncated: read from zero
  assert.deepEqual(tail.read().map((n) => n.session_id), ['five']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a notify tail armed on an existing log never replays its backlog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
  const file = path.join(dir, 'lane-notify.log');
  fs.writeFileSync(file, '{"session_id":"old","cwd":"/repo","message":"m"}\n');
  const tail = new NotifyTail(file);
  assert.deepEqual(tail.read(), []);
  fs.appendFileSync(file, '{"session_id":"new","cwd":"/repo","message":"m"}\n');
  assert.deepEqual(tail.read().map((n) => n.session_id), ['new']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lane names are matched whole, not as substrings', () => {
  assert.equal(argsRe(NAME).test(`<command-args>prompt-probe-${NAME}.txt</command-args>`), false);
  assert.equal(argsRe(NAME).test(`<command-args>prompt-${NAME}.txt.bak</command-args>`), false);
  assert.equal(findPrompt([human(`TASK probe-${NAME}\nbody`)], NAME), -1);
  assert.equal(findPrompt([human(`TASK ${NAME} extra\nbody`)], NAME), -1);
});

test('a session that ran /coordinator never adopts, even after reading the file', () => {
  const coord = human(`<command-name>/coordinator</command-name>\n<command-args>- prompt-${NAME}.txt running</command-args>`);
  assert.equal(isCoordinatorSession([coord]), true);
  assert.equal(findPrompt([coord, toolResult(PROMPT), assistant(`REPORT ${NAME}\nwhat: echoed`)], NAME), -1);
  assert.equal(isCoordinatorSession([human('<command-name>/coordinator-x</command-name>')]), false);
});

test('the last adopting record wins', () => {
  const recs = [human(PROMPT), assistant(`REPORT ${NAME}\nwhat: first run`, 'end_turn'), human(PROMPT), assistant('retrying')];
  assert.equal(findPrompt(recs, NAME), 2);
  assert.equal(analyze(recs, NAME).status, 'in_progress');
});

test('REPORT closes only as an exact line; the last block is the report, taken from its REPORT line', () => {
  const recs = [
    human(PROMPT),
    assistant(`I will end with REPORT ${NAME} as instructed.`),
    assistant('REPORT written (503 lines)'),
    assistant(`Done.\n  REPORT ${NAME}\nwhat: committed\ncommits: abc123 fix`, 'end_turn'),
  ];
  const r = analyze(recs, NAME);
  assert.equal(r.status, 'finished');
  assert.equal(r.report, `REPORT ${NAME}\nwhat: committed\ncommits: abc123 fix`);
  assert.equal(r.turn_index, r.close_index);
});

test('a turn that ends after the report is continued; a tool stop, a split response, a later REPORT, or another lane is not', () => {
  const recs = [human(PROMPT), assistant(`REPORT ${NAME}\nwhat: done`, 'end_turn'), human('thanks, one more thing'), assistant('sure', 'end_turn')];
  const r = analyze(recs, NAME);
  assert.equal(r.status, 'continued');
  assert.equal(r.close_index, 1);
  assert.equal(r.turn_index, 3);
  assert.equal(r.tail, 'sure');
  assert.match(render({ ...r, name: NAME, worker_ctx: '10K/1M' }), /^commit-when-green: continued  session s1  turn ended .* after report .*\n  --- last message ---\n  sure\n  ---$/);
  const working = analyze([...recs.slice(0, 3), assistant('on it', 'tool_use')], NAME);
  assert.equal(working.status, 'finished');
  assert.equal(working.turn_index, working.close_index);
  const split = analyze([...recs.slice(0, 2), assistant('Let me know if anything is unclear.', 'end_turn')], NAME);
  assert.equal(split.status, 'finished');
  const again = analyze([...recs, human('redo'), assistant(`REPORT ${NAME}\nwhat: v2`, 'end_turn')], NAME);
  assert.equal(again.status, 'finished');
  assert.equal(again.close_index, 5);
  assert.equal(again.report, `REPORT ${NAME}\nwhat: v2`);
  const other = analyze([...recs.slice(0, 2), human('TASK other-lane\nbody'), assistant('Which branch?', 'end_turn')], NAME);
  assert.equal(other.status, 'finished');
  const viaSlash = analyze([...recs.slice(0, 2), slash('prompt-other-lane.txt'), toolResult('TASK other-lane\nbody'), assistant('Which branch?', 'end_turn')], NAME);
  assert.equal(viaSlash.status, 'finished');
});

test('a tool result after the report is not a turn boundary; a peer message is', () => {
  const base = [human(PROMPT), assistant(`REPORT ${NAME}\nwhat: done`, 'end_turn')];
  const hooked = analyze([...base, toolResult('hook output'), assistant('noted', 'end_turn')], NAME);
  assert.equal(hooked.status, 'finished');
  assert.equal(hooked.turn_index, hooked.close_index);
  assert.equal(analyze([...base, user('a peer says hi', { origin: { kind: 'peer' } }), assistant('ok', 'end_turn')], NAME).status, 'continued');
});

test('the ask line is the last question outside a code fence, read from the whole message', () => {
  assert.equal(question('```\nselect 1?\n```\nDone.'), null);
  assert.equal(askLine('```\nselect 1?\n```\nDone.'), 'Done.');
  assert.equal(askLine('```\ncode\n```'), '');
  const fenced = analyze([human(PROMPT), assistant('```\nselect 1?\n```\nDone.', 'end_turn')], NAME);
  assert.equal(fenced.status, 'stopped');
  assert.equal(fenced.asked, false);
  assert.equal(fenced.ask, 'Done.');
  const long = analyze([human(PROMPT), assistant(`\`\`\`\n${'x'.repeat(700)}\n\`\`\`\nWhich of these should I keep?`, 'end_turn')], NAME);
  assert.equal(long.asked, true);
  assert.equal(long.ask, 'Which of these should I keep?');
  const capped = analyze([human(PROMPT), assistant(`${'x'.repeat(200)}?`, 'end_turn')], NAME);
  assert.equal(capped.ask, `${'x'.repeat(119)}…`);
  const chat = analyze([human(PROMPT), assistant(`REPORT ${NAME}\nwhat: done`, 'end_turn'), human('more'), assistant('I also fixed lint.', 'end_turn')], NAME);
  assert.equal(chat.status, 'continued');
  assert.equal(chat.asked, false);
  assert.equal(chat.ask, 'I also fixed lint.');
});

test('between two adopting transcripts the later prompt wins; on a tie the newer file', () => {
  const at = (prompt_at, mtime) => ({ prompt_at, mtime });
  assert.equal(newer(at('2026-09-05T01:00:00Z', 1), at('2026-09-05T00:00:00Z', 9)), true);
  assert.equal(newer(at('2026-09-05T00:00:00Z', 9), at('2026-09-05T01:00:00Z', 1)), false);
  assert.equal(newer(at('2026-09-05T00:00:00Z', 9), at('2026-09-05T00:00:00Z', 1)), true);
  assert.equal(newer(at('2026-09-05T00:00:00Z', 1), at('2026-09-05T00:00:00Z', 9)), false);
});

// ---------- the store ----------

test('lanes.txt lines: tag first and normalised; OK and RUN name a lane; anything else does not; an indented line continues the one above', () => {
  const lines = parseBoardLines('ok: 09-a 07:10 4f2a1c\n  and more\nRUN perf do\nHOLD r13 until Stop is pressed\n\nOK\n');
  assert.deepEqual(
    lines.map((l) => [l.tag, l.name, l.rest]),
    [
      ['OK', '09-a', '07:10 4f2a1c and more'],
      ['RUN', 'perf', 'do'],
      ['HOLD', null, 'r13 until Stop is pressed'],
      ['OK', null, ''],
    ],
  );
});

test('an item is its filename id, line-1 kind and headline, header keys, then a body the board never reads', () => {
  const it = parseItem('12-attach-self-check.md', 'LANE attach-self-check F-S5 (a): one attach per worker\nafter: gate-amendments scratch-write-grant\nsource: F-S5\n\nbody\nmore body\n');
  assert.deepEqual([it.id, it.kind, it.name, it.head, it.after, it.source, it.body], [12, 'LANE', 'attach-self-check', 'F-S5 (a): one attach per worker', ['gate-amendments', 'scratch-write-grant'], 'F-S5', 'body\nmore body']);
  assert.deepEqual(it.bad, []);
  const plain = parseItem('/repo/coordinator/8-q.md', 'DECIDE ship it?\nblocks: x y\n');
  assert.deepEqual([plain.id, plain.name, plain.head, plain.blocks, plain.body], [8, null, 'ship it?', ['x', 'y'], '']);
  assert.match(parseItem('notes.md', 'NOTE n\n').bad[0], /not <id>-<slug>\.md/);
});

test('a header line that is not a known key is a fault, never prose; the body starts at the first blank line', () => {
  assert.match(parseItem('21-x.md', 'NOTE n\nblock: y\n\nbody').bad[0], /#21 header line not a known key: 'block: y'/);
  const noBlank = parseItem('21-x.md', 'NOTE n\nfirst body line without a blank\n');
  assert.match(noBlank.bad[0], /not a known key/);
  assert.equal(noBlank.body, '');
});

test('until: is `ok <lane>`, `prompt <lane>`, `merged <n>` or `closed <n>`; anything else is a fault', () => {
  assert.deepEqual(parseItem('1-a.md', 'NOTE n\nuntil: ok docs-apply-r51\n').until, { kind: 'ok', lane: 'docs-apply-r51' });
  assert.deepEqual(parseItem('1-a.md', 'NOTE n\nuntil:  prompt   x\n').until, { kind: 'prompt', lane: 'x' });
  assert.deepEqual(parseItem('1-a.md', 'STEP n\nuntil: merged #10667\n').until, { kind: 'merged', n: 10667 });
  assert.deepEqual(parseItem('1-a.md', 'NOTE n\nuntil: closed 10649\n').until, { kind: 'closed', n: 10649 });
  assert.match(parseItem('1-a.md', 'NOTE n\nuntil: when it reports\n').bad[0], /#1 until: 'when it reports' is not 'ok <lane>', 'prompt <lane>', 'merged <n>' or 'closed <n>'/);
});

test('an EFFORT carries size, path, lanes and on; each is checked; no other kind carries size, path or lanes', () => {
  const it = parseItem('16-slot.md', 'EFFORT slot-key M slot key naming\nsize: M\npath: research implement\nlanes: research=r14 implement=r14-wire\non: issue 14\n\ncard\n');
  assert.deepEqual(it.bad, []);
  assert.equal(it.name, 'slot-key');
  assert.equal(it.head, 'M slot key naming');
  assert.equal(it.size, 'M');
  assert.deepEqual(it.path, ['research', 'implement']);
  assert.deepEqual(it.lanes, { research: 'r14', implement: 'r14-wire' });
  assert.deepEqual(it.on, { type: 'issue', n: 14 });
  assert.deepEqual(parseItem('1-a.md', 'STEP merge it\non: pr #12\n').on, { type: 'pr', n: 12 });
  const bad = parseItem('26-x.md', 'EFFORT x an effort\nsize: XL\npath: research build\nlanes: prototype=p implement-x\non: ticket 5\n').bad;
  for (const re of [/size: 'XL' is not S, M or L/, /path names 'build'/, /lanes: 'implement-x' is not <kind>=<lane>/, /on: 'ticket 5' is not 'pr <n>' or 'issue <n>'/, /lanes: prototype is not on the path/]) assert.ok(bad.some((b) => re.test(b)), String(re));
  assert.match(parseItem('27-n.md', 'NOTE a note\nsize: S\n').bad[0], /size: only an EFFORT carries it/);
  assert.match(parseItem('28-n.md', 'EFFORT\n').bad[0], /#28 no name/);
});

test('github.txt is one line per number, pr|issue <n> STATE [time] [title]; a line that is not is a fault, never a state', () => {
  const g = parseGithub('pr 10667 MERGED 2026-09-09T05:34:29Z feat(web): show it\nissue 14 OPEN\n\nissue 15 CLOSED 2026-09-08T10:00:00Z\npr 12 DONE\nnonsense\n');
  assert.deepEqual([...g.states.keys()], [10667, 14, 15]);
  assert.deepEqual(g.states.get(10667), { type: 'pr', n: 10667, state: 'MERGED', at: '2026-09-09T05:34:29Z', title: 'feat(web): show it' });
  assert.deepEqual(g.states.get(14), { type: 'issue', n: 14, state: 'OPEN', at: null, title: '' });
  assert.deepEqual(g.bad, ['pr 12 DONE', 'nonsense']);
  assert.equal(githubLine(g.states.get(10667)), 'pr 10667 MERGED 2026-09-09T05:34:29Z feat(web): show it');
  assert.equal(githubLine(g.states.get(14)), 'issue 14 OPEN');
  assert.deepEqual(parseGithub('issue 14 OPEN slot key naming\n').states.get(14), { type: 'issue', n: 14, state: 'OPEN', at: null, title: 'slot key naming' }, 'a title never reads as a time');
  const st = store([item('1-n.md', 'NOTE n\n')], '', [], 'pr 12 DONE\n');
  assert.equal(rows([], st)[0], "BAD     github.txt: 'pr 12 DONE' is not pr|issue <n> OPEN|CLOSED|MERGED <time> <title>");
});

test('a draft label that starts like one of the five but is not it is refused, so no text folds into the field above', () => {
  assert.deepEqual(labelFaults('# draft\n\nAsk: a\nWhy: b\nDone when: c\nFence: d\nPointer: e\n'), ["--from: 'Why:' is not 'Why now:'", "--from: 'Fence:' is not 'Fences:'", "--from: 'Pointer:' is not 'Pointers:'"]);
  assert.deepEqual(labelFaults('Ask: a\nWhy now: b\nDone when: c\nFences: d\nPointers: e\nNote: fine\nAsk the team: not a label\n'), []);
  assert.deepEqual(labelFaults('## Ask\na\n## Why\nb\n### Done\nc\n## Fences\nd\n## Notes\n## Ask the team\n'), ["--from: '## Why' is not '## Why now'", "--from: '### Done' is not '### Done when'"], 'the heading spelling of a near miss is refused too');
});

test('the pr: line of a report names the PR by url or number, or none', () => {
  assert.equal(reportPr('REPORT x\nwhat: y\npr: https://github.com/o/r/pull/10717\nchecks: ok'), 10717);
  assert.equal(reportPr('REPORT x\npr: PR #42 open'), 42);
  assert.equal(reportPr('REPORT x\npr: none'), null);
  assert.equal(reportPr('REPORT x\nwhat: no pr line'), null);
});

test('an EFFORT row is its next act: scout, rule, write the next prompt, the lane state, the unmerged PR, the close-out; done goes to the file row', () => {
  const ef = (keys, extra = '') => item('9-ef.md', `EFFORT ef the effort\n${keys}\n${extra}`);
  const at = (results, files, lanes = '', gh = '') => rows(results, store(files, lanes, [], gh)).filter((r) => r.startsWith('EFFORT') || r.startsWith('MINE    file:'));
  assert.deepEqual(at([], [ef('source: user')]), ['EFFORT  ef  scoping: scout, then the card  #9']);
  assert.deepEqual(at([], [ef('size: M')]), ['EFFORT  ef M  rule the card  #9']);
  assert.deepEqual(at([], [ef('size: M\npath: research implement')]), ['EFFORT  ef M  write prompt research  #9']);
  const withLane = 'size: M\npath: research implement\nlanes: research=res';
  assert.deepEqual(at([lane('res', 'not_found')], [ef(withLane)]), ['EFFORT  ef M  res (research) run it  #9']);
  assert.deepEqual(at([lane('res', 'not_found')], [ef(withLane), item('3-h.md', 'STEP wait\nblocks: res\n')]), ['EFFORT  ef M  res (research) held: #3  #9']);
  assert.deepEqual(at([lane('res', 'in_progress', { prompt_at: T('08:00') })], [ef(withLane)]), ['EFFORT  ef M  res (research) live  #9']);
  assert.deepEqual(at([lane('res', 'stopped', { ask: 'which?', asked: true })], [ef(withLane)]), ['EFFORT  ef M  res (research) answer it  #9']);
  assert.deepEqual(at([lane('res', 'exited')], [ef(withLane)]), ['EFFORT  ef M  res (research) exited, re-issue  #9']);
  assert.deepEqual(at([lane('res', 'finished', { closed_at: T('08:10'), report: 'REPORT res\npr: none' })], [ef(withLane)]), ['EFFORT  ef M  res (research) verify  #9']);
  const done = lane('res', 'finished', { closed_at: T('08:10'), report: 'REPORT res\npr: none' });
  assert.deepEqual(at([done], [ef(withLane)], 'OK res 08:10 read'), ['EFFORT  ef M  write prompt implement  #9']);
  const both = `${withLane} implement=imp`;
  const imp = lane('imp', 'finished', { closed_at: T('09:00'), report: 'REPORT imp\npr: https://github.com/o/r/pull/12' });
  assert.deepEqual(at([done, imp], [ef(both)], 'OK res 08:10 read\nOK imp 09:00 abc'), ['EFFORT  ef M  imp (implement) PR #12 open, merge is yours  #9']);
  assert.deepEqual(at([done, imp], [ef(both)], 'OK res 08:10 read\nOK imp 09:00 abc', 'pr 12 CLOSED'), ['EFFORT  ef M  imp (implement) PR #12 closed, merge is yours  #9']);
  assert.deepEqual(at([done, imp], [ef(`${both}\non: issue 14`)], 'OK res 08:10 read\nOK imp 09:00 abc', 'pr 12 MERGED\nissue 14 OPEN'), ['EFFORT  ef M  close out #14: resolution comment, close, gist line  #9']);
  assert.deepEqual(at([done, imp], [ef(`${both}\non: issue 14`)], 'OK res 08:10 read\nOK imp 09:00 abc', 'pr 12 MERGED\nissue 14 CLOSED'), ['MINE    file: #9']);
  assert.deepEqual(at([done, imp], [ef(both)], 'OK res 08:10 read\nOK imp 09:00 abc', 'pr 12 MERGED'), ['MINE    file: #9']);
  const unknown = rows([], store([ef(withLane)]));
  assert.match(unknown[0], /#9 names unknown lane 'res'/, 'a lane the ledger does not know is a fault');
  assert.ok(unknown.includes('EFFORT  ef M  res (research) run it  #9'), 'and the row still prints beside it');
});

test('until: merged and until: closed, and on: without until:, close an item from github.txt; nothing known keeps it open', () => {
  const files = [item('1-m.md', 'STEP merge PR 12\nuntil: merged 12\n'), item('2-c.md', 'NOTE wait on 14\nuntil: closed 14\n'), item('3-o.md', 'STEP merge it\non: pr 12\n'), item('4-i.md', 'IDEA later\non: issue 15\n')];
  const open = (gh) => rows([], store(files, '', [], gh)).filter((r) => /^(STEP|MINE)/.test(r));
  assert.deepEqual(open(''), ['STEP    #1  merge PR 12', 'STEP    #3  merge it', 'MINE    #2  wait on 14  until: closed 14']);
  assert.deepEqual(open('pr 12 OPEN\nissue 14 OPEN\nissue 15 OPEN'), ['STEP    #1  merge PR 12', 'STEP    #3  merge it', 'MINE    #2  wait on 14  until: closed 14']);
  assert.deepEqual(open('pr 12 MERGED\nissue 14 CLOSED\nissue 15 CLOSED'), ['MINE    file: #1 #2 #3 #4']);
  assert.deepEqual(open('pr 12 CLOSED'), ['STEP    #1  merge PR 12', 'STEP    #3  merge it', 'MINE    #2  wait on 14  until: closed 14'], 'a closed PR is not merged');
});

test('a RUN row names the kind and the gate of its prompt beside the Done when', () => {
  const text = buildPrompt('x', { ask: 'a', done: 'rows show it' }, { kind: 'implement', gate: true });
  assert.deepEqual(rows([lane('x', 'not_found')], store([]), { prompts: new Map([['x', text]]) })[0], 'RUN     prompt-x.txt  implement gate  rows show it');
});

test('a prompt is five fields under 2000 characters, a Kind line, the kind\'s protocol, the address rule and the kind\'s REPORT keys; the refusals', () => {
  const fields = { ask: 'A teammate asked for requested vs capacity per node row, as a bar.', why: 'customers read the table daily', done: 'each row shows the bar', fences: 'web/ only; web/sentry.config.ts belongs to a live lane; branch from main', pointers: '#10600 docs/notes.md https://x.y/z' };
  const K = { kind: 'implement' };
  assert.deepEqual(promptFaults('cols', fields, new Set([21]), K), []);
  const text = buildPrompt('cols', { ...fields, ask: 'line one\n  line two' }, K);
  assert.equal(text.split('\n')[0], 'TASK cols');
  assert.equal(text.split('\n')[1], 'Kind: implement');
  assert.equal(promptField(text, 'Ask'), 'line one line two', 'a newline inside a field becomes a space');
  assert.equal(promptField(text, 'Kind'), 'implement');
  assert.equal(promptField(text, 'Pointers'), '#10600 docs/notes.md https://x.y/z');
  assert.equal(promptField(text, 'Nope'), '');
  assert.equal(promptField('TASK x\nFences: a/\n  b/\nDone when: y\n', 'Fences'), 'a/ b/', 'an indented line continues the field above');
  assert.match(text, /\nProtocol \(implement\): deliver the way the Fences say this repo works: a worktree and a PR .* or commits on main .* You never merge: that is the user's\. You push your own work and nothing else, by the route the Fences name: your branch and its PR, or your commits on main\. Commits and the PR are authored as the user: the repo git identity, no Co-Authored-By, no session or generated-with trailer, no AI attribution in messages or bodies\.\n/);
  assert.doesNotMatch(text, /never push/, 'one delivery rule: goals.md has the lane push, so the protocol never forbids it');
  assert.match(text, /Instructions for you arrive headed `TO cols`; one headed `TO` another name is not yours: say so and stop/);
  assert.match(text, /\nREPORT cols\nwhat: /);
  assert.match(text, /\npr: <url>, or none\n/);
  assert.match(text, /Pointers are leads to read, not facts/);
  assert.doesNotMatch(text, /Gate:|Ticket #|Effort:/);
  assert.equal(FIELD_MAX, 2000);
  assert.deepEqual(promptFaults('cols', { ...fields, ask: '', done: '' }, new Set(), K), ['Ask is empty', 'Done when is empty']);
  assert.deepEqual(promptFaults('cols', { ...fields, fences: 'see dakr/server/k8s.go:~1165' }, new Set(), K), ['Fences cites dakr/server/k8s.go:~1165: a plan, not intent']);
  assert.deepEqual(promptFaults('cols', { ...fields, ask: 'x'.repeat(2001) }, new Set(), K), ['Ask is 2001 characters; at most 2000']);
  assert.deepEqual(promptFaults('cols', { ...fields, ask: 'x'.repeat(1999) }, new Set(), K), []);
  assert.deepEqual(promptFaults('cols', { ...fields, pointers: '#21 #10600' }, new Set([21]), K), ["Pointers names item #21: an item is the coordinator's, never a worker's"]);
  assert.deepEqual(promptFaults('Cols_1', fields, new Set(), K), ["name 'Cols_1' is not lower-case letters, digits and dashes"]);
  assert.deepEqual(promptFaults('cols', fields, new Set(), {}), ["kind '' is not one of research scoping prototype implement alternative review map"]);
  assert.deepEqual(promptFaults('cols', fields, new Set(), { kind: 'build' }), ["kind 'build' is not one of research scoping prototype implement alternative review map"]);
  assert.deepEqual(promptFaults('cols', fields, new Set(), { kind: 'research', gate: true }), ['--gate belongs to an implement lane']);
  assert.deepEqual(promptFaults('cols', fields, new Set(), { kind: 'implement', runner: true }), ['--runner belongs to a research lane']);
});

test('every kind has a protocol and its own REPORT keys; the gate, the runner, the ticket and the effort print only when asked', () => {
  for (const kind of LANE_KINDS) {
    const t = buildPrompt('x', { ask: 'a', done: 'd' }, { kind });
    assert.match(t, new RegExp(`\\nProtocol \\(${kind}`), kind);
    assert.match(t, /TO x/, kind);
  }
  const keys = (kind) => buildPrompt('x', { ask: 'a', done: 'd' }, { kind }).split('REPORT x\n')[1].trim().split('\n').map((l) => l.split(':')[0]);
  assert.deepEqual(keys('research'), ['what', 'evidence', 'verdict', 'open']);
  assert.deepEqual(keys('scoping'), ['brief', 'decisions', 'open']);
  assert.deepEqual(keys('prototype'), ['commits', 'ruling', 'open']);
  assert.deepEqual(keys('implement'), ['what', 'commits', 'pr', 'checks', 'open']);
  assert.deepEqual(keys('alternative'), ['case', 'evidence', 'open']);
  assert.deepEqual(keys('review'), ['findings', 'verdict', 'open']);
  assert.deepEqual(keys('map'), ['map', 'tickets', 'open']);
  const gated = buildPrompt('cell', { ask: 'a', done: 'd' }, { kind: 'implement', gate: true, ticket: 10685, effort: 'cells' });
  assert.equal(gated.split('\n')[1], 'Kind: implement gate');
  assert.equal(gated.split('\n')[2], 'Effort: cells');
  assert.match(gated, /Ticket #10685: claim it first/);
  for (const built of [gated, buildPrompt('cell', { ask: 'a', done: 'd' }, { kind: 'implement' })]) {
    const protocol = built.split('\n').find((l) => l.startsWith('Protocol (implement)'));
    assert.ok(protocol.includes("You never merge: that is the user's. You push your own work and nothing else, by the route the Fences name") && protocol.includes('no AI attribution in messages or bodies.') && !/never push/.test(protocol), 'the delivery and authorship sentences reach the built prompt, gated or not');
  }
  assert.match(gated, /Gate: after the amendments, stop and wait\. Build only on a message headed `TO cell` that carries the word build\. Never ask for it through a question tool/);
  // The board reads that closing line, so the template dictates it.
  const sentence = 'Gated. Waiting for a message headed TO cell carrying the word build.';
  assert.ok(gated.includes(`End the report with the line "${sentence}" and nothing after it`), gated);
  assert.equal(gateStop(`REPORT cell\nwhat: recon\n\n${sentence}`), true);
  const runner = buildPrompt('probe', { ask: 'a', done: 'd' }, { kind: 'research', runner: true });
  assert.equal(runner.split('\n')[1], 'Kind: research runner');
  assert.match(runner, /Production reads go through a runner: .* the user runs it with ! in this session and tees the output to a file with no credentials in it/);
  assert.match(runner, /Two passes are normal/);
  assert.doesNotMatch(buildPrompt('probe', { ask: 'a', done: 'd' }, { kind: 'research' }), /runner/);
  assert.match(buildPrompt('r', { ask: 'a', done: 'd' }, { kind: 'research', ticket: 7 }), /Claim #7 first/);
  // The effort's issue outlives its first lane: the research leg of a
  // `research implement` path answers on the issue and leaves it open (issue 4
  // was closed by lineage-research on 2026-09-09 and reopened by hand).
  assert.match(buildPrompt('r', { ask: 'a', done: 'd' }, { kind: 'research', ticket: 4 }), /the answer is its resolution comment, then close it and add the gist line on its map\./);
  const later = buildPrompt('r', { ask: 'a', done: 'd' }, { kind: 'research', ticket: 4, later: true });
  assert.match(later, /the answer is its resolution comment and the gist line on its map\. Leave #4 open: a later lane of this effort closes it, not you\./);
  assert.doesNotMatch(later, /close it and add/);
  assert.doesNotMatch(buildPrompt('r', { ask: 'a', done: 'd' }, { kind: 'research', later: true }), /Leave/, 'no ticket, nothing to leave open');
  assert.match(buildPrompt('f', { ask: 'a', done: 'd' }, { kind: 'implement', force: true }).split('\n')[1], /^Kind: implement forced$/);
  assert.equal(protocolOf('x', { kind: 'nope' }), '');
  const plain = buildPrompt('old', { ask: 'a', done: 'd' });
  assert.doesNotMatch(plain, /Kind:|Protocol/, 'no kind: a prompt without a Kind line, still readable');
});

test('a prompt against its effort: the kind must be on the path, an S effort has no gate, an M implement needs one, a kind is not written twice; --force overrides', () => {
  const ef = parseItem('9-ef.md', 'EFFORT ef x\nsize: M\npath: research implement\nlanes: research=res\n');
  assert.deepEqual(effortFaults(null, { kind: 'implement' }), ['no open EFFORT item of that name']);
  assert.deepEqual(effortFaults(ef, { kind: 'implement', gate: true }), []);
  assert.deepEqual(effortFaults(ef, { kind: 'implement' }), ["an M effort's implement lane needs --gate (claim, verify, amendments, stop for build); --force to skip it"]);
  assert.deepEqual(effortFaults(ef, { kind: 'implement', force: true }), []);
  assert.deepEqual(effortFaults(ef, { kind: 'prototype' }), ['kind prototype is not on the path of ef (research implement); --force to write it anyway']);
  assert.deepEqual(effortFaults(ef, { kind: 'research' }), ['ef already has a research lane: res; retire it or --force']);
  const small = parseItem('9-ef.md', 'EFFORT ef x\nsize: S\npath: implement\n');
  assert.deepEqual(effortFaults(small, { kind: 'implement', gate: true }), ['an S effort has no gate: it goes straight to the PR']);
  assert.deepEqual(effortFaults(small, { kind: 'implement' }), []);
  assert.deepEqual(effortFaults(parseItem('9-ef.md', 'EFFORT ef x\nsize: M\n'), { kind: 'research' }), ['effort ef has no path: rule the card first (L set ef path "…")']);
});

test('fields read from a draft file: a label starts a field, following lines continue it to a blank line, text before the first label is ignored', () => {
  const f = parseFields('# draft\n\nAsk: do the thing\n  across two lines\nWhy now: because\n\nDone when: it is done\nFences: web/ only\nPointers: #1\n\ntrailing notes\n');
  assert.deepEqual(f, { ask: 'do the thing across two lines', why: 'because', done: 'it is done', fences: 'web/ only', pointers: '#1' });
  assert.deepEqual(parseFields('done when: lower case label works\n'), { done: 'lower case label works' });
  assert.deepEqual(parseFields('Nope: not a field\n'), {});
  const headings = parseFields('# draft\n\n## Ask\n\ndo the thing\n  across two lines\n\n## Why now:\nbecause\n\n### Done when\nit is done\n\n## Fences\n\nweb/ only\n\n## Pointers\n#1\n\n## Notes\ntrailing notes\n');
  assert.deepEqual(headings, f, 'a headings draft parses to the same five fields as the label draft');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-from-'));
  fs.mkdirSync(path.join(cwd, 'coordinator'));
  fs.writeFileSync(path.join(cwd, 'draft.md'), 'Lane cells-render\n\nThe ask: render the cells\n');
  const refused = spawnSync(process.execPath, [path.join(HERE, 'lane.mjs'), 'prompt', 'cells', '--kind', 'implement', '--from', 'draft.md', '--cwd', cwd], { encoding: 'utf8', env: HERMETIC });
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.trim(), "prompt: --from draft.md holds no field: its first line is 'Lane cells-render', where a field was expected as 'Ask: …' or '## Ask'", 'one refusal naming the shape, not three empty fields');
  fs.writeFileSync(path.join(cwd, 'draft.md'), '## Ask\nrender the cells\n\n## Done when\nthe grid shows them\n\n## Fences\nweb/ only\n');
  const ok = spawnSync(process.execPath, [path.join(HERE, 'lane.mjs'), 'prompt', 'cells', '--kind', 'implement', '--from', 'draft.md', '--cwd', cwd], { encoding: 'utf8', env: HERMETIC });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(promptField(fs.readFileSync(path.join(cwd, 'coordinator', 'prompt-cells.txt'), 'utf8'), 'Done when'), 'the grid shows them');
  fs.rmSync(cwd, { recursive: true });
});

test('setHeaderKey replaces a key in the header or adds it before the first blank line; the body is untouched', () => {
  assert.equal(setHeaderKey('EFFORT e x\nsize: S\n\nbody: not a key\n', 'size', 'M'), 'EFFORT e x\nsize: M\n\nbody: not a key\n');
  assert.equal(setHeaderKey('EFFORT e x\nsize: S\n\nbody\n', 'path', 'research implement'), 'EFFORT e x\nsize: S\npath: research implement\n\nbody\n');
  assert.equal(setHeaderKey('EFFORT e x\n', 'size', ' L '), 'EFFORT e x\nsize: L\n');
  assert.equal(setHeaderKey('EFFORT e x', 'size', 'L'), 'EFFORT e x\nsize: L');
});

test('the scout prompt carries the repo, the effort, its body and the card shape; the hook JSON is one object', () => {
  const p = scoutPrompt('/repo', parseItem('9-ef.md', 'EFFORT ef fix the legend\n\nuser words here\n'));
  assert.match(p, /^Read-only; edit nothing\. Repo \/repo\. Effort ef: fix the legend\n\nuser words here\n\nAnswer in at most 250 words as a scope card\. Size: S/);
  assert.match(p, /Path: the lane kinds in order, from research, scoping, prototype, implement, alternative, review, map/);
  assert.doesNotThrow(() => JSON.parse(HOOK_JSON));
});

test('githubRefs names every number an open item or a reported lane points at; syncGithub asks only for what is not terminal, keeps a line gh cannot refresh, prunes what nothing names, and says what moved', () => {
  const st = store([item('1-s.md', 'STEP merge\nuntil: merged 12\n'), item('2-e.md', 'EFFORT e x\non: issue 14\n'), item('3-n.md', 'NOTE n\nuntil: closed 15\n'), item('4-l.md', 'LANE done-lane\n')], 'OK done-lane 08:00 x', [], 'pr 12 OPEN\nissue 14 OPEN\nissue 99 CLOSED old title\npr 7 MERGED');
  const results = [lane('imp', 'finished', { closed_at: T('09:00'), report: 'REPORT imp\npr: https://github.com/o/r/pull/7' }), lane('none', 'finished', { closed_at: T('09:00'), report: 'REPORT none\npr: none' })];
  assert.deepEqual([...githubRefs(st, results)], [[12, 'pr'], [14, 'issue'], [15, 'issue'], [7, 'pr']]);
  assert.deepEqual([...githubRefs(st, results, (it) => it.file === '1-s.md')], [[14, 'issue'], [15, 'issue'], [7, 'pr']], 'a satisfied item is not asked about');
  const asked = [];
  const lookup = (n) => {
    asked.push(n);
    if (n === 15) throw new Error('gh: not found');
    return { type: n === 12 || n === 7 ? 'pr' : 'issue', n, state: n === 12 || n === 7 ? 'MERGED' : 'OPEN', at: n === 12 ? '2026-09-09T05:34:29Z' : null, title: `t${n}` };
  };
  const out = syncGithub('/repo', st, results, { lookup });
  assert.deepEqual(asked, [12, 14, 15], 'the merged PR 7 is terminal and not asked again; 15 failed');
  assert.deepEqual(out.lines, ['pr 7 MERGED', 'pr 12 MERGED 2026-09-09T05:34:29Z t12', 'issue 14 OPEN t14']);
  assert.deepEqual(out.changed, ['#12: open -> merged (pr) t12', '#15: no answer from gh (issue)']);
  assert.deepEqual(out.failed, [15]);
  assert.deepEqual(syncGithub('/repo', st, results, { lookup, all: true }).changed.filter((c) => c.startsWith('#7')), [], 'a re-asked terminal number that did not move prints nothing');
  assert.equal(asked.filter((n) => n === 7).length, 1, '--all asks the terminal number too');
});

test('who: one row per launched lane with the session name, the tty, the registry status, the idle time and the cwd; a lane whose process is gone says so', () => {
  const registry = [{ sessionId: 'a-session-id', pid: 11, name: 'services-cd', status: 'idle', cwd: `${os.homedir()}/repo` }, { sessionId: 'b-session-id', name: 'services-3a', status: 'busy', cwd: '/x' }];
  const results = [lane('a', 'in_progress', { peer: 'services-cd', mtime: NOW, active: NOW - 90000 }), lane('b', 'stopped', { peer: 'services-3a' }), lane('c', 'not_found', { session: null }), lane('d', 'exited', { mtime: NOW - 3600000 })];
  const who = (opts) => whoRows(results, registry, (pid) => (pid === 11 ? 'ttys003' : ''), NOW, opts);
  assert.deepEqual(who({ all: true }), ['a  services-cd  ttys003  idle  idle 1m  ~/repo', 'b  services-3a  gone  busy  idle 5s  /x', 'd  d-sessio  gone  exited  idle 1h0m  ']);
  assert.deepEqual(who({}), who({ all: true }), 'running, stopped with no OK and exited all hold something');
  assert.deepEqual(who({ ok: new Set(['b']) }).map((r) => r.split('  ')[0]), ['a', 'd'], 'a stopped lane with an OK holds nothing');
});

test('live, who and the DONE row carry the lanes that hold something; --all carries the rest, and one wide Fences line is capped', () => {
  const results = [
    lane('running', 'in_progress', { peer: 'repo-1a', session_open: true, prompt_at: T('07:00') }),
    lane('asking', 'stopped', { peer: 'repo-2b', session_open: true, ask: 'which branch?', asked: true }),
    lane('done', 'finished', { peer: 'repo-3c', closed_at: T('07:40'), report: 'REPORT done' }),
  ];
  const st = store([], 'OK done 07:40 4f2a1c');
  const ok = okNames(st);
  assert.deepEqual(results.map((r) => isLive(r, ok)), [true, true, false]);
  const registry = [{ sessionId: 'running-session-id', pid: 11, name: 'repo-1a', status: 'busy', cwd: '/x' }];
  const who = (opts) => whoRows(results, registry, () => 'ttys001', NOW, { ok, ...opts }).map((r) => r.split('  ')[0]);
  assert.deepEqual(who({}), ['running', 'asking'], 'a finished lane with a fresh OK holds nothing');
  assert.deepEqual(who({ all: true }), ['running', 'asking', 'done']);
  const board = rows(results, st, { ctx: '120K/1M', repo: 'repo' });
  assert.ok(board.includes('DONE    1 verified'), board.join('\n'));
  assert.ok(!board.some((r) => r.startsWith('DONE') && r.includes('done')), 'the DONE row names no lane');
  const wide = `daemon/src/pool.ts daemon/src/dispatch.ts ${'x/y/very-long-path-'.repeat(20)}`;
  const row = liveRow('running', results[0], wide);
  assert.ok(row.endsWith('…') && row.length === 'running  in_progress  repo-1a  fences: '.length + 200, String(row.length));
  assert.equal(liveRow('running', results[0], ''), 'running  in_progress  repo-1a  fences: (no Fences line)');
});

test('a relayed ruling is the user\'s text under a TO heading; SENT and DID lines are lanes.txt tags the board accepts', () => {
  assert.equal(relayText('hourly-predicate', 'Ruling on amendment 1: (a). build'), 'TO hourly-predicate\nRuling on amendment 1: (a). build');
  const st = store([], 'OK a 08:00 x\nSENT a 08:05 build\nDID e 08:06 closed #14 with the resolution\nRUN a build');
  assert.deepEqual(st.lanes.map((l) => [l.tag, l.name]), [['OK', 'a'], ['SENT', 'a'], ['DID', 'e'], ['RUN', 'a']]);
  assert.deepEqual(rows([], st).filter((r) => r.startsWith('BAD')), []);
});


test('an unknown kind, a missing headline, and a LANE or HOLD without a lane are faults; HOLD and LANE may have no headline', () => {
  assert.match(parseItem('24-t.md', 'TODO fix this\n').bad[0], /#24 kind TODO unknown/);
  assert.match(parseItem('25-d.md', 'DECIDE\n').bad[0], /#25 no headline/);
  assert.match(parseItem('26-h.md', 'HOLD\n').bad[0], /#26 no lane/);
  assert.deepEqual(parseItem('26-h.md', 'HOLD some-lane\n').bad, []);
  assert.deepEqual(parseItem('27-l.md', 'LANE some-lane\n').bad, []);
});

test('the board: rows grouped by who acts, faults first, OK fresh only with the lane\'s latest time, CLOSE and DONE one line each, CTX last', () => {
  const results = [
    lane('a', 'not_found'),
    lane('b', 'stopped', { peer: 'repo-9b', session_open: true, ask: 'Which branch should I use?', asked: true }),
    lane('c', 'stalled', { peer: 'repo-3f', session_open: true, mtime: NOW - 12 * 60 * 1000 }),
    lane('d', 'continued', { peer: 'repo-2a', session_open: true, closed_at: T('07:10'), moved_at: T('07:30'), ask: 'Should I also touch CHANGELOG?', asked: true, report: 'REPORT d' }),
    lane('e', 'in_progress', { peer: 'repo-7c', session_open: true, prompt_at: T('23:50', '2026-09-04') }),
    lane('f', 'exited'),
    lane('g', 'finished', { closed_at: T('07:40'), report: 'REPORT g' }),
    lane('h', 'finished', { peer: 'repo-5d', session_open: true, closed_at: T('07:45'), report: 'REPORT h' }),
    lane('i', 'not_found'),
    lane('j', 'not_found'),
    lane('k', 'continued', { closed_at: T('07:50'), moved_at: T('07:55'), ask: 'done?', asked: true, report: 'REPORT k' }),
    lane('l', 'continued', { peer: 'repo-1f', session_open: true, closed_at: T('07:50'), moved_at: T('07:58'), ask: 'I also fixed lint.', asked: false, report: 'REPORT l' }),
    lane('m', 'finished', { peer: 'repo-4c', session_open: true, closed_at: T('07:59'), report: 'REPORT m' }),
    lane('n', 'continued', { peer: 'repo-6e', session_open: true, closed_at: T('07:50', '2026-09-04'), moved_at: T('07:57', '2026-09-04'), ask: 'Tag it too?', asked: true, report: 'REPORT n' }),
    lane('o', 'stopped', { peer: 'repo-0d', session_open: true, stopped_at: T('06:10'), ask: 'Added to ~/.claude/CLAUDE.md the rule.', asked: false, tail: 'Suite running.\nAdded to ~/.claude/CLAUDE.md the rule.' }),
  ];
  const st = store(
    [
      item('1-ship.md', 'DECIDE ship the codemod tonight or hold for review?\n'),
      item('2-r14.md', 'LANE r14 the next wire\nafter: e\n\nscope notes\n'),
      item('3-stop.md', 'STEP press Stop on i\nblocks: i\n'),
      item('4-ci.md', 'NOTE keep an eye on CI\n'),
      item('5-hold-e.md', 'HOLD e\nafter: a\n'),
    ],
    ['OK h 07:45 4f2a1c', 'OK k 07:55 9bd031', 'OK z 07:00 no commits', 'OK e 07:00 abc', 'OK d 07:10 abc', 'OK m 4f2a1c', 'OK n 09-04 07:57 dead', 'RUN j probe', 'RUN e do'].join('\n'),
  );
  assert.deepEqual(rows(results, st, { ctx: '187K/1M', repo: 'repo' }), [
    'BAD     #5 HOLD e: already launched',
    'RUN     prompt-a.txt',
    'RUN     prompt-j.txt',
    'ANSWER  b  repo-9b  asked: Which branch should I use?',
    'ANSWER  c  repo-3f  idle 12m, no activity',
    'ANSWER  d  repo-2a  after report: Should I also touch CHANGELOG?',
    'DECIDE  #1  ship the codemod tonight or hold for review?',
    'STEP    #3  press Stop on i  blocks: i',
    'CLOSE   h (repo-5d)  n (repo-6e)',
    'LIVE    e  repo-7c  since 09-04 23:50',
    'MINE    f  exited without report, re-issue',
    'MINE    m  verify report 07:59',
    'MINE    stale: OK m 4f2a1c',
    'MINE    l  re-verify 07:58',
    'MINE    g  verify report 07:40',
    'MINE    d  re-verify 07:30',
    'MINE    stale: OK d 07:10 abc',
    'MINE    o  stopped, no question: verify or re-issue  Suite running. Added to ~/.claude/CLAUDE.md the rule.',
    'MINE    stale: OK e 07:00 abc',
    'MINE    i  held: #3',
    'MINE    #4  keep an eye on CI',
    'MINE    r14  write prompt after e  #2',
    'DONE    1 verified, 1 filed',
    'CTX     coordinator 187K/1M  repo: 15 lanes  items 5',
  ]);
  assert.deepEqual(rows([lane('a', 'not_found')], store([], 'RUN a build')), ['RUN     prompt-a.txt', 'CTX     coordinator ?  ?: 1 lane  items 0'], 'a RUN line from an older store is read and ignored');
  assert.equal(rows([lane('b', 'stopped', { session: null, ask: 'q?', asked: true })], store([]))[0], 'ANSWER  b  ?  asked: q?');
  assert.deepEqual(rows([results[3]], store([], 'OK d 07:30 abc')), ['CLOSE   d (repo-2a)', 'CTX     coordinator ?  ?: 1 lane  items 0']);
  const ef = (name) => item('9-ef.md', `EFFORT ef the effort\nsize: S\npath: implement\nlanes: implement=${name}\n`);
  assert.match(rows([results[14]], store([ef('o')])).find((r) => r.startsWith('EFFORT')), /o \(implement\) stopped, no question  #9$/, 'a statement is not a question to answer');
  assert.match(rows([results[1]], store([ef('b')])).find((r) => r.startsWith('EFFORT')), /b \(implement\) answer it  #9$/);
});

test('MINE prints newest first, the newest three and one digest row of the rest by count; --all prints them whole; an unchanged board is no change', () => {
  const notes = [1, 2, 3, 4, 5].map((id) => item(`${id}-n.md`, `NOTE note ${id}\n`));
  const full = rows([lane('late', 'finished', { closed_at: T('07:50'), report: 'REPORT late' })], store(notes), { ctx: '90K/1M', repo: 'repo' });
  assert.deepEqual(full.filter((r) => r.startsWith('MINE')), ['MINE    late  verify report 07:50', 'MINE    #5  note 5', 'MINE    #4  note 4', 'MINE    #3  note 3', 'MINE    #2  note 2', 'MINE    #1  note 1'], 'a lane row by activity first, then items by id, highest first');
  assert.equal(MINE_KEEP, 3);
  const folded = foldMine(full);
  assert.deepEqual(folded.filter((r) => r.startsWith('MINE')), ['MINE    late  verify report 07:50', 'MINE    #5  note 5', 'MINE    #4  note 4', 'MINE    digest: 3 older, --all']);
  assert.equal(folded.length, full.length - 2, 'three rows become one');
  assert.equal(folded[folded.length - 1], full[full.length - 1], 'CTX stays last');
  assert.deepEqual(foldMine(full.slice(0, 2)), full.slice(0, 2), 'three or fewer MINE rows fold nothing');
  const again = rows([lane('late', 'finished', { closed_at: T('07:50'), report: 'REPORT late' })], store(notes), { ctx: '95K/1M', repo: 'repo' });
  assert.match(deltaLine(full, again, '08:01', { fold: MINE_KEEP }), /· no change · /);
  const more = rows([lane('late', 'finished', { closed_at: T('07:50'), report: 'REPORT late' })], store([item('0-old.md', 'NOTE oldest\n'), ...notes]), { repo: 'repo' });
  assert.match(deltaLine(full, more, '08:02', { fold: MINE_KEEP }), /· \+MINE digest: 4 older, --all · -MINE digest: 3 older, --all · .*mine 7$/, 'an older row moves only the digest count; the counts stay whole');
});

test('every edge target must be a prompt file, an OK line, or a LANE item; a dangling target is a BAD row', () => {
  const dangling = store([item('1-a.md', 'NOTE n\nuntil: ok ghost\n'), item('2-b.md', 'DECIDE q\nblocks: phantom\n'), item('3-c.md', 'LANE x scope\nafter: nobody\n')], 'OK real 07:10 abc');
  const bad = rows([lane('real', 'finished', { closed_at: T('07:10') })], dangling).filter((r) => r.startsWith('BAD'));
  assert.deepEqual(bad, ["BAD     #1 names unknown lane 'ghost'", "BAD     #2 names unknown lane 'phantom'", "BAD     #3 names unknown lane 'nobody'"]);
  const declared = store([item('1-a.md', 'NOTE n\nuntil: ok future\n'), item('2-f.md', 'LANE future scope\n'), item('3-g.md', 'NOTE m\nuntil: ok real\n')], 'OK real 07:10 abc');
  assert.ok(!rows([], declared).some((r) => r.startsWith('BAD')));
});

test('a HOLD suppresses the RUN row while any after: lane lacks a fresh OK, names the unmet ones, and releases the turn the last one is fresh', () => {
  const files = [item('18-h.md', 'HOLD integration-gate shares worktrees.ts\nafter: slot-key r15\n')];
  const results = [lane('integration-gate', 'not_found'), lane('slot-key', 'finished', { closed_at: T('07:10') }), lane('r15', 'finished', { closed_at: T('07:20') })];
  const held = rows(results, store(files, 'OK slot-key 07:10 abc\nRUN integration-gate build'));
  assert.ok(held.includes('MINE    integration-gate  held: #18 after r15'));
  assert.ok(!held.some((r) => /^RUN/.test(r)));
  const released = rows(results, store(files, 'OK slot-key 07:10 abc\nOK r15 07:20 def\nRUN integration-gate build'));
  assert.ok(released.includes('RUN     prompt-integration-gate.txt'));
  assert.ok(released.includes('MINE    file: #18'));
  assert.ok(!released.some((r) => /held:/.test(r)));
});

test('an edge naming a gated lane waits for its build: a gate-stop OK leaves after: and until: ok unmet, the held row names the build, the post-build OK meets both', () => {
  const GATE = 'REPORT base\nwhat: recon\n\nGated. Waiting for a message headed TO base carrying the word build.';
  const BUILT = 'REPORT base\nwhat: built\ncommits: abc123 feat: the base';
  const files = [item('145-h.md', 'HOLD drill-ins needs the base\nafter: base\n'), item('150-n.md', 'NOTE rebase the drill-ins\nuntil: ok base\n')];
  const at = (report, closed) => [lane('drill-ins', 'not_found'), lane('base', 'finished', { closed_at: T(closed), report, session_open: true })];
  const gateStop = rows(at(GATE, '03:00'), store(files, 'OK base 03:00 gate stop verified'));
  assert.ok(gateStop.includes("MINE    drill-ins  held: #145 after base's build"), gateStop.join('\n'));
  assert.ok(!gateStop.some((r) => r.startsWith('RUN')), 'NOTE 118: the hold must not lift on a gate-stop OK');
  assert.ok(gateStop.includes('MINE    #150  rebase the drill-ins  until: ok base'), 'until: ok is unmet too');
  const building = rows(at(GATE, '03:00'), store(files, 'OK base 03:00 gate stop verified\nSENT base 03:15 build'));
  assert.ok(building.includes("MINE    drill-ins  held: #145 after base's build"));
  const done = rows(at(BUILT, '03:50'), store(files, 'OK base 03:00 gate stop verified\nSENT base 03:15 build\nOK base 03:50 abc123'));
  assert.ok(done.includes('RUN     prompt-drill-ins.txt'), done.join('\n'));
  assert.ok(done.includes('MINE    file: #145 #150'));
});

test('an edge is satisfied only by a fresh OK: a lane that moves after its OK re-engages every hold and note that named it', () => {
  const st = store([item('18-h.md', 'HOLD x\nafter: y\n'), item('3-n.md', 'NOTE handed\nuntil: ok y\n')], 'OK y 07:10 abc\nRUN x build');
  const quiet = rows([lane('x', 'not_found'), lane('y', 'finished', { closed_at: T('07:10') })], st);
  assert.ok(quiet.includes('RUN     prompt-x.txt'));
  assert.ok(quiet.includes('MINE    file: #3 #18'));
  const moved = rows([lane('x', 'not_found'), lane('y', 'continued', { closed_at: T('07:10'), moved_at: T('07:30') })], st);
  assert.ok(moved.includes('MINE    y  re-verify 07:30'));
  assert.ok(moved.includes('MINE    x  held: #18 after y'));
  assert.ok(moved.includes('MINE    #3  handed  until: ok y'));
  assert.ok(!moved.some((r) => /file:/.test(r)));
});

test('a lane whose prompt file is gone is trusted on its last OK, because the watch cannot see it move', () => {
  const st = store([item('3-n.md', 'NOTE handed\nuntil: ok y\n'), item('6-l.md', 'LANE z scope\nafter: y\n')], 'OK y 07:10 abc');
  const out = rows([], st);
  assert.ok(out.includes('MINE    file: #3'));
  assert.ok(out.includes('MINE    z  write prompt now  #6'));
  assert.ok(out.includes('DONE    1 filed'));
});

test("a lane stopped at its gate waits on the user's build word: never a session to close, and its effort row says so", () => {
  const GATE = 'REPORT cell\nwhat: recon and the amendments, no build\ncommits: none\n\nGated. Waiting for a message headed `TO cell` carrying the word build.';
  const BUILT = 'REPORT cell\nwhat: built\ncommits: abc123 feat(cell): the cell\nopen: none';
  assert.equal(gateStop(GATE), true);
  assert.equal(gateStop(BUILT), false);
  assert.equal(gateStop(`${GATE}\nopen: none`), true, 'a postscript after the Gate sentence does not hide it');
  assert.equal(gateStop('REPORT cell\nwhat: recon\n\nGated. Waiting for a message headed TO cell carrying\nthe word build.'), true, 'a Gate sentence wrapped over two lines reads');
  const quoted = ['REPORT cell', 'what: the template ends a report with', 'Gated. Waiting for a message headed TO cell carrying the word build.', ...Array.from({ length: 20 }, (_, i) => `line ${i}`), 'open: none'].join('\n');
  assert.equal(gateStop(quoted), false, 'the sentence quoted twenty lines above the end is not a gate stop');
  assert.equal(gateStop('REPORT cell\nGated. Waiting for the word.\nP.S. the build passed.'), false, 'build must be in the Gate sentence, not after it');
  assert.equal(gateStop('Gated. Waiting for the word.'), false, 'the sentence names the word build');
  const ef = item('1-cells.md', 'EFFORT cells the cells\nsize: M\npath: implement\nlanes: implement=cell\non: issue 9\n');
  const at = (report, closed) => [lane('cell', 'finished', { closed_at: T(closed), report, session_open: true })];
  const tagged = (out, tag) => out.filter((l) => l.startsWith(tag));
  // Verified at its gate: the user owes it a word, so it is on the ANSWER side
  // and off CLOSE (control-room-home was told to close at 01:57 on 2026-09-09).
  const waiting = rows(at(GATE, '07:20'), store([ef], 'OK cell 07:20 gate stop verified'));
  assert.deepEqual(tagged(waiting, 'ANSWER'), ['ANSWER  cell  cell-ses  gated: waiting on your build word']);
  assert.deepEqual(tagged(waiting, 'CLOSE'), []);
  assert.match(waiting.find((l) => l.startsWith('EFFORT')), /cells M  cell \(implement\) gated: waiting on your build word  #1$/);
  // The word relayed: the lane is building again until its next report, and
  // still not a session to close.
  const relayed = rows(at(GATE, '07:20'), store([ef], 'OK cell 07:20 gate stop verified\nSENT cell 07:40 recommended: 1 (a); 2 (a). build'));
  assert.deepEqual(tagged(relayed, 'LIVE'), ['LIVE    cell  cell-ses  building since the build word 07:40']);
  assert.deepEqual(tagged(relayed, 'ANSWER'), []);
  assert.deepEqual(tagged(relayed, 'CLOSE'), []);
  assert.match(relayed.find((l) => l.startsWith('EFFORT')), /cell \(implement\) building since the build word  #1$/);
  // A re-verification during the build (NOTE 156): an OK after the SENT line, on a
  // report that still stops at the gate, leaves the build word standing.
  const reverified = store([ef], 'OK cell 07:20 gate stop verified\nSENT cell 07:40 build\nOK cell 07:20 re-verified at 07:48, four commits in its worktree');
  assert.deepEqual(tagged(rows(at(GATE, '07:20'), reverified), 'LIVE'), ['LIVE    cell  cell-ses  building since the build word 07:40']);
  assert.deepEqual(tagged(rows(at(GATE, '07:20'), reverified), 'ANSWER'), []);
  assert.match(rows(at(GATE, '07:20'), reverified).find((l) => l.startsWith('EFFORT')), /cell \(implement\) building since the build word  #1$/);
  // The same ledger once the report no longer stops at the gate: the word clears.
  assert.deepEqual(tagged(rows(at(BUILT, '07:20'), reverified), 'CLOSE'), ['CLOSE   cell (cell-ses)']);
  assert.deepEqual(tagged(rows(at(BUILT, '07:20'), reverified), 'LIVE'), []);
  // The word went to a session that is gone: the coordinator's act, never LIVE.
  const dead = rows([lane('cell', 'finished', { closed_at: T('07:20'), report: GATE, session_open: false })], store([ef], 'OK cell 07:20 gate stop verified\nSENT cell 07:40 build'));
  assert.deepEqual(tagged(dead, 'LIVE'), []);
  assert.deepEqual(tagged(dead, 'MINE'), ['MINE    cell  build word sent, session gone: re-issue']);
  assert.match(dead.find((l) => l.startsWith('EFFORT')), /cell \(implement\) build word sent, session gone: re-issue  #1$/);
  // The build's own report, verified: an ordinary finished lane again.
  const built = rows(at(BUILT, '07:50'), store([ef], 'OK cell 07:20 gate stop verified\nSENT cell 07:40 build\nOK cell 07:50 abc123 on main'));
  assert.deepEqual(tagged(built, 'CLOSE'), ['CLOSE   cell (cell-ses)']);
  assert.deepEqual(tagged(built, 'LIVE'), []);
  assert.match(built.find((l) => l.startsWith('EFFORT')), /cells M  close out #9: resolution comment, close, gist line  #1$/);
  // A gate stop nobody has verified yet is still the coordinator's to verify.
  const unverified = rows(at(GATE, '07:20'), store([ef]));
  assert.deepEqual(tagged(unverified, 'MINE'), ['MINE    cell  verify report 07:20']);
  assert.deepEqual(tagged(unverified, 'ANSWER'), []);
});

test('a HOLD or LANE naming a launched lane, and a blocks: edge to a launched lane, are faults', () => {
  const st = store([item('20-h.md', 'HOLD x\nafter: y\n'), item('9-d.md', 'DECIDE q\nblocks: x\n'), item('7-l.md', 'LANE x scope\n')], 'RUN y build');
  const bad = rows([lane('x', 'in_progress', { peer: 'p', prompt_at: T('07:00') }), lane('y', 'not_found')], st).filter((r) => r.startsWith('BAD'));
  assert.deepEqual(bad, ['BAD     #9 blocks x: already launched', 'BAD     #20 HOLD x: already launched']);
  assert.ok(!bad.some((r) => /#7/.test(r)), 'a LANE whose prompt exists is satisfied, not stale');
});

test('a LANE item closes when its prompt file exists or an OK names it, so deleting a DONE prompt file does not reopen it', () => {
  const files = [item('6-l.md', 'LANE floor scope\nafter: grant\n')];
  assert.ok(rows([], store(files, 'OK floor 08:00 abc')).includes('MINE    file: #6'));
  assert.ok(rows([lane('floor', 'in_progress', { peer: 'p', prompt_at: T('07:00') }), lane('grant', 'not_found')], store(files)).includes('MINE    file: #6'));
  assert.ok(rows([lane('grant', 'not_found')], store(files)).includes('MINE    floor  write prompt after grant  #6'));
});

test('a DECIDE or STEP that blocks a future lane shows on the lane row; the lane row lists unmet lanes first, then items', () => {
  const st = store([item('15-s.md', 'STEP deploy\nblocks: rerun4\n'), item('14-l.md', 'LANE rerun4 scope\nafter: grant gate\n')], 'OK grant 08:00 abc');
  const out = rows([lane('gate', 'not_found')], st);
  assert.ok(out.includes('STEP    #15  deploy  blocks: rerun4'));
  assert.ok(out.includes('MINE    rerun4  write prompt after gate #15  #14'));
  assert.ok(rows([], store([item('15-s.md', 'STEP deploy\nblocks: rerun4\n'), item('14-l.md', 'LANE rerun4 scope\n')])).includes('MINE    rerun4  write prompt after #15  #14'));
});

test('cycles are one BAD row each, reported once', () => {
  const st = store([item('22-a.md', 'LANE a\nafter: b\n'), item('23-b.md', 'LANE b\nafter: a\n'), item('24-c.md', 'HOLD c\nafter: d\n'), item('25-d.md', 'LANE d\nafter: c\n')], '');
  assert.deepEqual(rows([lane('c', 'not_found')], st).filter((r) => /cycle/.test(r)), ['BAD     cycle: a -> b -> a', 'BAD     cycle: c -> d -> c']);
});

test('the same id twice, or one item both open and closed, is a BAD row and both rows still print', () => {
  const dup = rows([], store([item('6-a.md', 'NOTE a\n'), item('6-b.md', 'NOTE b\n')]));
  assert.ok(dup.includes('BAD     dup id 6: 6-a.md 6-b.md'));
  assert.equal(dup.filter((r) => /^MINE    #6/.test(r)).length, 2);
  const both = rows([], store([item('1-a.md', 'NOTE a\n')], '', ['1-a.md', '9-z.md']));
  assert.ok(both.includes('BAD     #1 open and closed: 1-a.md, closed/1-a.md'));
  assert.ok(both.includes('MINE    #1  a'));
});

test('lanes.txt is only OK, SENT and DID; the last OK per lane wins, so re-verification appends and never edits', () => {
  const st = store([], 'OK x 07:10 old\nOK x 07:30 new\nHOLD y until Stop\nOK');
  const out = rows([lane('x', 'continued', { closed_at: T('07:10'), moved_at: T('07:30') })], st);
  assert.deepEqual(out.filter((r) => r.startsWith('BAD')), ["BAD     lanes.txt: 'HOLD y until Stop' is not OK|SENT|DID <lane> <time> <text>", "BAD     lanes.txt: 'OK' is not OK|SENT|DID <lane> <time> <text>"]);
  assert.ok(!out.some((r) => /stale:/.test(r)));
  assert.ok(out.includes('DONE    1 verified'), 'the DONE row is a count; `who --all` carries the names');
});

test('unknown kinds print their raw first line as MINE beside the fault, so nothing a human wrote vanishes', () => {
  const out = rows([], store([item('24-t.md', 'TODO fix this\n')]));
  assert.ok(out.includes('BAD     #24 kind TODO unknown'));
  assert.ok(out.includes('MINE    #24  TODO fix this'));
});

test('IDEA items never print; CTX counts them apart from items', () => {
  const out = rows([], store([item('1-i.md', 'IDEA a static page over the fold\n'), item('2-n.md', 'NOTE n\n')]));
  assert.ok(!out.some((r) => /static page/.test(r)));
  assert.equal(out.at(-1), 'CTX     coordinator ?  ?: 0 lanes  items 1  ideas 1');
});

test('headlines print capped at 96 characters with an ellipsis; the file keeps the full line', () => {
  const it = parseItem('1-a.md', `NOTE ${'w'.repeat(200)}\n`);
  assert.equal(it.head.length, 200);
  assert.match(rows([], store([item('1-a.md', `NOTE ${'w'.repeat(200)}\n`)]))[0], /^MINE {4}#1 {2}w{95}…$/);
});

test('CTX names a second live coordinator or watch instead of a hand-written line', () => {
  assert.equal(rows([], store([]), { coordinators: 2, watches: 3 }).at(-1), 'CTX     coordinator ?  ?: 0 lanes  items 0  coordinators 2  watches 3');
  assert.equal(rows([], store([]), { coordinators: 1, watches: 1 }).at(-1), 'CTX     coordinator ?  ?: 0 lanes  items 0');
});

test('the board is a fold: same inputs, same rows; a body of any size changes nothing; board reads leave the store untouched', () => {
  const small = store([item('1-a.md', 'NOTE n\n\nbody')]);
  const huge = store([item('1-a.md', `NOTE n\n\n${'x'.repeat(1e6)}`)]);
  assert.deepEqual(rows([], small), rows([], huge));
  const dir = path.join(HERE, 'fixtures', 'store', 'coordinator');
  const snapshot = () => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs]));
  const before = snapshot();
  const a = rows(FIXTURE_LANES, readStore(path.dirname(dir), dir));
  const b = rows(FIXTURE_LANES, readStore(path.dirname(dir), dir));
  assert.deepEqual(a, b);
  assert.deepEqual(snapshot(), before);
  assert.ok(a.includes('MINE    docs-apply-r51  write prompt after gate-amendments  #9'));
  assert.ok(a.includes('DONE    15 filed'));
});

// The fixture ledger as of 2026-09-07 11:55, with the two lanes its items name.
const FIXTURE_LANES = [lane('gate-amendments', 'not_found'), lane('scratch-write-grant', 'in_progress', { peer: 'nightshift-b7', session_open: true, prompt_at: T('08:33') })];

test('the fixture ledger has no faults and renders in 20 rows; the bad fixture has every fault the design names', () => {
  const good = rows(FIXTURE_LANES, readStore(path.join(HERE, 'fixtures', 'store'), path.join(HERE, 'fixtures', 'store', 'coordinator')), { ctx: '66K/1M', repo: 'nightshift' });
  assert.deepEqual(good.filter((r) => r.startsWith('BAD')), []);
  assert.equal(good.length, 20);
  assert.equal(good[0], 'RUN     prompt-gate-amendments.txt');
  assert.ok(good.includes('MINE    phase4-rerun4  write prompt after gate-amendments scratch-write-grant #15  #14'));
  assert.ok(good.includes('STEP    #17  release the daemon after PR 12 merges'), 'until: merged 12 stays open while github.txt says OPEN');
  assert.ok(good.includes('EFFORT  slot-key-cleanup M  write prompt implement  #16'), 'the research lane is verified on its OK, the implement lane is next');
  assert.equal(good.at(-1), 'CTX     coordinator 66K/1M  nightshift: 2 lanes  items 16');
  const bad = rows(FIXTURE_LANES, readStore(path.join(HERE, 'fixtures', 'store-bad'), path.join(HERE, 'fixtures', 'store-bad', 'coordinator'))).filter((r) => r.startsWith('BAD'));
  for (const re of [/lanes\.txt: 'HOLD old-lane/, /#1 open and closed/, /#1 names unknown lane 'docs-apply-r51'/, /#21 header line not a known key/, /#21 until:/, /#24 kind TODO unknown/, /#25 no headline/, /dup id 6/, /cycle: a-lane -> b-lane -> a-lane/, /github\.txt: 'pr 12 DONE'/, /#26 size: 'XL'/, /#26 path names 'build'/, /#26 lanes: 'implement-x'/, /#26 on: 'ticket 5'/, /#26 lanes: prototype is not on the path/, /#26 names unknown lane 'nothing-here'/, /#27 size: only an EFFORT carries it/]) assert.ok(bad.some((r) => re.test(r)), String(re));
});

test('resume: per live lane its status, worktree, uncommitted files, commits ahead and report tail, per open STEP its last dated line, in one call; a git read that fails is (unreadable)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-resume-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'the lane commit');
  fs.writeFileSync(path.join(repo, 'wip.ts'), 'x\n');
  const live = [lane('grid', 'in_progress', { peer: 'repo-9f', cwd: repo, report: 'REPORT grid\nwhat: built\nopen: the flaky pool test\n  under load' })];
  const st = store([item('198-deploy.md', 'STEP deploy first\n\nwhy: the tip is ahead\nUPDATE 2026-09-11 09:05 deploy before the restart\nnot dated\n'), item('2-n.md', 'NOTE not shown\n')]);
  const steps = st.items.filter((i) => i.kind === 'STEP');
  const out = resumeRows(live, steps, (r) => worktreeFacts(r.cwd));
  assert.deepEqual(out, [
    `LIVE    grid  in_progress  repo-9f  ${fs.realpathSync(repo)}`,
    '  uncommitted: wip.ts',
    `  ahead of origin/main: ${git('rev-parse', '--short', 'HEAD').trim()} the lane commit`,
    '  report: open: the flaky pool test under load',
    'STEP    #198  deploy first  last: UPDATE 2026-09-11 09:05 deploy before the restart',
  ]);
  const broken = resumeRows(live, steps, (r) => worktreeFacts(r.cwd, () => {
    throw new Error('git: not found');
  }));
  assert.deepEqual(broken.slice(0, 3), [`LIVE    grid  in_progress  repo-9f  ${repo}`, '  uncommitted: (unreadable)', '  ahead of the base: (unreadable)'], 'a failing git degrades to a row');
  assert.deepEqual(resumeRows([], [], () => ({})), ['nothing live, no open STEP or DECIDE']);
  assert.equal(lastReportSection('REPORT x\nwhat: y\n'), 'what: y');
  assert.equal(lastDatedLine('no dates here'), null);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-resume-cli-'));
  fs.mkdirSync(path.join(cwd, 'coordinator'));
  fs.writeFileSync(path.join(cwd, 'coordinator', '198-deploy.md'), 'STEP deploy first\n\nUPDATE 2026-09-11 09:05 deploy before the restart\n');
  const cli = spawnSync(process.execPath, [path.join(HERE, 'lane.mjs'), 'resume', '--cwd', cwd], { encoding: 'utf8', env: HERMETIC });
  assert.deepEqual([cli.status, cli.stdout.trim()], [0, 'STEP    #198  deploy first  last: UPDATE 2026-09-11 09:05 deploy before the restart']);
  fs.rmSync(repo, { recursive: true });
  fs.rmSync(cwd, { recursive: true });
});

test('new mints max+1 across open and closed, refuses an existing filename, and steps past a twin id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-store-'));
  fs.mkdirSync(path.join(dir, 'closed'));
  fs.writeFileSync(path.join(dir, '3-y.md'), 'NOTE y\n');
  fs.writeFileSync(path.join(dir, 'closed', '7-x.md'), 'NOTE x\n');
  assert.equal(nextId(dir), 8);
  const a = mintItem(dir, 'Hello, World! and more', 'NOTE hello\n');
  assert.equal(a.id, 8);
  assert.equal(path.basename(a.file), '8-hello-world-and-more.md');
  assert.equal(fs.readFileSync(a.file, 'utf8'), 'NOTE hello\n');
  fs.writeFileSync(path.join(dir, '9-taken.md'), 'NOTE taken\n');
  const b = mintItem(dir, 'hello', 'NOTE again\n');
  assert.equal(b.id, 10);
  assert.throws(() => fs.writeFileSync(a.file, 'x', { flag: 'wx' }), /EEXIST/);
  assert.equal(slugOf('  --Weird__Name!!  '), 'weird-name');
  assert.equal(slugOf('x'.repeat(100)).length, 40);
  assert.equal(slugOf(''), 'item');
  fs.rmSync(dir, { recursive: true });
});

test('a turn that ends without a report is stopped, with the tail; a tool_use stop is in_progress', () => {
  const stopped = analyze([human(PROMPT), assistant('Which branch should I use?', 'end_turn')], NAME);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.tail, 'Which branch should I use?');
  const running = analyze([human(PROMPT), assistant('Running tests.', 'tool_use')], NAME);
  assert.equal(running.status, 'in_progress');
  const resumed = analyze([human(PROMPT), assistant('Which branch?', 'end_turn'), human('main'), assistant('ok', 'tool_use')], NAME);
  assert.equal(resumed.status, 'in_progress');
});

test('the report body is capped when rendered', () => {
  const body = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const r = analyze([human(PROMPT), assistant(`REPORT ${NAME}\n${body}`, 'end_turn')], NAME);
  const out = render({ ...r, name: NAME, worker_ctx: '10K/1M' }, '20K/1M');
  assert.match(out, /… 21 more lines$/);
  assert.match(out, /coordinator ctx 20K\/1M/);
});

test('ctx sums the statusline set of usage fields from the last assistant record', () => {
  const recs = [
    { type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } },
    { type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 1000 } } },
    { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } } },
    { type: 'user', message: { content: 'x' } },
  ];
  assert.equal(ctxTokens(recs), 100);
  assert.equal(ctxTokens([{ type: 'user', message: { content: 'x' } }]), null);
});

test('ctx is silent and exits 0 before the session has a transcript with usage; then it prints the line', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-ctx-home-'));
  const env = { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: '' };
  const ctx = (sid) => spawnSync(process.execPath, [path.join(HERE, 'lane.mjs'), 'ctx', '--session', sid], { encoding: 'utf8', env });
  try {
    const fresh = ctx('05ead7fc-0000-4000-8000-000000000000');
    assert.deepEqual([fresh.status, fresh.stdout, fresh.stderr], [0, '', ''], 'no transcript yet: the first-prompt hook must not fail');
    const dir = path.join(home, '.claude', 'projects', '-repo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'young.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
    const young = ctx('young');
    assert.deepEqual([young.status, young.stdout, young.stderr], [0, '', ''], 'transcript without an assistant turn: still nothing to report');
    fs.appendFileSync(path.join(dir, 'young.jsonl'), `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10000, output_tokens: 20000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 40000 } } })}\n`);
    const grown = ctx('young');
    assert.deepEqual([grown.status, grown.stdout.trim()], [0, 'ctx 100K/1M']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the window comes from the model id, and the model id from argv', () => {
  assert.equal(modelFromArgv('claude --model fable[1m]'), 'fable[1m]');
  assert.equal(modelFromArgv('claude --model=opus -p'), 'opus');
  assert.equal(modelFromArgv('claude --resume abc'), null);
  assert.equal(windowFromModel('fable[1m]'), 1000000);
  assert.equal(windowFromModel('claude-opus-5[1m]'), 1000000);
  assert.equal(windowFromModel('claude-fable-5-1'), 200000);
  assert.equal(windowFromModel(null), null);
});

test('the hand-off is due past 350K of the session\'s own context with nothing left to verify, and the three documents carry one rule', () => {
  const live = [lane('a', 'not_found'), lane('e', 'in_progress', { peer: 'repo-7c', session_open: true, prompt_at: T('23:50', '2026-09-04') })];
  const st = store([]);
  assert.equal(HANDOFF_AT, 350000);
  assert.equal(rows(live, st, { ctx: '360K/1M', ctxTokens: 360000, repo: 'repo' })[0], 'HANDOFF  hand off now  past 350K with nothing unverified: everything is on disk; handoff.md only for what no item holds');
  assert.ok(!rows(live, st, { ctxTokens: 349999 }).some((r) => r.startsWith('HANDOFF')), 'below the threshold the row is absent');
  assert.ok(!rows(live, st, {}).some((r) => r.startsWith('HANDOFF')), 'a context it cannot read is never due');
  const held = [...live, lane('g', 'finished', { closed_at: T('07:40'), report: 'REPORT g' })];
  assert.ok(!rows(held, store([]), { ctxTokens: 360000 }).some((r) => r.startsWith('HANDOFF')), 'a report left to verify holds the moment back');
  assert.ok(rows(held, store([], 'OK g 07:40 abc'), { ctxTokens: 360000 }).some((r) => r.startsWith('HANDOFF')), 'once it is verified the moment arrives');
  assert.ok(deltaLine(rows(live, st, { ctxTokens: 360000, ctx: '360K/1M' }), rows(live, st, { ctxTokens: 390000, ctx: '390K/1M' }), '08:00').includes('no change'), 'the row carries no number, so a growing context is not a change');
  assert.deepEqual([handoffDue(400000, false), handoffDue(400000, true), handoffDue(null, false), handoffDue(349999, false)], [true, false, false, false]);
  for (const f of ['SKILL.md', 'README.md', 'DESIGN.md']) {
    const text = fs.readFileSync(path.join(HERE, f), 'utf8');
    assert.ok(text.includes("Past 350K of the session's own context the coordinator starts looking for a hand-off"), `${f} carries the 350K rule`);
    assert.ok(text.includes('nothing unverified'), `${f} names the condition`);
    assert.ok(!/300\s?[kK]\b/.test(text), `${f} no longer names a 300K threshold`);
  }
});

test('an unlaunched prompt is a RUN row with its Done when beside it; a name with an OK is never launched again', () => {
  const text = buildPrompt('cols', { ask: 'show requested vs capacity per row', done: 'every group and node row shows the bar; unknown rows show a dash, and the teammate who asked can read it', fences: 'web/ only' });
  const out = rows([lane('cols', 'not_found')], store([]), { prompts: new Map([['cols', text]]) });
  assert.ok(out[0].startsWith('RUN     prompt-cols.txt  every group and node row shows the bar; unknown rows') && out[0].endsWith('…') && out[0].length === 'RUN     prompt-cols.txt  '.length + 60, out[0]);
  assert.deepEqual(rows([lane('cols', 'not_found')], store([])).filter((r) => r.startsWith('RUN')), ['RUN     prompt-cols.txt'], 'a hand-written file with no Done when line is still a RUN row');
  const reused = rows([lane('a', 'not_found')], store([], 'OK a 07:00 abc'));
  assert.deepEqual(reused.filter((r) => /^(BAD|RUN)/.test(r)), ['BAD     prompt-a.txt: name already verified (OK a 07:00 abc); delete the file if it is that lane, else pick a new name']);
  assert.ok(!rows([], store([], 'RUN gone build')).some((r) => /stale|BAD/.test(r)), 'a RUN line for a lane whose file is gone is not a row');
});

test('launch: the RUN rows as `claude -n <name> "$(cat prompt-<name>.txt)"` lines, grouped by disjoint fences, a later block naming the shared path, held prompts under HELD; never prompt text', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-launch-'));
  const run = (...a) => execFileSync(process.execPath, [path.join(HERE, 'lane.mjs'), ...a, '--cwd', cwd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: HERMETIC }).trim();
  const prompt = (name, fences, i) => {
    const file = path.join(cwd, `prompt-${name}.txt`);
    fs.writeFileSync(file, `TASK ${name}\nKind: implement\nAsk: build ${name}, the secret ask\nFences: ${fences}\n`);
    fs.utimesSync(file, NOW / 1000 + i, NOW / 1000 + i);
  };
  assert.equal(run('launch'), 'no prompt to launch');
  prompt('rows-bar', 'Write only `web/components/rows/` and web/e2e/rows.spec.ts, in your own worktree .claude/worktrees/rows-bar from origin/main; no dakr/.', 1);
  prompt('docs-map', 'Write only docs/architecture.md, in your own worktree under .claude/worktrees/ from origin/main; https://github.com/x/y/issues/1 for the map. Read: coordinator/goals.md', 2);
  prompt('rows-test', 'Write only web/components/rows/bar.test.tsx', 3);
  prompt('later', 'golib/logging/', 4);
  run('new', 'HOLD', 'later', '--after', 'docs-map');
  const out = run('launch');
  assert.equal(out, [
    'RUN, two prompts, fences disjoint, launch together:',
    '  claude -n rows-bar  "$(cat prompt-rows-bar.txt)"',
    '  claude -n docs-map  "$(cat prompt-docs-map.txt)"',
    'RUN, after the block above (fences overlap on web/components/rows/):',
    '  claude -n rows-test "$(cat prompt-rows-test.txt)"',
    'HELD, not now:',
    '  claude -n later     "$(cat prompt-later.txt)"         # held: #1 after docs-map; fences unsplit',
  ].join('\n'));
  assert.ok(!/secret ask/.test(out), 'no prompt text');
  assert.deepEqual(fenceTokens('(`dakr/server/`, web/app/x.tsx.) README.md http://x/y e.g. main origin/main .claude/reviews/ coordinator/12-x.md CLAUDE.md'), ['dakr/server/', 'web/app/x.tsx']);
  // A bare file name names no place in the tree: two prompts that both mention
  // one are not overlapping. Five false holds on 2026-09-09 were these.
  assert.deepEqual(fenceTokens('not nightshift.yml; prompt-*.txt is never committed; no lane REPORT.md but your own; worktrees.ts is settled-counter\'s'), []);
  assert.equal(fenceOverlap(fenceTokens('daemon/src/ only, not nightshift.yml'), fenceTokens('dashboard/src/ only, not nightshift.yml')), null);
  assert.equal(fenceOverlap(fenceTokens('daemon/src/picks.ts, REPORT.md'), fenceTokens('daemon/src/picks.ts, REPORT.md')), 'daemon/src/picks.ts', 'a path still holds');
  assert.equal(fenceOverlap(['web/components/'], ['web/components/CostOverviewCard.tsx']), 'web/components/');
  assert.equal(fenceOverlap(['web/'], ['web/app/x.tsx']), null, 'a top-level directory claims nothing below it');
  assert.equal(fenceOverlap(['dakr/'], ['dakr/']), null, 'a whole top-level tree is boilerplate-grade, even shared exactly');
  assert.equal(fenceOverlap(['web/app'], ['web/apples/']), null);
  fs.rmSync(cwd, { recursive: true });
  // live: in_progress and exited hold; continued with an OK and finished never do
  const prompts = new Map([
    ['grid', 'Fences: Write only web/components/CostOverviewCard.tsx, in your own worktree from origin/main'],
    ['perf', 'Fences: Write only dakr/server/ and web/components/ from origin/main'],
    ['done', 'Fences: Write only web/components/ from origin/main'],
    ['gone', 'Fences: Write only docs/ from origin/main'],
    ['caption', 'Fences: Write only web/components/CostOverviewCard.tsx from origin/main'],
    ['docs', 'Fences: Write only docs/agents/ from origin/main'],
  ]);
  const results = [lane('grid', 'in_progress', { prompt_at: T('07:00') }), lane('perf', 'continued', { closed_at: T('07:10'), moved_at: T('07:30'), report: 'REPORT perf' }), lane('done', 'finished', { closed_at: T('07:20'), report: 'REPORT done' }), lane('gone', 'exited'), lane('caption', 'not_found'), lane('docs', 'not_found')];
  const st = store([], 'OK perf 07:30 abc');
  assert.deepEqual(launchBlock(rows(results, st, { prompts }), results, prompts, st), [
    'RUN, one prompt:',
    '  claude -n docs    "$(cat prompt-docs.txt)"',
    'HELD, not now:',
    '  claude -n caption "$(cat prompt-caption.txt)"     # overlaps live grid on web/components/CostOverviewCard.tsx',
  ]);
  const unverified = store([]);
  assert.match(launchBlock(rows(results, unverified, { prompts }), results, prompts, unverified).join('\n'), /caption "\$\(cat prompt-caption\.txt\)"     # overlaps live grid on/, 'the in_progress lane names the hold first');
  assert.match(launchBlock(rows(results.slice(1), unverified, { prompts }), results.slice(1), prompts, unverified).join('\n'), /caption "\$\(cat prompt-caption\.txt\)"     # overlaps live perf on web\/components\//, 'continued without an OK still holds');
});

test('fences are the write clauses alone: a read, exclusion or live-beside clause claims nothing; the three measured holds; a line with no write clause keeps its tokens and says so', () => {
  const F = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'fences.json'), 'utf8'));
  const claim = (name) => fenceClaims(F[name]);
  // manager-switchboard-brief was held on a read clause and a live-beside clause
  assert.deepEqual(claim('manager-switchboard-brief'), { tokens: ['manager-switchboard/'], split: true });
  assert.equal(fenceOverlap(claim('manager-switchboard-brief').tokens, claim('deny-floor-four').tokens), null);
  // ledger-per-coder-return-implement: the right verdict, now on the right token
  assert.deepEqual(claim('deny-floor-four').tokens, ['daemon/src/settings.ts', 'daemon/test/settings.test.ts', 'deny-floor-four/']);
  assert.equal(fenceOverlap(claim('ledger-per-coder-return-implement').tokens, claim('deny-floor-four').tokens), 'daemon/src/settings.ts');
  assert.ok(!claim('ledger-per-coder-return-implement').tokens.includes('daemon/src/picks.ts'), 'its Not clause claims nothing');
  // NOTE 118 02:49: picks.ts sat only in settled-counter's do-not-touch clause
  assert.ok(!claim('settled-counter').tokens.includes('daemon/src/picks.ts'));
  assert.equal(fenceOverlap(claim('declared-pick-fields-implement').tokens, claim('settled-counter').tokens), null);
  // a write clause continues across `;` and ends at a full stop
  assert.deepEqual(fenceClaims('write only a/b.ts; c/d.ts. Base origin/main; e/f.ts is read').tokens, ['a/b.ts', 'c/d.ts']);
  assert.deepEqual(fenceClaims('In: web/x/y.ts. Out: web/z/'), { tokens: ['web/x/y.ts'], split: true });
  // the fallback: no write clause, today's tokens, split false
  assert.deepEqual(fenceClaims('web/components/rows/ and golib/logging/ only; not docs/x/'), { tokens: ['web/components/rows/', 'golib/logging/', 'docs/x/'], split: false });
  const results = [lane('legacy', 'not_found')];
  const prompts = new Map([['legacy', 'Fences: golib/logging/ only']]);
  assert.deepEqual(launchBlock(rows(results, store([]), { prompts }), results, prompts, store([])), ['RUN, one prompt:', '  claude -n legacy "$(cat prompt-legacy.txt)"     # fences unsplit']);
});

test('deltaLine counts efforts apart from you, live and mine', () => {
  assert.equal(deltaLine(null, ['EFFORT  e M  write prompt research  #9', 'MINE    #1  x', 'CTX     c'], '08:00:00'), 'board 08:00:00 · first · you 0 · efforts 1 · live 0 · mine 1');
});

test('deltaLine names the rows that appeared and vanished, never CTX, then counts by who acts', () => {
  const a = ['RUN     prompt-x.txt', 'DECIDE  #1  ship?', 'LIVE    y  peer  since 07:00', 'MINE    z  verify report 07:40', 'CTX     coordinator 10K/1M  repo: 3 lanes  items 1'];
  assert.equal(deltaLine(null, a, '08:00:00'), 'board 08:00:00 · first · you 2 · live 1 · mine 1');
  assert.equal(deltaLine(a, [...a.slice(0, 4), 'CTX     coordinator 20K/1M'], '08:01:00'), 'board 08:01:00 · no change · you 2 · live 1 · mine 1');
  const b = ['BAD     #2 names unknown lane q', 'DECIDE  #1  ship?', 'LIVE    y  peer  since 07:00', 'DONE    z', 'CTX     c'];
  assert.equal(deltaLine(a, b, '08:02:00'), 'board 08:02:00 · +BAD #2 names unknown lane q · +DONE z · -RUN prompt-x.txt · -MINE z verify report 07:40 · bad 1 · you 1 · live 1 · mine 0');
  assert.equal(deltaLine([], [`MINE    #3  ${'x'.repeat(80)}`, 'CTX c'], '08:03:00'), `board 08:03:00 · +MINE #3 ${'x'.repeat(47)}… · you 0 · live 0 · mine 1`);
});

test('a lane whose session is gone is exited only after the grace, so a --resume is not a re-issue', () => {
  const res = { session: 's1', report: null };
  assert.equal(exited(res, null, false, EXIT_GRACE_MS + 1), true, 'no registry entry, idle past the grace');
  assert.equal(exited(res, null, false, EXIT_GRACE_MS - 1), false, 'no registry entry, still inside the grace');
  assert.equal(exited(res, { pid: 1 }, false, EXIT_GRACE_MS + 1), true, 'dead pid past the grace');
  assert.equal(exited(res, { pid: 1 }, true, EXIT_GRACE_MS + 1), false, 'alive');
  assert.equal(exited({ session: 's1', report: 'REPORT x' }, null, false, EXIT_GRACE_MS + 1), false, 'a reported lane is never exited');
  assert.equal(exited(res, { pid: 0 }, false, EXIT_GRACE_MS + 1), true, 'an entry without a pid is gone past the grace (F17: it kept a lane alive for a shift)');
  assert.equal(exited(res, {}, false, EXIT_GRACE_MS - 1), false, 'and inside the grace a --resume may still take it');
  // The clock is the last record, not the file (NOTE 161: a touch flipped a stalled lane live for ten minutes).
  const iso = (ms) => new Date(ms).toISOString();
  const quiet = { status: 'in_progress', session: 's1', report: null, last_activity: iso(NOW - 11 * 60 * 1000) };
  assert.equal(settle(quiet, { pid: 1 }, true, NOW, NOW), 'stalled', 'a file touched now, a last record eleven minutes old');
  assert.equal(settle({ ...quiet, last_activity: iso(NOW - 60 * 1000) }, { pid: 1 }, true, NOW, NOW - 3600000), 'in_progress', 'a fresh record, an old mtime');
  assert.equal(settle({ ...quiet, last_activity: null }, { pid: 1 }, true, NOW, NOW - 11 * 60 * 1000), 'stalled', 'no record timestamp: the mtime is the fallback');
  assert.equal(settle(quiet, { pid: 1 }, false, NOW, NOW), 'exited', 'the grace runs on the record clock too');
  assert.equal(activeAt({ last_activity: '2026-09-05T07:00:00Z' }, NOW), Date.parse('2026-09-05T07:00:00Z'));
  assert.equal(latestTime({ status: 'finished', closed_at: T('07:40') }, NOW), '07:40');
  assert.equal(latestTime({ status: 'continued', closed_at: T('07:40'), moved_at: T('07:55') }, NOW), '07:55');
});

test('goals.md, handoff.md and board.txt live beside the items and are never items; the CLI writes prompts, OKs, retirements and the board file', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-cli-'));
  const dir = path.join(cwd, 'coordinator');
  const run = (...a) => execFileSync(process.execPath, [path.join(HERE, 'lane.mjs'), ...a, '--cwd', cwd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: HERMETIC }).trim();
  const fails = (...a) => {
    try {
      run(...a);
    } catch (e) {
      return String(e.stderr).trim();
    }
    throw new Error(`expected failure: ${a.join(' ')}`);
  };
  assert.match(fails('delta'), /no coordinator\/: run lane\.mjs init first/);
  const L = shorthandLine(path.join(HERE, 'lane.mjs'));
  assert.equal(run('init'), `coordinator/\ncoordinator/goals.md: skeleton, fill it in\nnot a git repo: /coordinator/ /prompt-*.txt not excluded\n${L}`);
  assert.equal(fs.readFileSync(path.join(dir, 'goals.md'), 'utf8'), GOALS_TEMPLATE);
  assert.equal(run('init'), `coordinator/: exists\nnot a git repo: /coordinator/ /prompt-*.txt not excluded\n${L}`, 'a second init writes nothing');
  fs.writeFileSync(path.join(dir, 'handoff.md'), 'notes\n');
  fs.writeFileSync(path.join(dir, '4-note.md'), 'NOTE a note\n');
  assert.deepEqual(readStore(cwd).items.map((i) => i.file), ['4-note.md']);
  assert.match(fails('prompt', 'cols', '--ask', 'show the bar', '--done', 'rows show it'), /kind '' is not one of/);
  assert.equal(run('prompt', 'cols', '--kind', 'implement', '--ask', 'show the bar', '--done', 'rows show it', '--fences', 'web/', '--pointers', '#10600'), 'coordinator/prompt-cols.txt');
  assert.equal(promptField(fs.readFileSync(path.join(dir, 'prompt-cols.txt'), 'utf8'), 'Done when'), 'rows show it');
  assert.equal(boardData({ cwd }).prompts.get('cols'), fs.readFileSync(path.join(dir, 'prompt-cols.txt'), 'utf8'), 'boardData carries every prompt file whole');
  assert.match(fails('prompt', 'cols', '--kind', 'implement', '--ask', 'x', '--done', 'y'), /prompt-cols\.txt exists/);
  assert.match(fails('prompt', 'other', '--kind', 'implement', '--ask', 'x', '--done', 'y', '--pointers', '#4'), /names item #4/);
  assert.match(fails('prompt', 'other', '--kind', 'implement', '--ask', 'x'), /Done when is empty/);
  assert.match(fails('prompt', 'other', '--kind', 'implement', '--ask', 'x', '--done', 'y'), /Fences is empty/);
  assert.match(fails('retire', 'a/../../victim', 'why'), /is not lower-case letters/);
  assert.match(fails('retire', 'ghost', 'why'), /no lane named ghost/);
  assert.match(fails('new', 'HOLD', 'cols'), /a HOLD waits on --after lanes/);
  assert.match(fails('ok', 'cols', 'abc'), /cols is not_found, nothing to verify yet/);
  assert.match(fails('ok', 'nope', 'abc'), /no prompt-nope\.txt/);
  const first = run('delta');
  assert.match(first, /^board \d\d:\d\d:\d\d · first · you 1 · live 0 · mine 1$/);
  assert.match(fs.readFileSync(path.join(dir, 'board.txt'), 'utf8'), /^board lane-cli-\S+ \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\nRUN     prompt-cols\.txt  implement  rows show it\nMINE    #4  a note\nCTX /);
  assert.match(run('delta'), /· no change · you 1 · live 0 · mine 1$/);
  const retired = run('retire', 'cols', 'user launched it inline');
  assert.match(retired, /^OK cols \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ retired: user launched it inline\nremoved coordinator\/prompt-cols\.txt\nre-issue: no session took it$/);
  assert.ok(!fs.existsSync(path.join(dir, 'prompt-cols.txt')));
  assert.match(fails('prompt', 'cols', '--kind', 'implement', '--ask', 'x', '--done', 'y'), /cols already has an OK/);
  assert.match(run('delta'), /· -RUN prompt-cols\.txt implement rows show it · you 0 · live 0 · mine 1$/);
  assert.equal(run('live'), 'no lane holds anything: --all for every launched lane');
  assert.equal(run('live', '--all'), 'no launched lane');
  assert.deepEqual(readStore(cwd).items.map((i) => i.file), ['4-note.md'], 'board.txt and lanes.txt are not items');
  fs.rmSync(cwd, { recursive: true });
});

test('init prints last the one line that defines L, by the absolute path of lane.mjs, and a shell that runs it reaches the tool', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-shorthand-'));
  execFileSync('git', ['init', '-q', cwd]);
  const out = execFileSync(process.execPath, [path.join(HERE, 'lane.mjs'), 'init', '--cwd', cwd], { encoding: 'utf8', env: HERMETIC }).trim().split('\n');
  const line = out[out.length - 1];
  const m = /^L\(\) \{ node '(\/[^']+\/lane\.mjs)' "\$@"; \}$/.exec(line);
  assert.ok(m, line);
  assert.equal(fs.realpathSync(m[1]), fs.realpathSync(path.join(HERE, 'lane.mjs')));
  assert.ok(!line.includes('CLAUDE_SKILL_DIR'), 'only the skill loader expands that variable');
  const sh = spawnSync('bash', ['-c', `${line}; L help`], { encoding: 'utf8', env: HERMETIC });
  assert.equal(sh.status, 0, sh.stderr);
  assert.match(sh.stdout, /^usage: lane\.mjs init/);
  assert.equal(shorthandLine("/a b/it's/lane.mjs"), `L() { node '/a b/it'\\''s/lane.mjs' "$@"; }`, 'a quote in the path survives');
  fs.rmSync(cwd, { recursive: true });
});

test('retire refuses while an open item waits on the lane through after:, until: or blocks:, appends nothing and names the item; --force retires and warns', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-retire-'));
  const dir = path.join(cwd, 'coordinator');
  const res = (...a) => spawnSync(process.execPath, [path.join(HERE, 'lane.mjs'), ...a, '--cwd', cwd], { encoding: 'utf8', env: HERMETIC });
  res('init');
  fs.writeFileSync(path.join(dir, 'prompt-deny-floor-four.txt'), 'TASK deny-floor-four\n');
  fs.writeFileSync(path.join(dir, '189-hold.md'), 'HOLD worker-reset-after-needs-human the third engine lane waits\nafter: deny-floor-four\n');
  fs.writeFileSync(path.join(dir, '190-n.md'), 'NOTE rebase after it\nuntil: ok deny-floor-four\n');
  fs.writeFileSync(path.join(dir, '191-ef.md'), 'EFFORT floor the floor\nsize: S\npath: implement\nlanes: implement=deny-floor-four\n');
  const lanesTxt = () => (fs.existsSync(path.join(dir, 'lanes.txt')) ? fs.readFileSync(path.join(dir, 'lanes.txt'), 'utf8') : '');
  const refused = res('retire', 'deny-floor-four', 'session gone');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /open items wait on deny-floor-four[^]*#189 HOLD worker-reset-after-needs-human  after: deny-floor-four[^]*#190 NOTE  until: ok deny-floor-four[^]*retire --force/);
  assert.ok(!/191/.test(refused.stderr), "an EFFORT's lanes: key is not an edge");
  assert.equal(lanesTxt(), '', 'a refused retire appends nothing');
  assert.ok(fs.existsSync(path.join(dir, 'prompt-deny-floor-four.txt')));
  const forced = res('retire', 'deny-floor-four', 'session gone', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /^OK deny-floor-four \S+ retired: session gone\nwarning: still names deny-floor-four: #189 HOLD worker-reset-after-needs-human  after: deny-floor-four\nwarning: still names deny-floor-four: #190 NOTE  until: ok deny-floor-four\n/);
  assert.match(forced.stdout, /coordinator\/191-ef\.md: lanes: none/);
  assert.equal(lanesTxt().split('\n').filter(Boolean).length, 1, 'still exactly one OK line');
  fs.rmSync(cwd, { recursive: true });
});

test('retire prints the re-issue block from the worktree the session sat in: its commits, its uncommitted files, its report tail; with no git it prints (unreadable) and still retires', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-reissue-home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-reissue-')));
  const wt = `${repo}-wt`;
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('worktree', 'add', '-q', '--detach', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  execFileSync('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'b.txt']);
  execFileSync('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'half the lane']);
  fs.writeFileSync(path.join(wt, 'wip.ts'), 'x\n');
  const setup = () => {
    fs.mkdirSync(path.join(repo, 'coordinator', 'closed'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'coordinator', 'prompt-grid.txt'), 'TASK grid\nbuild the grid\n');
    const dir = path.join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'sess-grid.jsonl'), [
      { type: 'user', sessionId: 'sess-grid', timestamp: stamp, cwd: wt, origin: { kind: 'human' }, message: { content: 'TASK grid\nbuild the grid\n' } },
      { type: 'assistant', sessionId: 'sess-grid', timestamp: stamp, cwd: wt, message: { content: [{ type: 'text', text: 'working' }], stop_reason: 'tool_use' } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  const retire = (env) => spawnSync(process.execPath, [path.join(HERE, 'lane.mjs'), 'retire', 'grid', 'session gone', '--cwd', repo], { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: '', ...env } });
  setup();
  const withGit = retire({});
  assert.equal(withGit.status, 0, withGit.stderr);
  const sha = execFileSync('git', ['-C', wt, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.match(withGit.stdout, new RegExp(`\\nre-issue: grid in_progress, worktree ${fs.realpathSync(wt)}\\n  uncommitted: wip\\.ts\\n  ahead of origin/main: ${sha} half the lane\\n  report: none yet\\n$`), withGit.stdout);
  fs.rmSync(path.join(repo, 'coordinator', 'lanes.txt'));
  setup();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-nogit-'));
  const noGit = retire({ PATH: bin });
  assert.equal(noGit.status, 0, noGit.stderr);
  assert.match(noGit.stdout, /\nre-issue: grid in_progress, worktree \S+\n  uncommitted: \(unreadable\)\n  ahead of the base: \(unreadable\)\n/, noGit.stdout);
  assert.match(fs.readFileSync(path.join(repo, 'coordinator', 'lanes.txt'), 'utf8'), /^OK grid \S+ retired: session gone\n$/);
  for (const d of [home, repo, wt, bin]) fs.rmSync(d, { recursive: true, force: true });
});

test('done closes a STEP with a dated evidence line and files it; note appends a dated UPDATE and leaves it open; neither touches a header key, and a lane name points at ok', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-done-'));
  const dir = path.join(cwd, 'coordinator');
  const res = (...a) => spawnSync(process.execPath, [path.join(HERE, 'lane.mjs'), ...a, '--cwd', cwd], { encoding: 'utf8', env: HERMETIC });
  res('init');
  fs.writeFileSync(path.join(dir, '198-deploy.md'), 'STEP deploy first\nblocks: drill-ins\n');
  fs.writeFileSync(path.join(dir, '199-pick.md'), 'DECIDE merge or rebase?\nsource: user 09:10\n\nthe options\n');
  fs.writeFileSync(path.join(dir, 'prompt-grid.txt'), 'TASK grid\n');
  const noted = res('note', '199', 'user leans rebase');
  assert.equal(noted.status, 0, noted.stderr);
  assert.match(noted.stdout, /^UPDATE \d{4}-\d\d-\d\d \d\d:\d\d user leans rebase\n$/);
  const pick = fs.readFileSync(path.join(dir, '199-pick.md'), 'utf8');
  assert.match(pick, /^DECIDE merge or rebase\?\nsource: user 09:10\n\nthe options\nUPDATE \d{4}-\d\d-\d\d \d\d:\d\d user leans rebase\n$/);
  assert.deepEqual(parseItem('199-pick.md', pick).bad, [], 'the header keys are untouched');
  const done = res('done', '#198', 'deployed 536fc3d, health green');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^DONE \d{4}-\d\d-\d\d \d\d:\d\d deployed 536fc3d, health green\ncoordinator\/closed\/198-deploy\.md\n$/);
  assert.ok(!fs.existsSync(path.join(dir, '198-deploy.md')));
  assert.match(fs.readFileSync(path.join(dir, 'closed', '198-deploy.md'), 'utf8'), /^STEP deploy first\nblocks: drill-ins\n\nDONE \d{4}-\d\d-\d\d \d\d:\d\d deployed 536fc3d, health green\n$/);
  assert.deepEqual(readStore(cwd).items.map((i) => i.id), [199], 'note left 199 open, done filed 198');
  const lane = res('done', 'grid', 'shipped');
  assert.equal(lane.status, 1);
  assert.equal(lane.stderr.trim(), 'done: grid is a lane; a lane closes with lane.mjs ok grid <evidence…>');
  assert.match(res('note', '404', 'x').stderr, /no open item #404/);
  fs.rmSync(cwd, { recursive: true });
});

test('snooze: a date after today hides the row and CTX counts it; today or yesterday shows it again; delta reports the vanish and the return; snooze Nd sets the date and logs the why; a bad date is a fault', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-snooze-'));
  const dir = path.join(cwd, 'coordinator');
  const run = (...a) => execFileSync(process.execPath, [path.join(HERE, 'lane.mjs'), ...a, '--cwd', cwd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: HERMETIC }).trim();
  const fails = (...a) => {
    try {
      run(...a);
    } catch (e) {
      return `${e.stdout}${e.stderr}`.trim();
    }
    throw new Error(`expected failure: ${a.join(' ')}`);
  };
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  run('init');
  fs.writeFileSync(path.join(dir, '1-ship.md'), 'DECIDE ship it?\n');
  fs.writeFileSync(path.join(dir, '2-note.md'), 'NOTE a note\n');
  const row = 'DECIDE  #1  ship it?';
  assert.match(run('delta'), /· first · you 1 · live 0 · mine 1$/);
  assert.equal(run('set', '1', 'snooze', day(1)), `coordinator/1-ship.md: snooze: ${day(1)}`);
  let board = run('board').split('\n');
  assert.ok(!board.includes(row), 'tomorrow hides the row');
  assert.match(board.at(-1), /^CTX {5}coordinator \S+ {2}\S+: 0 lanes {2}items 1 {2}snoozed 1(?: {2}|$)/, 'CTX counts it; a live watch or coordinator may follow');
  assert.match(run('delta'), /· -DECIDE #1 ship it\? · you 0 · live 0 · mine 1$/, 'the vanish is a delta row');
  run('set', '1', 'snooze', day(-1));
  board = run('board').split('\n');
  assert.ok(board.includes(row), 'yesterday shows it again');
  assert.match(board.at(-1), /^CTX {5}coordinator \S+ {2}\S+: 0 lanes {2}items 2(?: {2}|$)/);
  assert.ok(!board.at(-1).includes('snoozed'));
  assert.match(run('delta'), /· \+DECIDE #1 ship it\? · you 1 · live 0 · mine 1$/, 'the return is a delta row, not a woke line');
  assert.match(run('snooze', '1', '3d', 'waiting on legal'), new RegExp(`^coordinator/1-ship\\.md: snooze: ${day(3)}\\nsnoozed \\d\\d:\\d\\d until ${day(3)}: waiting on legal$`));
  assert.match(fs.readFileSync(path.join(dir, '1-ship.md'), 'utf8'), new RegExp(`^DECIDE ship it\\?\\nsnooze: ${day(3)}\\n\\nsnoozed \\d\\d:\\d\\d until ${day(3)}: waiting on legal\\n$`));
  assert.ok(!run('board').split('\n').includes(row));
  assert.equal(run('snooze', '1', '0d'), `coordinator/1-ship.md: snooze: ${day(0)}`, '0d writes today and no body line');
  assert.ok(run('board').split('\n').includes(row), 'today is awake');
  assert.equal(run('check'), '', 'a snoozed item is neither a fault nor satisfied');
  assert.match(fails('set', '2', 'snooze', 'next week'), /set: #2 snooze: 'next week' is not a date YYYY-MM-DD/);
  fs.writeFileSync(path.join(dir, '2-note.md'), 'NOTE a note\nsnooze: 2026-13-01\n');
  assert.match(fails('check'), /^BAD {5}#2 snooze: '2026-13-01' is not a date YYYY-MM-DD$/m);
  fs.rmSync(cwd, { recursive: true });
});

test('new takes the headline and the body from files the shell never parses, and argv refuses a backtick or $( with nothing written', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-headfile-'));
  const dir = path.join(cwd, 'coordinator');
  const run = (...a) => execFileSync(process.execPath, [path.join(HERE, 'lane.mjs'), ...a, '--cwd', cwd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: HERMETIC }).trim();
  const fails = (...a) => {
    try {
      run(...a);
    } catch (e) {
      return String(e.stderr).trim();
    }
    throw new Error(`expected failure: ${a.join(' ')}`);
  };
  run('init');
  fs.writeFileSync(path.join(cwd, 'head.txt'), 'deploy with `ops/update.sh` after $(date)\nignored second line\n');
  fs.writeFileSync(path.join(cwd, 'body.md'), 'why: the checkout is behind\n`just update` is the user\'s\n');
  assert.equal(run('new', 'STEP', '--head-file', 'head.txt', '--body-file', 'body.md'), 'coordinator/1-deploy-with-ops-update-sh-after-date.md');
  assert.equal(fs.readFileSync(path.join(dir, '1-deploy-with-ops-update-sh-after-date.md'), 'utf8'), 'STEP deploy with `ops/update.sh` after $(date)\n\nwhy: the checkout is behind\n`just update` is the user\'s\n', 'the file carries the punctuation the shell never saw');
  const before = fs.readdirSync(dir).length;
  assert.match(fails('new', 'STEP', 'deploy with `ops/update.sh`'), /carries a backtick, which a shell runs as a command.*--head-file FILE/);
  assert.match(fails('new', 'NOTE', 'run $(whoami) later'), /carries \$\(/);
  assert.match(fails('new', 'STEP', 'x', '--head-file', 'head.txt'), /from --head-file or from argv, not both/);
  assert.match(fails('new', 'STEP', '--head-file', 'missing.txt'), /--head-file missing\.txt: ENOENT/);
  assert.equal(fs.readdirSync(dir).length, before, 'a refused headline writes nothing');
  fs.rmSync(cwd, { recursive: true });
});

test('new never reads stdin unless asked: a pipe held open does not block it, and --stdin files the body the pipe carries', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-stdin-'));
  execFileSync(process.execPath, [path.join(HERE, 'lane.mjs'), 'init', '--cwd', cwd], { env: HERMETIC, stdio: 'ignore' });
  const held = spawn(process.execPath, [path.join(HERE, 'lane.mjs'), 'new', 'STEP', 'press Stop', '--cwd', cwd], { env: HERMETIC, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  held.stdout.on('data', (d) => (out += d));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('blocked'), 5000);
    held.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  held.stdin.end();
  if (code === 'blocked') held.kill();
  assert.equal(code, 0, 'the process exits with stdin still open');
  assert.equal(out.trim(), 'coordinator/1-press-stop.md');
  assert.equal(fs.readFileSync(path.join(cwd, 'coordinator', '1-press-stop.md'), 'utf8'), 'STEP press Stop\n');
  const piped = spawnSync(process.execPath, [path.join(HERE, 'lane.mjs'), 'new', 'NOTE', 'from the pipe', '--stdin', '--cwd', cwd], { env: HERMETIC, input: 'the body\nsecond line\n', encoding: 'utf8' });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(fs.readFileSync(path.join(cwd, 'coordinator', '2-from-the-pipe.md'), 'utf8'), 'NOTE from the pipe\n\nthe body\nsecond line\n');
  const dash = spawnSync(process.execPath, [path.join(HERE, 'lane.mjs'), 'new', 'NOTE', 'dash', '--body', '-', '--cwd', cwd], { env: HERMETIC, input: 'dash body\n', encoding: 'utf8' });
  assert.equal(fs.readFileSync(path.join(cwd, 'coordinator', '3-dash.md'), 'utf8'), 'NOTE dash\n\ndash body\n', dash.stderr);
  fs.rmSync(cwd, { recursive: true });
});

test('the effort flow on the CLI: new EFFORT, scout, set size and path, prompt --effort --from writes the lane onto the effort, the sizing refusals, relay, did, sync through gh, init --hook', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-effort-'));
  const dir = path.join(cwd, 'coordinator');
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin);
  // a gh that answers the issues endpoint from a file, so sync runs end to end
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nn=$(echo "$2" | sed 's|.*/||')\ncat "${cwd}/gh-$n.json"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(cwd, 'gh-14.json'), '{"number":14,"state":"open","title":"slot key naming","closed_at":null,"merged_at":null,"pr":false}\n');
  const env = { ...HERMETIC, PATH: `${bin}:${process.env.PATH}` };
  const run = (...a) => execFileSync(process.execPath, [path.join(HERE, 'lane.mjs'), ...a, '--cwd', cwd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  const fails = (...a) => {
    try {
      run(...a);
    } catch (e) {
      return String(e.stderr).trim();
    }
    throw new Error(`expected failure: ${a.join(' ')}`);
  };
  run('init');
  assert.equal(run('init', '--hook'), HOOK_JSON);
  assert.equal(run('new', 'EFFORT', 'legend', 'Reserved should read Requested', '--on', 'issue 14', '--source', 'user 09:57'), 'coordinator/1-legend.md');
  assert.match(fails('new', 'EFFORT'), /EFFORT needs a name/);
  assert.match(run('scout', 'legend'), /^Read-only; edit nothing\. Repo .*\. Effort legend: Reserved should read Requested/);
  assert.match(fails('scout', 'nope'), /no open EFFORT nope/);
  assert.match(run('board'), /EFFORT  legend  scoping: scout, then the card  #1/);
  assert.match(run('delta'), /· first · you 0 · efforts 1 · live 0 · mine 0$/);
  assert.equal(run('set', 'legend', 'size', 'M'), 'coordinator/1-legend.md: size: M');
  assert.match(fails('set', 'legend', 'size', 'XL'), /size: 'XL' is not S, M or L/);
  assert.match(fails('set', '1', 'colour', 'red'), /key is one of/);
  assert.match(fails('prompt', 'leg-research', '--kind', 'research', '--effort', 'legend', '--ask', 'a', '--done', 'd'), /effort legend has no path: rule the card first/);
  assert.equal(run('set', '#1', 'path', 'research implement'), 'coordinator/1-legend.md: path: research implement');
  assert.match(fails('prompt', 'leg-proto', '--kind', 'prototype', '--effort', 'legend', '--ask', 'a', '--done', 'd'), /kind prototype is not on the path of legend/);
  assert.match(fails('prompt', 'leg-build', '--kind', 'implement', '--effort', 'legend', '--ask', 'a', '--done', 'd'), /an M effort's implement lane needs --gate/);
  fs.writeFileSync(path.join(cwd, 'draft.md'), '# draft\n\nAsk: read the legend\n  and its consumers\nDone when: the card names the word\nFences: read-only\n');
  assert.equal(run('prompt', 'leg-research', '--kind', 'research', '--effort', 'legend', '--from', 'draft.md', '--pointers', 'gh issue view 14'), 'coordinator/prompt-leg-research.txt\ncoordinator/1-legend.md: lanes: research=leg-research');
  const text = fs.readFileSync(path.join(dir, 'prompt-leg-research.txt'), 'utf8');
  assert.equal(promptField(text, 'Ask'), 'read the legend and its consumers');
  assert.equal(promptField(text, 'Pointers'), 'gh issue view 14', 'a flag wins over the file');
  assert.equal(promptField(text, 'Effort'), 'legend');
  assert.match(text, /Claim #14 first/, 'the effort issue reaches the protocol');
  assert.match(text, /Leave #14 open: a later lane of this effort closes it, not you\./, 'implement still follows on the path');
  assert.equal(parseItem('1-legend.md', fs.readFileSync(path.join(dir, '1-legend.md'), 'utf8')).lanes.research, 'leg-research');
  assert.match(fails('prompt', 'leg-research-2', '--kind', 'research', '--effort', 'legend', '--ask', 'a', '--done', 'd'), /already has a research lane: leg-research/);
  assert.match(run('board'), /RUN     prompt-leg-research\.txt  research  the card names the word\n/);
  assert.match(run('board'), /EFFORT  legend M  leg-research \(research\) run it  #1/);
  assert.match(fails('relay', 'leg-research', 'go on'), /leg-research is not_found; no session to send to/);
  assert.match(fails('relay', 'nope', 'go on'), /no prompt-nope\.txt/);
  assert.match(run('did', 'legend', 'wrote the ruled card into #14'), /^DID legend \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ wrote the ruled card into #14$/);
  assert.match(fs.readFileSync(path.join(dir, 'lanes.txt'), 'utf8'), /^DID legend /m);
  assert.equal(run('sync'), '#14: open (issue) slot key naming');
  assert.equal(fs.readFileSync(path.join(dir, 'github.txt'), 'utf8'), 'issue 14 OPEN slot key naming\n');
  assert.equal(run('sync'), 'github.txt: 1 number, no change');
  fs.writeFileSync(path.join(cwd, 'gh-14.json'), '{"number":14,"state":"closed","title":"slot key naming","closed_at":"2026-09-09T10:00:00Z","merged_at":null,"pr":false}\n');
  assert.equal(run('sync'), '#14: open -> closed (issue) slot key naming');
  assert.equal(fs.readFileSync(path.join(dir, 'github.txt'), 'utf8'), 'issue 14 CLOSED 2026-09-09T10:00:00Z slot key naming\n');
  assert.deepEqual(readStore(cwd).items.map((i) => i.file), ['1-legend.md'], 'github.txt is not an item');
  assert.match(fails('new', 'EFFORT', 'legend', 'again'), /legend is already EFFORT #1/);
  assert.match(fails('new', 'NOTE', 'n', '--size', 'X'), /size: 'X' is not S, M or L/);
  assert.deepEqual(readStore(cwd).items.map((i) => i.file), ['1-legend.md'], 'a faulty item is refused, not written');
  assert.match(fails('did', 'ghost', 'x'), /no open EFFORT named ghost/);
  assert.match(run('retire', 'leg-research', 'exited'), /removed coordinator\/prompt-leg-research\.txt\ncoordinator\/1-legend\.md: lanes: none\nre-issue: no session took it$/);
  assert.match(run('board'), /EFFORT  legend M  write prompt research  #1/, 'a retired lane leaves the effort where it was');
  assert.match(run('prompt', 'leg-research-2', '--kind', 'research', '--effort', 'legend', '--ask', 'a', '--done', 'd', '--fences', 'read-only'), /lanes: research=leg-research-2$/);
  fs.rmSync(cwd, { recursive: true });
});

