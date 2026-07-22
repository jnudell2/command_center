# Intelligence, autonomy, and UI-system architecture checkpoint

Date: 2026-07-21

Branch: `cto/intelligence-autonomy-ui-system-2026-07-21`
Baseline: `c6642ed261184ff230d7ffe8c9099353ddd59f24`

## Decision

Proceed. The approved direction is compatible with the connective-tissue prototype and requires no destructive migration. The implementation will use additive schema version 13 and leave all existing work items, receipts, assignments, sources, notes, and transcript records intact.

## Capability cut line

- The browser performs explicit, deterministic local edits and shows verified receipts with Undo.
- Background maintenance may sense and flag; it may not make business judgments.
- CEO / PM judgment is stored as an attributable shadow review and becomes durable only through an explicit reconciliation apply.
- Technical assignment, source, and transcript events remain audit evidence and do not project onto durable business status.
- External actions stay outside the browser and require the owning native task plus Jake's action-time approval.

The governing catalog is [Command Center capability contract v2.0](../command-center-capability-contract-v2.md).

## Additive data model

Schema v13 adds:

1. `work_items.waiting_on` and `work_items.follow_up_at` for an explicit dependency and next follow-up.
2. `deterministic_mutations` for idempotency, before/after state, evidence, status, and Undo.
3. `work_item_relationships` for directional connected-work semantics and proposed/confirmed states.
4. `intelligence_reviews` for shadow CEO reads, evidence watermark, freshness, and reconciliation state.
5. `reconciliation_packets` for idempotent proposed/applied local corrections with immutable before/after/evidence.

All tables use foreign keys and stable unique keys. The migration initializes no intelligence judgment for live records and changes no live business status.

## API shape

- `POST /api/work-items/:id/mutations`: bounded direct local mutation with `idempotencyKey`.
- `POST /api/deterministic-mutations/:id/undo`: exact reversal when the current card still matches the mutation result.
- `GET /api/intelligence/reconciliation`: read-only queue of shadow reviews needing reconciliation.
- `POST /api/intelligence/reviews`: create/update a shadow review without changing the work item.
- `POST /api/reconciliation-packets`: create a traceable proposal.
- `POST /api/reconciliation-packets/:id/apply`: explicit, version-checked local apply.

The existing task, source, note, and transcript APIs remain available. No native-task launch, polling, or routing endpoint is added.

## Information architecture

Open Work remains the primary ledger. The expanded card order becomes:

1. Business meaning and next move.
2. Quiet deterministic controls.
3. Current business state and ownership/dependency.
4. CEO Read, clearly labeled Shadow when not reconciled.
5. Relevant evidence and connected work.
6. Type-aware working area.
7. Collapsed History and technical receipts.

The global navigation remains unchanged. A new lightweight `UI Lab` lives under Learning/sources and is populated entirely by in-memory fixtures. It demonstrates the design system without adding Storybook, a framework runtime, or production data.

## UI system direction

- Typography: one compact executive sans stack; clear 12/14/16/20/28 scale; tabular dates and counts.
- Spacing: 4px base with density tokens from 4 to 32px.
- Color: neutral paper/canvas layers; company color only as identity; semantic color reserved for risk, waiting, reconciliation, freshness, and success.
- Shape: 6/10/14px radii; low-contrast borders; one quiet elevation for overlays and selected work.
- Motion: 120–180ms, reduced-motion aware, limited to focus, selection, and inline receipts.
- Accessibility: 40px minimum primary touch targets, visible focus rings, native controls, descriptive names, no nested interactive elements, and semantic live regions.

Reusable primitives will cover buttons, chips, source rows, relationship rows, inline receipts, fields, empty/loading/stale/offline/error states, collapsed cards, detail sections, CEO Read, and workspace navigation patterns.

## GovWorX central acceptance case

Work item `24485506-6ffd-4b0b-944f-44e9669d32d9` remains live and untouched. A shadow fixture keyed to that ID will assert:

- durable state remains `waiting_external`;
- no demo or recording is represented as delivered;
- an old technical/read-only run cannot create Ready to review;
- the recommended next move is to obtain or schedule the product demo;
- the dependency is GovWorX / Kevin;
- kickoff-deck evidence and the Hugo secret-shopping scope are connected and freshness-labeled.

## Acceptance suite

- Migration on a fresh database and integrity check on a copy of current local data.
- Idempotent direct mutation, duplicate click, stale write, and exact Undo.
- Waiting dependency plus follow-up date, note/evidence link, and canonical duplicate relationship.
- Technical assignment/transcript completion does not change durable business status.
- Shadow review creation/replay, new-evidence watermark, stale packet rejection, and applied reconciliation audit.
- 10–15 representative shadow cards across GovWorX, StockIQ, and Avionte with zero false Ready states.
- Deterministic render checks for the UI lab and card information hierarchy.
- Keyboard, accessible names, focus, contrast tokens, touch targets, nested-control, overflow, desktop/tablet/phone, and console-error checks.

## Risk controls

- Prototype QA uses fresh temporary databases or read-only browser inspection.
- Live work-item mutation endpoints are never invoked during browser QA.
- Main remains unchanged; no merge or push occurs before Jake's review.
- The native-routing feasibility branch remains unchanged.
