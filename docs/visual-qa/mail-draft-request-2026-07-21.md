# Mail draft request QA receipt

Date: 2026-07-21 Pacific

Branch: `cto/intelligence-autonomy-ui-system-2026-07-21`

Mode: fixture mutations plus read-only live Mail inspection

## Acceptance result

- The old `Draft proposed reply` action is gone. `Request CEO draft` records one idempotent local request and never opens Open Work.
- Open Work promotion is a separate, explicitly labeled control. A dismissed or stale linked action cannot hijack drafting.
- The browser states plainly that it cannot invoke the native CEO / PM task because Codex exposes no host bridge.
- `Not requested`, `Requested`, `Draft ready`, and `Needs attention` have visible, accessible states.
- `Copy drafting request` produces the complete deterministic fallback packet only after a request exists.
- Capability-bound CEO / PM writeback creates the existing editable local draft, records provenance and freshness, and remains replay-safe.
- Draft request and writeback do not send mail, create an Outlook draft, launch Codex, poll a router, or change business-card state.

## Live read-only proof

The reported live GovWorX message rendered in Mail with `Not requested`, the host-bridge limitation, a separate Open Work control, and its cached message body. No draft-request button was clicked. Message identifiers, sender details, message content, and screenshots are intentionally excluded from this public repository.

After browser QA:

- `mail_draft_requests`: 0 live records
- target draft state: `none`
- target draft-request state: `not_requested`
- local runner: ready, 0 active jobs
- app: HTTP 200
- SQLite quick check: ok; foreign-key errors: none; schema 14 present

## Responsive and accessibility proof

- 1600px desktop, 1024px tablet, and 390px phone were reviewed in the running app.
- At 390px: document overflow false; Mail workbench overflow false.
- `Request CEO draft` and `Restore to Open Work` both measure 40px high; related Mail review controls use the same minimum target.
- `Request CEO draft` is a real button and the proposed-reply editor keeps its accessible label.
- No console error-level entries occurred during the reviewed interaction; only development connection and CSS hot-update messages were recorded.

## Visual receipts

The 1600px, 1024px, and 390px screenshots are retained locally under the ignored `outputs/visual-qa/mail-draft-request-2026-07-21/` folder. They are not committed because the GitHub repository is public and the read-only QA used a real message.

## Automated proof

- Production build: pass
- Full test suite: 52/52 pass
- Lint: 0 errors; 4 pre-existing unused legacy helper warnings
- Server syntax and `git diff --check`: pass

The fixture suite covers first request, duplicate-click reuse, missing capability rejection, successful CEO / PM writeback, writeback replay, draft autosave, Copy reply feedback, unchanged business work state, no external action, no local worker launch, stale dismissed action isolation, and explicit reuse of the canonical Open Work item.
