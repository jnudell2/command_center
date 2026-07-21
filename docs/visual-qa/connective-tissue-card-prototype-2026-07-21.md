# Connective-tissue card prototype visual QA

Date: 2026-07-21

This pass used the live local Command Center with representative existing cards. It was read-only: cards and workspace tabs were opened, but no due date, status, note, transcript, company, or external system was changed.

## Acceptance checks

| Viewport | Result | Evidence |
| --- | --- | --- |
| Wide desktop, 1600 × 1000 | Pass. Three-pane layout remained balanced; the Open Work list and card detail each had a readable maximum width. Page scroll width equaled the viewport. | [Screenshot](connective-tissue-wide-1600.png) |
| Tablet, 1024 × 900 | Pass. Open Work remained fully visible, the card detail stayed closed until selected, and there was no page-level horizontal overflow. | [Screenshot](connective-tissue-tablet-1024.png) |
| Phone, 390 × 844 | Pass. Four primary destinations fit without horizontal navigation overflow; the remaining destinations stay available through the command menu. Cards wrap their Next line and due date cleanly. | [Screenshot](connective-tissue-phone-390.png) |
| Phone card detail, 390 × 844 | Pass. The detail opens as a focused sheet, the six-level structure stays legible, and the primary controls wrap without page overflow. | [Screenshot](connective-tissue-phone-card-390.png) |

## Live behavior verified

- Open Work displayed 20 unresolved representative items, including waiting and in-progress states.
- Collapsed cards showed company, title, one Next line, due date, one meaningful state, and only high or urgent priority.
- The selected expanded card showed What needs to happen, Why it matters, Current state, Relevant context, Working area, and collapsed History.
- No card action composer or simulated Codex dispatch control existed in the rendered app.
- History was collapsed by default.
- Transcripts opened a read-only workspace with linked commitments and meeting notes; explicit transcript processing remained on meeting cards.
- Documents and Notes both opened the Markdown editor. Documents showed meeting/project/decision material; Notes showed daily and scratch material.
- The final clean reload produced no new browser console warnings or errors.

## Non-blocking observation

The production build still reports its existing large-client-chunk warning. It does not affect the accepted card journeys, but code splitting remains a future performance improvement.
