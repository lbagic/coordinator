# coordinator

A [Claude Code](https://claude.com/claude-code) skill that runs one session as the
project's front door. You bring asks to it; it scopes each one into an effort, you rule
the size and path, it writes the prompt for a worker session you launch yourself, tracks
that lane while it runs, and verifies what comes back against git and GitHub. It never
writes code and never reads a diff. Its whole state, prompts included, is plain files
under `coordinator/` at the repository root, excluded from git.

The design and the evidence behind it are in [DESIGN.md](DESIGN.md). The skill text the
coordinator session reads is [SKILL.md](SKILL.md). The rules the tool enforces are the
comment block at the top of [lane.mjs](lane.mjs), pinned by the tests.

## What it does

- Every ask becomes an `EFFORT`. A read-only scout writes a scope card: size (S, M, L),
  facts, each product decision as a lettered line with your pick, and a path of lane
  kinds. You rule the card once, in one numbered round.
- `lane.mjs prompt` writes one prompt file per lane from a kind template (research,
  scoping, prototype, implement, alternative, review, map). Five fields in your words,
  the kind's protocol, the report shape. It refuses citations, reused names, a gate on
  an S effort, an M implement without one.
- You launch each lane as its own Claude Code session with
  `claude -n <name> "$(cat coordinator/prompt-<name>.txt)"`. The tool finds the session from its
  transcript and reports it as live, stopped, stalled, finished, continued or exited.
  Sending that same line to an open session with `SendMessage` adopts the lane there;
  no other cross-session message does.
- Rulings travel to a worker by `lane.mjs relay`, then `SendMessage` to the session it
  names. Nothing is pasted by hand and the wording stays yours.
- Items can name a PR or issue (`on: pr N`, `until: merged N`) and close themselves when
  GitHub says so. `lane.mjs watch` polls GitHub once a minute.
- `lane.mjs launch` prints the launch line for every prompt not yet picked up, grouped so
  the fences of one block are disjoint — a shared path holds a prompt back, a bare file
  name two prompts happen to mention does not. Nothing launches by itself.
- `lane.mjs board` prints the ledger grouped by who acts next; `page.mjs --serve` renders
  it as a local web page. A gated lane that stopped at its gate is shown as waiting on
  your build word, never as a session to close.

## Requirements

- Claude Code 2.1 or later on macOS or Linux. The tool reads Claude Code's own session
  registry (`~/.claude/sessions/`) and transcripts (`~/.claude/projects/`) to know which
  session holds which lane, so it is coupled to that on-disk shape. Built and tested
  against 2.1.267.
- Node.js 20 or later; developed on 22.16.
- The `gh` CLI, authenticated, for `sync`, the watch's GitHub polling and the
  coordinator's issue bookkeeping.
- `jq`, for the Notification hook that `lane.mjs init --hook` prints.
- `ps` with `-o tty=` (macOS and Linux; busybox `ps` is not enough), used by `lane.mjs who`.

Windows is not supported. Run the coordinator from the repository's main checkout: the
store and the prompt files live there, and a worktree has neither.

## Install

With the skills CLI, into your user-level skills (it symlinks `~/.claude/skills/coordinator`):

```
npx skills add lbagic/coordinator -g
```

Or by hand:

```
git clone https://github.com/lbagic/coordinator ~/.claude/skills/coordinator
cd ~/.claude/skills/coordinator && npm test
```

SKILL.md finds the tool through `${CLAUDE_SKILL_DIR}`, so a project-level install under
`.claude/skills/` works too.

Then, in the repository you want to coordinate, open a Claude Code session and type
`/coordinator`. On a first run it creates `coordinator/goals.md` and asks you for the
goals; fill it in before anything else (see below).

For `notify` lines in the watch (a worker session asking for permission or attention),
install the hook `node lane.mjs init --hook` prints into that repository's
`.claude/settings.local.json`. Without it the watch prints lane and GitHub transitions
only.

## Writing goals.md

The coordinator holds every ask against this file, so it is the one thing worth writing
well. It is yours: the coordinator proposes a line and waits. Keep it to one screen. A
line is a rule, never a reading; dates, ids and evidence go in the DECIDE item the
ruling came from. Workers never see it (it is git-excluded); rules every session must
follow belong in the repository's `CLAUDE.md`.

```
# goals
Many small changes across the codebase this quarter without breaking production.

## now
- Error reporting: the API captures server errors, the web app stops reporting noise.
- Node analysis: ship the utilization columns and stop; one defect per PR.

## never
- Production and preprod databases are read-only for every lane.
- Merges are the user's, never a lane's.

## ask
- Auth middleware and routes: a DECIDE first, and the user reviews that diff before merge.
- Schema and contract changes under migrations/ and proto/.

## delivery
- Every lane in its own worktree under .claude/worktrees/<lane>, branched from origin/main.
- Checks scoped to the diff; never a repo-wide test or build.
- Babysit to CI green and every bot thread answered; the user merges.
```

- `now` is ranked; the order is the precedence when two lines collide.
- `never` lines make the coordinator refuse the ask and name the line.
- `ask` lines make the ask a DECIDE before any lane runs.
- `delivery` is what every prompt's Fences line is built from: the route, the checks,
  who merges.

## Try it without touching a repository

```
cd ~/.claude/skills/coordinator
npm test
node lane.mjs board --cwd fixtures/store
node lane.mjs check --cwd fixtures/store-bad   # exit 1, every fault kind
node page.mjs --serve --cwd fixtures/store
```

The fixtures are a real ledger from an early project, kept as a rendering and fault
corpus; the names in it mean nothing outside that project (see `fixtures/README.md`).
The board's last row, CTX, reads your own `~/.claude`: the context of the session you
run it from and the number of watches on the machine.

Past 350K of the session's own context the coordinator starts looking for a hand-off; the board prints the HANDOFF row on the first turn with nothing unverified, and that row is the moment to hand off: everything is on disk, `handoff.md` only for what no item holds. The row
carries no number, so the one line of what changed prints it once, on the turn the moment
arrives.

A headline or body with shell punctuation in it goes through files, never argv:
`lane.mjs new STEP --head-file head.txt --body-file body.md`. A shell runs a backtick or
`$(` inside a double-quoted argument before the tool sees it, so argv refuses both. A body
comes from `--body-file`, `--body`, or stdin under `--stdin` only: a pipe nobody closes
never blocks the tool.

## Layout

```
SKILL.md          what the coordinator session reads; one screen
DESIGN.md         the rulings and the evidence they rest on
lane.mjs          the tool: store, prompts, board, watch, GitHub sync, session lookup
page.mjs          the board as a self-contained HTML page, served or written once
lane.test.mjs     pins every rule in lane.mjs's header comment
page.test.mjs     pins the page's fold and rendering
fixtures/         a good store and a bad store for the tests and for trying the board
```

## Where things live on your machine

- `<repo>/coordinator/` is the ledger: one file per item, `lanes.txt` (append-only
  facts, ISO times), `github.txt` (last known GitHub state), `board.txt` (the last
  printed board), `goals.md`, optionally `handoff.md`, and `prompt-<name>.txt`, one per
  lane, never edited after launch. `init` adds `/coordinator/` and `/prompt-*.txt` to
  `.git/info/exclude`; a prompt file at the repository root (where older ledgers put
  them) is still read.
- `~/.claude/coordinator/notify.log` is where the Notification hook appends; the watch
  tails it. It is never rotated; truncate it whenever no watch is running.
- `~/.claude/coordinator/<the repo's absolute path, mangled>/board.html` is where
  `page.mjs` writes the page when not serving.

## License

MIT. See [LICENSE](LICENSE).
