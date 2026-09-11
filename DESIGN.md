# coordinator: design

Signed off 2026-09-09 in a two-round grilling (round 1 revised after the research, round
2 accepted as recommended). The evidence base is two days of the previous coordinator on
one production repository (three coordinator transcripts, twelve worker transcripts, the
ledger), mined by six read-only research agents.

## 1. What changes, in one paragraph

Every ask becomes an **effort** that starts with context and a decision on the next step.
The coordinator's scout scopes it (size S, M or L; facts; lettered decisions with data
beside them; a path of components), the user rules the card, and the tool writes one
prompt per component from a template that carries the component's whole protocol, so a
bare paste works and no skill is required. The ruled design of an M or L effort lives on a
GitHub issue the worker reads; S efforts run from the prompt alone. Prompt fields grow to
2000 characters and may come from a file. Rulings travel from the coordinator to the
worker session by SendMessage, verbatim and addressed, so nothing is pasted by hand.
Items can name a PR or issue and close themselves when GitHub says merged or closed; the
watch polls GitHub once a minute and prints merges as transitions. Issue bookkeeping on
the user's word is the coordinator's, logged. Everything else stays: the human is the
only merger and decider, prompts carry intent and fences, the ledger is plain files, a
fence breach is OK plus NOTE.

## 2. The state machine

```
EFFORT   ask ─ scoping (scout, card) ─ scoped (size, decisions) ─ ruled (path) ─ lanes ─ done
size S   path: implement                         no issue; the prompt carries everything
size M   path: research | prototype | alternative, then implement with a build gate
         one issue; its body is the ruled card in ticket shape
size L   path: map, then one lane per ticket, each on: issue N
lane     research | scoping | prototype | implement | alternative | review | map
         written by `L prompt --kind`; the template carries the protocol
```

An effort is `scoping` until its card has a `size:`, `scoped` until it has a `path:`, then
it walks the path: for each kind in order, no lane yet means "write prompt <kind>", a lane
means the lane's own state (run, live, answer, verify, re-issue), a verified implement
lane with an open PR means "merge is yours", and when every kind is verified and every PR
merged the effort is done: with an open `on: issue` it asks for the close-out (resolution
comment, close, gist line), otherwise it prints on the `MINE file:` row.

## 3. Rulings

### Round 1, revised after the research

1. **EFFORT is a kind.** `EFFORT <name> <headline>`, keys `size:`, `path:`, `lanes:`,
   `on:`. The body is the scope card. A LANE item closes the moment its prompt exists,
   which loses the card after the first lane of a multi-lane effort; the last day's three
   scope cards were written as LANE items for lack of anything better.
2. **Components are templates in the tool.** `L prompt <name> --kind K` for K in
   research, scoping, prototype, implement, alternative, review, map. Each template fixes
   the standing fences, the protocol paragraph, what the REPORT carries and what the
   coordinator verifies. The user may launch under any skill; the tool names none. Bare
   paste performed the same as a slash launch on every measured axis (duration, human
   turns, REPORT compliance, protocol discovery): the implement skill's preamble never
   mentions wayfinding, every worker read the repository's own tracker doc on its own.
   `scoping` is a lane kind only when the scout cannot settle the ask; the coordinator's
   own scout scopes every effort first (used once, three efforts in about two minutes
   each, ruled "go 1/2/3").
3. **Sizing is a standing table** (section 2). `L prompt` enforces it: `--gate` on an S
   effort is refused, `implement` on an M effort without `--gate` is refused, a kind
   outside the effort's path is refused (`--force` overrides, and says so in the file).
4. **The ruled design lives on GitHub for M and L.** The ticket body already carried a
   design the fields never could (one ticket held the ruled design, Done when, fences and a
   reference in a few thousand characters), and workers read tickets whatever the launch skill. S
   efforts get no issue; the prompt is enough (the last morning's three S lanes).
   The coordinator writes the issue from the ruled card; the user reviews it before the
   first lane. One issue spans the whole effort, so the lane that closes it is the one on
   the path's last leg: a research leg followed by an implement leg answers on the issue
   and leaves it open (issue 4 was closed by the research lane and reopened by hand). Local kinds stay local: DECIDE answers arrived in chat (17) or inside
   worker sessions (12), never on GitHub; STEP, NOTE, HOLD, LANE are the coordinator's
   own bookkeeping. IDEA takes `on: issue N` when it is repo work, so it closes itself
   (one IDEA went stale because nothing reconciled it).
5. **The RUN row names the kind and the gate, never a skill.** The launch is
   `claude -n <name> "$(cat coordinator/prompt-<name>.txt)"`, the prompt handed over as
   the session's first argument so nothing is pasted and the prompt bar shows the lane.
   The line is also the one thing a peer message may carry that adopts a lane, so the
   coordinator can start one by `SendMessage` instead of the user typing it.
   Prompt files live in the store beside the items; one at the repository root, where
   earlier ledgers put them, is still read.

### Round 2, accepted as recommended

6. **Cap 2000 per field, no total cap, and `--from FILE`.** 62 prompt calls in two days,
   40 refused, every refusal the 500 cap, overages of 1 to 150 characters; the median Ask
   was 495. `--from` reads the five fields as `Label:` paragraphs from a file the
   coordinator wrote with the Write tool, so the text never sits in a Bash command line,
   which is what the auto-mode classifier reads (three prod-probe prompts had to be
   written by hand for that reason).
7. **One issue per M or L effort, none for S** (ruling 4).
8. **Sessions and rulings.** `L who` prints lane, session name, tty, status, idle and cwd
   (registry pid to tty is one to one, verified live). Rulings travel by SendMessage from
   the coordinator to the lane's session, the user's line quoted verbatim, headed
   `TO <lane>`, logged as `SENT` in lanes.txt; the user pastes nothing. Every template
   carries the address rule: an instruction headed `TO` another lane is not yours, say so
   and stop; and for gated lanes: build arrives as a `TO` message, never ask for it
   through a question tool. A lane that stops at its gate ends its report with the Gate
   sentence, and the board reads it: never a CLOSE row, an ANSWER row until the word is
   relayed and a LIVE row after, so the session is kept for the word it is waiting on.
   Two of 32 hand-offs were misrouted (two peer names one
   transposition apart, live seventy seconds apart); one went unnoticed 44 minutes and left a
   lane at its gate for seven and a half hours; one gate broke because the worker asked
   itself through AskUserQuestion.
9. **Reality checks.** `on: pr N | issue N` on any item; `until: merged N | closed N`
   beside `until: ok | prompt`. `L sync` asks GitHub about every number an open item or a
   verified report names and writes `coordinator/github.txt`; the watch does the same
   once a minute and prints `merged` and `closed` as transitions; the board reads only
   the file, so the fold stays pure. Silent merges were noticed 39 minutes to five hours
   late; announced ones in one to three minutes; 3 of 21 numbered open items were stale.
10. **Issue bookkeeping is the coordinator's on the user's word**, logged as `DID` in
    lanes.txt: effort issue create and edit, resolution comment, close, gist line, labels,
    blocked-by edges. Never a PR, a review, a merge, code. 25 such writes in two days,
    none while a worker held the lane; "one-off" was the coordinator's own framing every
    time, the user never objected. `goals.md` gets the line.
11. **`research --runner`** bakes the production read route into the fences: the worker
    writes a read-only script in its scratchpad, the user runs it with `!` and tees to a
    file, the worker reads the file; two passes are normal. That route resolved four
    tickets.
12. **A PR, a merge or a CI state is claimed only with `gh` output in the same turn.**
    The user caught two unverified claims.
13. **SKILL.md stays one screen**: the hook JSON moves to `L init --hook`, the scout
    prompt to `L scout <effort>`.

## 4. File formats

### Items (unchanged unless named)

Line 1 `KIND [<name>] <headline>`; header keys to the first blank line; body after.
New kind `EFFORT <name> <headline>`. New keys, any kind unless said:

- `size: S|M|L` (EFFORT)
- `path: <kinds>` (EFFORT), kinds from the seven, in order
- `lanes: <kind>=<lane> …` (EFFORT), maintained by `L prompt --effort`
- `on: pr <n> | issue <n>`, a GitHub number the item is about; `L sync` follows it
- `until: merged <n> | closed <n>`, closes the item when github.txt says so

### `coordinator/lanes.txt`

`OK <lane> <time> <evidence>` as before, `<time>` now an ISO instant in whole seconds
(`2026-09-10T08:31:00Z`; the local `HH:MM` of earlier ledgers still parses and compares
by clock). An OK is fresh when its instant is the lane's latest event. New tags, one
line each, append-only: `SENT <lane> <time> <text>` (a ruling relayed) and
`DID <effort> <time> <what>` (a GitHub act by the coordinator). `RUN` lines are read and
ignored.

### `coordinator/github.txt`

Written by `L sync` and the watch, read by the board: one line per number,
`pr|issue <n> OPEN|CLOSED|MERGED <iso time> <title>`. Missing or stale lines mean "not
known"; an `until: merged` with no line stays open.

### `coordinator/goals.md`

Never parsed; the session reads it, the page folds it at the top. One sentence of what
done looks like, then `now` (ranked, order is precedence), `never` (the coordinator
refuses and names the line), `ask` (a DECIDE first), `delivery` (route, checks, who
merges). The user writes it; the coordinator proposes one line at a time. A line is a
rule, never a reading. The shape is the intersection of the goals, charter and brief
files across the user's repositories: an end state, a ranked now, tiered boundaries and
a delivery route recur in every one; values and precedence collapse into the ranking.

### Prompt files

```
TASK <name>
Kind: <kind> [gate] [runner] [forced]
Effort: <effort>            (when written with --effort)

Ask: …
Why now: …
Done when: …
Fences: …
Pointers: …

<protocol paragraph of the kind: standing fences, the ticket when the effort has one,
 the address rule, the gate rule when gated>

prompt-*.txt and coordinator/ are never committed. Pointers are leads to read, not facts:
verify before building on them.

Your last message, headed exactly as shown:
REPORT <name>
<the kind's REPORT keys>
```

Fields are at most 2000 characters, one paragraph each; a `file:line` citation and a
Pointers token naming an item id are still refused.

## 5. Commands added or changed

- `prompt <name> --kind K [--effort E] [--gate] [--runner] [--force] [--from FILE | --ask … --done … …]`
- `new EFFORT <name> <headline> [--size S|M|L] [--path "…"] [--on "issue N"]`
- `new KIND [name] --head-file FILE [--body-file FILE]`: the headline is the file's first line and the body the other file's text, so neither passes through a shell; an argv headline carrying a backtick or `$(` is refused
- `set <id|name> <key> <value>`: rewrite one header key of an item
- `sync`: refresh `github.txt` from GitHub and print what changed
- `who [<lane>] [--all]`: session name, tty, status, idle, cwd per lane that holds something
- `resume`: per live lane its worktree (the session's cwd), uncommitted files, commits ahead of the base and report tail; per open STEP and DECIDE its last dated line; a git read that fails prints `(unreadable)`
- `relay <lane> <text…>`: append `SENT`, print the addressed message and the session to send it to
- `did <effort> <what…>`: append `DID`
- `scout <effort>`: print the scout prompt for the Agent call
- `init --hook`: print the Notification hook JSON
- `watch [--gh-poll MS]`: as before, plus GitHub transitions
- `retire <name> <why> [--force]`: as before, and the lane leaves its effort's `lanes:` key; refused while an open item's `after:`, `until:` or `blocks:` names the lane, since the retire's OK would satisfy it (`--force` retires and warns); after the OK it prints a `re-issue:` block from the worktree the session sat in, the same lines `resume` prints, and a git read that fails prints `(unreadable)` without failing the retire

## 5b. The hand-off

Past 350K of the session's own context the coordinator starts looking for a hand-off; the board prints the HANDOFF row on the first turn with nothing unverified, and that row is the moment to hand off: everything is on disk, `handoff.md` only for what no item holds. The board is
the only place it prints, and the row carries no context figure so a delta reports it once
rather than on every turn the context grows. `HANDOFF_AT` is the one constant; a lane
result that is neither unlaunched nor in progress and carries no fresh OK is the
unverified work that holds the moment back.

## 6. What is out

No migration tool: every change is additive and an older ledger parses unchanged. A LANE
item holding a scope card is re-filed as an EFFORT by hand. No `L send`: the
tool cannot message a session; the coordinator sends what `relay` prints. No headline
scraping for numbers: an item is checked against GitHub only through `on:` and `until:`.
No effort node in the page graph: an effort is a row and an item with its own filter toggle; the graph draws only what waits on what.
