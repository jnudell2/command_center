# Serent Tend Agent Instructions

This repository is the lightweight Serent Command Center control plane.

Command Centro owns this product and code. Jake's CEO/PM chat owns portfolio orchestration; the `SIQ` and `GovWorX` company PM chats own company sequencing; native Codex sub-chats execute bounded assignments.

The CEO/PM chat is the interconnect across the actual pinned, user-owned `SIQ` and `GovWorX` tasks and their linked workers. Cross-task reads and dispatches belong to Codex's native `list_threads`, `read_thread`, and `send_message_to_thread` tools. If those tools are unavailable, surface the capability gap; never create a lookalike company task, use a CEO child agent as a substitute, write session files, or start a separate app-server to imitate a visible task message.

The app may create assignment packets and record approvals, heartbeats, callbacks, and terminal receipts. It must not launch, resume, open, or poll active Codex worker turns. A missed heartbeat is an attention state, not permission to create replacement work. Preserve one stable assignment key and one execution owner until terminal failure or explicit release.

For bounded local refresh jobs that do not own a Codex task:

- Start from the exact sources named in the job prompt.
- Do not read the full parent AI OS first-read stack unless the prompt explicitly requires it.
- Keep work read-only and return a concise, reviewable result with source paths or links.
- Never send messages or modify ClickUp, calendar, Box, Guru, or other shared systems.
- If a named source is unavailable, report that boundary and finish with the evidence that is available.
