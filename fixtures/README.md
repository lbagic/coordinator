# fixtures

`store/` is a good ledger: a `coordinator/` store with sixteen open items, one closed item, a `lanes.txt` of verified lanes and a `github.txt`, plus, inside `coordinator/`, the two prompt files (`prompt-gate-amendments.txt`, `prompt-scratch-write-grant.txt`) that its items name. `node lane.mjs board --cwd fixtures/store` renders it with zero BAD rows and `node lane.mjs check --cwd fixtures/store` exits 0. `lane.test.mjs` and `page.test.mjs` read it with their own lane results and pin its exact row count and several rows, so a change here is a test change; README's "Try it" points at the same store.

`store-bad/` is the same ledger with every fault the design names planted in it, one fault (or one cluster) per file; `check` exits 1 on it and the tests assert each fault's row.
- `1-psql-ruling.md` and `closed/1-psql-ruling.md`: the same id open and closed at once; its `until: ok docs-apply-r51` names a lane no item and no prompt file knows.
- `6-dup.md` and `6-floor-and-sources.md`: two files minted with id 6.
- `20-hold-launched.md`: a HOLD on `scratch-write-grant` after that lane has already launched; its `after:` closes a cycle with #6.
- `21-typo.md`: a header line with an unknown key (`block:` for `blocks:`) and an `until:` that is none of the four allowed forms.
- `22-a.md` and `23-b.md`: two LANE items whose `after:` lines form a cycle.
- `24-unknown-kind.md`: a first word (`TODO`) that is not a kind.
- `25-no-head.md`: a DECIDE with no headline.
- `26-bad-effort.md`: an EFFORT with every key wrong: `size: XL`, a `path:` naming a non-lane kind, a `lanes:` entry that is not `<kind>=<lane>`, a `lanes:` kind that is not on the path, a lane name nothing knows, and `on: ticket 5`.
- `27-sized-note.md`: a NOTE carrying `size:`, which only an EFFORT may.
- `lanes.txt`: a `HOLD old-lane …` line where only `OK <lane> <time> <evidence>` lines may stand.
- `github.txt`: `pr 12 DONE`, a state that is not OPEN, CLOSED or MERGED.

The names inside both stores (lane names, decision numbers, file paths, people and tool names in the item bodies) come from an early private project of the author and mean nothing outside it; they are kept only because the tests pin the row shapes they produce.
