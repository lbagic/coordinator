NOTE gate-b dispositions 11:58: opens 2,3,4,7 to gate-amendments; 5,6 accepted; 8 unmeasured; PR-8 full-mode only
until: ok docs-apply-r51
source: integration-gate-b/REPORT.md

MINE integration-gate-b dispositions, coordinator 2026-09-07 11:58: opens 2, 3, 4, 7 ruled and handed to gate-amendments (every close against an artifact gates; conflict_only advances on clean merge with probe_only meaning no command ran; skipped reserved to off; test-db-setup.sh replays every migration >= 011 after the seed); open 5 (schemas.ts/projects.ts) accepted; open 6 (one rev-parse per project on GET /api/projects, tip as-of-load) accepted, backlog note; open 8 (gate at two slots, a false red from PR-10 flake) stays unmeasured until rerun 4 or a two-slot run; PR-8 counts only full-mode advances, never probe_only — rerun 4 prompt carries it; next docs lane transcribes all of this as dated D28 notes
