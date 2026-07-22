# Prototype demo guide

Use the protected branch `cto/intelligence-autonomy-ui-system-2026-07-21`. Do not use the demo to change a live company card.

## Five-minute walkthrough

1. Open **Open Work**. Scan a collapsed card for company, title, one Next line, due date, business state, and high priority only.
2. Open **Obtain the GovWorX product demo**. Confirm the durable state is Waiting on GovWorX and the technical receipt is labeled as evidence that cannot change business state.
3. Review the quiet direct-control area: due date, priority, owner, business status, Waiting on, evidence link, Done, Ready to review, and Not needed. Do not submit these controls against live data.
4. Expand **History** to see technical receipts without making them the primary card interface.
5. Open **Learning & sources**, then **Open UI lab**. This fixture-only gallery demonstrates collapsed cards, deterministic controls and Undo, semantic states, CEO Read, connected work, evidence freshness, system failures, navigation, and expanded-card hierarchy.
6. Resize to tablet and phone widths. Confirm the layout reflows, the ledger stays scannable, and no horizontal scroll appears.
7. Return to **Transcripts**. Confirm the explicit transcript workflow remains available and distinct from generic in-card agent execution.

## Safe API demonstration

Use `tests/intelligence-autonomy.test.mjs`, which creates a temporary database and local server. It demonstrates duplicate-click replay, exact Undo, Waiting/follow-up, evidence linking, explicit duplicate relationships, stale reconciliation rejection, applied reconciliation replay, technical/business state separation, and the 12-card shadow pilot without touching the live database.
