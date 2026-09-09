DECIDE gate worktree deps go stale: re-run setup_command every gate, setup_paths: opt-out, or defer? (rec: re-run now)
source: integration-gate-b/REPORT.md open 1

DECIDE integration worktree dependencies go stale (integration-gate-b open 1): setup_command runs only at provision, so a dependency-bumping merge is recorded red and repeats on every later close — re-run setup_command on every gate (correct, costs the install per close), only when the merge touches a path the declaration names under a new `setup_paths:` key (a D24 amendment; opt out of the cost, never the correctness), or leave it until a project with real dependencies turns the gate on? (coordinator recommends: re-run on every gate now, `setup_paths:` later as an opt-out; the toy installs in 991 ms; rerun 4 is unaffected)
