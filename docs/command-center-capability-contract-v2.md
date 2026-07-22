# Command Center capability contract v2.0

Status: approved protected prototype contract for `cto/intelligence-autonomy-ui-system-2026-07-21`.

## Product boundary

Command Center is the visual ledger, evidence workspace, and institutional connective tissue for Jake's work. It owns durable local business state, source references, deterministic maintenance, and audit receipts. It does not interpret ambiguous business requests or dispatch native Codex work from the browser.

The persistent CEO / PM chat is the intelligence and portfolio-orchestration layer. Existing company PM tasks own company sequencing. Bounded native workers produce artifacts. Technical events are evidence; they never independently prove that a business commitment is complete or ready for review.

## Capability catalog

| Class | Allowed capabilities | Required safeguards | Explicitly excluded |
| --- | --- | --- | --- |
| Direct user controls | Capture a committed task; change due date, priority, owner, or durable status; mark Done or Not needed; record Waiting on and a follow-up date; add a note or evidence link; link an explicit duplicate to its canonical item; Undo a reversible mutation. | One visible action; bounded input; atomic write; idempotency key; before/after audit; inline verified result; exact Undo where feasible. | Hidden agent work, inferred completion, external sends, or task dispatch. |
| Deterministic sensing and maintenance | Refresh/index/cache sources; calculate freshness; detect exact identity duplicates; detect new evidence; flag missing/stale dates and state contradictions; place an item in Needs reconciliation. | Known transformation; verifiable output; replay-safe write; no unresolved business judgment; technical status remains separate from business status. | Choosing relevance, strategy, ownership, business completion, or communication content. |
| CEO / PM intelligence | Explain meaning; recommend the next move; connect work; assess evidence freshness; propose local corrections; reconcile a card with traceable evidence. | Shadow mode by default; named review identity; freshness label; last-reconciled time; immutable evidence and before/after packet; explicit apply action for durable corrections. | Browser-to-native routing, simulated delivery, generic replacement tasks, or autonomous orchestration. |
| Gated external actions | Send mail or chat, modify calendars, or write to shared company systems only in the owning native Codex task after Jake's explicit approval. | Exact destination and payload; action-time approval; native receipt; reviewable failure path. | Background sends or treating local approval as execution. |

## Deterministic workflow admission test

A workflow may run inside Command Center only when all answers are yes:

1. Are its inputs bounded and named?
2. Is the transformation deterministic and free of unresolved business judgment?
3. Is the output objectively verifiable?
4. Is replay idempotent or safely deduplicated?
5. Is failure reversible or safely recoverable?
6. Does it avoid external/shared-system action?
7. Can it complete without changing a durable business status from a technical signal?

The explicit transcript flow is the reference pattern: Jake selects the transcript, processing produces a note and proposed follow-ups, Jake reviews the proposals, and only Jake's direct completion action resolves the business card.

## Durable versus technical state

Durable business fields include title, next action, owner, priority, due date, waiting dependency, follow-up date, business status, resolution, and canonical identity. Only an explicit direct control or an applied CEO reconciliation packet may change them.

Technical state includes source refreshes, transcript processing, native assignment lifecycle, cached evidence, and intelligence-review generation. Technical completion may add evidence, mark a workflow complete, or request reconciliation; it may not set a work item to Done, Ready to review, Waiting, or Working.

## Intelligence shadow contract

An intelligence review is additive and read-only relative to the work item until a reconciliation packet is explicitly applied. It records:

- what this means;
- why it matters now;
- recommended next move;
- owner or dependency;
- definition of done;
- connected work and relationship type;
- cited evidence and freshness;
- evidence watermark and last-reconciled time;
- whether new evidence or a contradiction requires reconciliation.

Relationships are explicit and directional: `part_of`, `depends_on`, `informs`, `duplicates`, `blocked_by`, and `supports`. A proposed duplicate relationship never silently dismisses or merges an item.

## Reconciliation contract

The CEO / PM may create a local reconciliation packet with a stable idempotency key, bounded proposed corrections, evidence references, and the card's expected update version. Applying it is an explicit local action that records immutable before/after/evidence. A stale packet is rejected and remains inspectable. Replaying an applied key returns the same receipt without a second mutation.

## Experience contract

- Open Work remains the consolidated commitment ledger.
- A collapsed card answers what, next, when, and owner/blocker in under ten seconds.
- The expanded card leads with business meaning and the next move, then quiet direct controls, current state, CEO Read, evidence, working area, and collapsed History.
- New evidence and Needs reconciliation are visible semantic states, not replacements for durable business status.
- Mail, Calendar, Projects, Documents, Transcripts, Notes, Companies, Search, and Learning/sources remain first-class workspaces.
- The browser never displays agent-console or simulated-routing controls.

## Acceptance invariants

- Zero false Ready states from technical activity.
- Waiting is backed by a named dependency or evidence.
- No duplicate execution cards are created.
- Every card has one understandable next move.
- Every CEO judgment is attributable, cited, and freshness-labeled.
- Every deterministic mutation is audited, idempotent, and reversible where feasible.
- No live company state is changed during prototype QA.
