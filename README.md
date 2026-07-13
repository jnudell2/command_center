# Serent Command Center

Jake's cache-first Serent work home. The browser UI runs at `http://localhost:3000/`; a localhost-only Node runner owns SQLite state, source refreshes, document persistence, and review-gated Codex work at `http://127.0.0.1:4318/`.

## Start and stop

Run `scripts/start-serent-tend.ps1`. The launcher verifies that both ports belong to Command Center before reporting readiness. Run `scripts/stop-serent-tend.ps1` to stop only the processes recorded for this app.

The interactive launcher uses Vinext development mode because the in-app browser currently blocks the production server's inline hydration bootstrap. This is a local runtime workaround, not a deployment model.

## Safety model

- The first render reads cached local state only.
- Source refreshes run independently and preserve cached results on failure.
- Ordinary agent work is read-only and cannot change email, calendar, Box, Guru, or ClickUp.
- `Done in ClickUp` is the only allowlisted external action. It requires an explicit UI action and verified task readback before the local card closes.
- Browser mutations require the Command Center request marker and the expected localhost origin.
- Notes are persisted to SQLite and Markdown using atomic file replacement.

## Local state and recovery

Runtime state lives under `data/` and `.runtime/`; both are intentionally excluded from Git. Before risky database or migration work, stop the app and copy `serent-tend.sqlite` together with any `-wal` and `-shm` files to a backup directory. Restart through the launcher and verify `/api/health` plus `/api/bootstrap`.

## Validation

```text
npm run lint
npm test
```

`npm test` performs a production build, starts a temporary isolated runner, checks persistence and API contracts, and verifies the rendered shell.

## Main implementation files

- `app/page.tsx`: action inbox, documents, search, and workbench.
- `app/mail-workspace.tsx`: cached mail review and local draft editing.
- `app/calendar-workspace.tsx`: cached day-ahead calendar and local planning.
- `scripts/local-control-server.mjs`: SQLite, APIs, source refresh, and Codex lifecycle.
- `scripts/graph-mail.mjs`: read-only Outlook and calendar bridge.
