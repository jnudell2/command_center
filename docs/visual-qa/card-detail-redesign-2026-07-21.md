# Executive card-detail redesign visual QA

Date: 2026-07-21

Branch: `cto/intelligence-autonomy-ui-system-2026-07-21`

Mode: live local runtime for read-only inspection, plus deterministic fixtures for mutation and scan tests

## Before and after

- Before, schema-led GovWorX detail: `intelligence-govworx-acceptance-wide-1600.png`
- After, GovWorX decision surface at 1600px: `card-detail-redesign-govworx-wide-1600.png`
- After, StockIQ decision surface at 1600px: `card-detail-redesign-stockiq-wide-1600.png`
- After, StockIQ decision surface at 1024px: `card-detail-redesign-stockiq-tablet-1024.png`
- After, StockIQ decision surface at 390px: `card-detail-redesign-stockiq-phone-390.png`

## Acceptance results

| Check | Result |
| --- | --- |
| Five-second read | Pass. Current truth, why now, Jake's next move, actor/dependency, and timing appear before administrative details. |
| One state and next move | Pass. The header shows one business state; the body promotes one next move and one done condition. |
| GovWorX contradiction | Pass. The live read-only record exposes both the uncompleted Jake outreach and Jul 20 versus Jul 24 date conflict above the fold. |
| StockIQ contradiction | Pass. Ready to review promotes the Edison/API/MCP versus full StockIQ 2.0 decision instead of repeating “Build the benchmark.” |
| CEO intelligence | Pass. A current review is authoritative and freshness-labeled; when absent, no empty CEO Read panel is rendered. |
| Reading versus editing | Pass. Due date, priority, owner, status, waiting dependency, evidence entry, and administrative controls are hidden behind one Edit panel. |
| Technical history | Pass. Paths, IDs, mutation logs, and receipts are absent from reading mode and remain available under collapsed Activity. |
| 10-card scan | Pass. Ten deterministic cards each expose truth, implication, next move, actor, timing, and done condition; no Ready fixture retains a build action. |
| Desktop 1600 x 1000 | Pass. Split-pane composition has no document or body overflow. |
| Tablet 1024 x 900 | Pass. Detail becomes a full-width reading surface; no document or body overflow. |
| Phone 390 x 844 | Pass. Hierarchy remains legible in one column; disclosures stay closed and there is no horizontal overflow. |
| Edit disclosure | Pass. Edit opens one panel and closes without persisting a change. |
| Console | Pass. A fresh post-reload inspection returned zero errors. |

## Live record evidence

- GovWorX `24485506-6ffd-4b0b-944f-44e9669d32d9`: durable status remained `waiting_external`; no demo delivery was inferred. The UI distinguishes the uncompleted Jake outreach from a proven external wait and promotes the Jul 20/Jul 24 conflict.
- StockIQ `571e2dff-e118-4f28-a925-f12eabd6b1ec`: durable status is `back_for_review`; the returned benchmark artifact and its remaining monetization decision are promoted, while the stale stored build action becomes a reconciliation alert.

## QA restoration receipt

During phone QA, an imprecise locator selected the collapsed completion control instead of the adjacent Open card control on each of the GovWorX and StockIQ acceptance records. The official idempotent Undo endpoint restored both exact prior states. Read-back verified GovWorX as `waiting_external` with its prior resolution and active plan item, and StockIQ as `back_for_review`; both have `resolvedAt: null` and their prior due dates. The applied-and-undone audit events were intentionally preserved. All later browser checks used the exact accessible name `Open Benchmark StockIQ execution and entitlements`; no other live business state was changed.
