# Serent Tend Agent Instructions

This repository is the lightweight Serent Tend app and background runner.

For background jobs launched by the app:

- Start from the exact sources named in the job prompt.
- Do not read the full parent AI OS first-read stack unless the prompt explicitly requires it.
- Keep work read-only and return a concise, reviewable result with source paths or links.
- Never send messages or modify ClickUp, calendar, Box, Guru, or other shared systems.
- If a named source is unavailable, report that boundary and finish with the evidence that is available.

