# Mail draft-first checkpoint — 2026-07-22

Status: validated protected-branch prototype. Main remains untouched.

## Product contract

Mail is a cache-first evidence and reply workspace. Every message visible in the active local Mail cache is eligible for one source-grounded proposed reply per exact content fingerprint. Drafting is a bounded review-only generative utility, not native task orchestration.

The utility may read the cached message/thread envelope, recipients, company mapping, accepted writing rules, linked notes, and the smallest relevant linked-work record. It may write only its local generation receipts, draft revisions, and Jake's explicit local edits. It cannot create or control a native Codex task, change a work item, create an Outlook draft, or send email.

## Implementation receipt

- Additive schema v15 preserves v14 request/writeback history and adds dedicated generation, event, fingerprint, pending-revision, and source-basis fields.
- Mail cache reads and ingestion schedule missing or changed drafts without blocking the list. Source hydration is serialized so a newly populated cache cannot fan out unbounded Outlook body reads.
- The dedicated executor uses `draft-executive-email` through an ephemeral, read-only Codex process with a three-minute timeout and concurrency of two by default.
- One active generation owns a message fingerprint. Duplicate refresh/open/regenerate events reuse it.
- Interrupted working generations are re-queued with the same identity on restart. Failures are terminal until an explicit Retry.
- A source change or Regenerate produces a reviewable pending revision. Jake's current edits remain untouched until he chooses Use new draft; Keep my draft preserves his version and the revision receipt.
- The Mail UI now shows Drafting, Draft ready, New revision ready, or Draft failed with inline Retry. Request/copy handoff controls are retired. Editor autosave, Copy reply, Regenerate, Outlook source link, and separate Open Work promotion remain.

## Validation receipt

- Production build: pass on Node 24.18.0.
- Full automated suite: 54 passed, 0 failed.
- Dedicated Mail journeys: cache-first rendering; all-visible-message coverage; fingerprint idempotency; concurrency cap; source-change revision; edit preservation; duplicate Regenerate; failure/Retry; restart recovery; retired request endpoints; no card/external-action mutation; accessible UI states.
- Migration on an online backup of the current local database, with drafting disabled: schema v15 present; SQLite quick check `ok`; zero foreign-key errors; zero duplicate active generations; v14 request history retained.
- Live runner: remained on the pre-prototype process and healthy. Mail navigation was read-only; no refresh, generation, retry, or work-item action was invoked.
- Responsive live read-only check: 1600×900, 1024×800, and 390×844 all rendered Mail with no document-level horizontal overflow and no console errors.
- Lint: 0 errors. Four existing unused legacy local-runner functions remain as warnings outside this Mail change.

## Deployment boundary

The protected branch can be reviewed and merged separately. Until merge/restart approval, the live runner will not apply schema v15 or generate drafts for current mail. No live Mail content or screenshot is committed to the public repository.
