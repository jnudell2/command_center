# Phase 1 lifecycle checkpoint — 2026-07-21

- Preserved the complete pre-migration worktree in commit `0b01e46001ddd9b0214c714c758b90c9b71ffbbe` and pushed it to `origin/cto/card-lifecycle-remediation-2026-07-21`.
- Removed Command Center-owned Codex app-server launch, thread start/resume, turn start, task-open, and automatic PM-pulse delivery paths.
- Added one additive assignment and event ledger with stable assignment keys, one bound execution owner, hashed callback capabilities, idempotent event IDs, replay-safe transitions, and local stale-heartbeat attention flags.
- Retired the legacy Codex-task write endpoints with HTTP 410 responses. Prepared assignments do not move cards into working states.
- Validated migration 12 against a transactionally copied live database: `integrity_check=ok`, no foreign-key violations, 26/26 legacy Codex task receipts imported, and no active owner collision.
- Exercised the copied runtime through prepare, duplicate prepare, accepted, started, completed, and callback replay. The duplicate reused one assignment; the terminal result appeared on the originating card in `back_for_review`.

No company work state or external system was changed during this checkpoint.
