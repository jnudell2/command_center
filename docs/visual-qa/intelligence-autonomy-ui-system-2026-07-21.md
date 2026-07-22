# Intelligence, autonomy, and UI-system visual QA

Date: 2026-07-21

Branch: `cto/intelligence-autonomy-ui-system-2026-07-21`

Mode: live local runtime, read-only inspection of live records; fixture-only mutation tests

## Before and after

- Before: `connective-tissue-wide-1600.png`
- After, Open Work at 1600px: `intelligence-open-work-wide-1600.png`
- After, GovWorX acceptance card at 1600px: `intelligence-govworx-acceptance-wide-1600.png`
- After, UI lab at 1600px: `intelligence-ui-lab-wide-1600.png`
- After, UI lab at 1024px: `intelligence-ui-lab-tablet-1024.png`
- After, UI lab at 390px: `intelligence-ui-lab-phone-390.png`
- After, Open Work at 390px: `intelligence-open-work-phone-390.png`

## Live results

| Check | Result |
| --- | --- |
| Desktop 1600 x 1000 | Pass. Three-pane Open Work uses the available width without horizontal overflow. |
| Tablet 1024 x 900 | Pass. Navigation compresses to a quiet top rail; the UI lab remains a two-column composition where space permits. |
| Phone 390 x 844 | Pass. Open Work becomes a single scanning surface; cards wrap without clipping; the UI lab becomes one column. |
| Minimum primary targets | Pass. Collapsed completion controls and visible navigation/UI-lab actions are at least 40px high. |
| Keyboard focus | Pass. The inspected command control showed a 2px blue focus ring with 2px offset. |
| Accessible names | Pass. Visible buttons had an accessible name, including one-click Mark done and Open card controls. |
| Nested interactions | Pass. Zero `button button`, `button a`, or `a button` matches. |
| Console | Pass. Zero warning/error entries across Open Work, Calendar, Transcripts, Learning, and UI lab. |
| Workspace navigation | Pass. Calendar and Transcripts opened in the live runtime; the explicit transcript processing control remained present. |
| Current-view selection | Pass after remediation. Open Work can no longer retain a resolved or filtered-out card in the detail pane. |

## GovWorX acceptance evidence

The live record `24485506-6ffd-4b0b-944f-44e9669d32d9` was read but not changed. Database integrity inspection showed durable status `waiting_external`. The live card displayed Waiting on GovWorX, the concrete next move to obtain or schedule the demo, and technical evidence explicitly labeled as unable to change business state. The CEO Read correctly showed that no live shadow review exists yet rather than inventing one.

The isolated acceptance fixture supplied the cited shadow review: Kevin/GovWorX dependency, no proven demo delivery, kickoff-deck evidence, Hugo secret-shopping connection, and a clear next move. A 12-card GovWorX/StockIQ/Avionte fixture pilot produced zero false Ready states.

## Non-mutation receipt

Browser QA did not invoke a work-item mutation, assignment, reconciliation apply, mail send, calendar write, transcript processing action, or shared-system write. The additive v13 migration created schema only and left the live GovWorX business status unchanged.
