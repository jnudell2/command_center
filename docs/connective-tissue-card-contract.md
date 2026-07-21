# Command Center connective-tissue card contract

Status: approved prototype contract for `cto/connective-tissue-card-prototype-2026-07-21`. Main remains unchanged until Jake reviews the protected prototype.

## Product role

Command Center is Jake's visual ledger and source workspace. It connects durable commitments, decisions, and next actions to Mail, Calendar, Projects, Documents, Transcripts, Notes, Search, and source evidence. It does not interpret or dispatch native Codex work from a browser card.

The persistent Command Center CEO / PM chat is the reasoning and orchestration layer. Existing company PM tasks own company sequencing and native Codex work. Command Center preserves the resulting state and receipts.

Normal workflow:

1. Jake tells the persistent CEO / PM chat what happened or what he wants.
2. CEO / PM interprets the request and idempotently creates or updates the correct Command Center item.
3. CEO / PM uses native Codex tools to route work to the exact existing PM or task when appropriate.
4. The native PM or bounded worker returns a verified result.
5. CEO / PM reconciles the originating card.
6. Command Center remains the visual ledger and source workspace.

The browser must never imply that it can dispatch native Codex work. Historical assignments and receipts remain available for audit, but are not primary controls or card states.

## Information architecture

Retain these workspace surfaces:

- Open Work
- Mail
- Calendar
- Projects
- Documents
- Transcripts
- Notes
- Search and Sources where already useful

Open Work contains every unresolved commitment, including work waiting on another person or already with a verified company PM. Group unresolved work by Overdue, Today, Tomorrow, This week, Later, and No due date. Waiting and Ready to review are visible card states, not separate places Jake must remember to inspect. Done and Not needed remain resolved outcomes.

## Collapsed card

A collapsed card must answer within about three seconds:

1. What is this?
2. What is the next move?
3. When is it due?
4. Who or what owns or blocks it?

Show only:

- company or Personal indicator;
- concise plain-English title;
- one explicit `Next` line;
- due date;
- one meaningful state such as Open, Waiting on Kyle, With SIQ PM, or Ready to review;
- priority only when high or urgent.

Do not show technical IDs, routing or assignment receipts, lifecycle jargon, source metadata, long summaries, or agent controls.

## Expanded card

Use a quiet two-level layout:

1. **What needs to happen**: next action, definition of done, editable due date, and priority.
2. **Why it matters**: two or three concise sentences and the linked project or objective where applicable.
3. **Current state**: Jake owns it, Waiting on a named person/input, With a named PM only when supported by a verified receipt, or Ready for Jake.
4. **Relevant context**: only the most relevant linked email, meeting/transcript, project milestone, document, or source evidence.
5. **Working area**: a type-aware Draft reply, Meeting agenda, Deck outline, Scheduling note, or Working notes surface.
6. **History**: collapsed by default; preserve technical events, assignments, and receipts for audit without making them the primary interface.

## Primary controls

- Done
- Change due date
- Waiting on...
- Ready to review
- Not needed
- Open source/context

Remove Ask Codex, Send to CEO / PM, Send to company PM, Prepare separate task, routing previews, queue receipts, assignment controls, and generic technical Working, Queued, or Prepared language from the primary card interface.

## Type-aware context

- Email: sender or recipient, subject, reply obligation, and latest relevant message.
- Meeting: date, attendees, and prep objective or follow-up.
- Project: milestone, risk, next decision, and linked deliverable.
- Transcript: captured commitment, speaker evidence, and destination project.
- Personal: title, due date, priority, and minimal notes.
- Review: artifact, decision requested, and recommendation.

Mail messages, meetings, and transcripts become Open Work only when they create a real commitment, decision, or follow-up. Their source tabs remain available even when no action card is created.

## Preservation and safety

- Preserve the existing transcript review and routing workflow.
- Preserve all historical card, assignment, routing, and lifecycle data behind History/audit details.
- Prefer mapping existing fields; do not add a schema migration for the prototype unless the UI cannot satisfy this contract without one.
- Browser QA is read-only against live company state. Interactive state-control tests use disposable fixture data.
- No routing heartbeat, shell or CLI worker bridge, Codex app-server, simulated task delivery, external send, or company-system mutation.
