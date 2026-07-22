import { createHash } from "node:crypto";

function normalized(value, limit = 150000) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, limit);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function mailDraftFingerprint(context) {
  const material = {
    messageId: normalized(context.messageId, 500),
    sender: stableValue(context.sender || {}),
    recipients: stableValue(context.recipients || []),
    cc: stableValue(context.cc || []),
    subject: normalized(context.subject, 1000),
    receivedAt: normalized(context.receivedAt, 100),
    body: normalized(context.body),
    company: normalized(context.company, 500),
    rules: stableValue(context.rules || []),
    notes: stableValue(context.notes || []),
    linkedWork: stableValue(context.linkedWork || null),
    promptVersion: Number(context.promptVersion || 1),
  };
  return createHash("sha256").update(JSON.stringify(stableValue(material))).digest("hex");
}

function rows(items, empty = "None available.") {
  return items?.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

export function buildMailDraftPrompt(context, feedback = "") {
  const recipients = (context.recipients || []).map((item) => `${item.name || ""} <${item.email || ""}>`.trim());
  const cc = (context.cc || []).map((item) => `${item.name || ""} <${item.email || ""}>`.trim());
  const notes = (context.notes || []).map((item) => `${item.title}: ${normalized(item.body, 1600)}`);
  const rules = (context.rules || []).map((item) => item.instruction || item.title || "").filter(Boolean);
  const linked = context.linkedWork
    ? `Title: ${context.linkedWork.title || ""}\nStatus: ${context.linkedWork.status || ""}\nNext move: ${context.linkedWork.nextMove || ""}`
    : "None available.";
  return `$draft-executive-email

Draft one sendable reply from Jake to the incoming email below. Apply the installed draft-executive-email skill and its calibrated Jake-style guidance. Start from the latest message and thread evidence. Do not invent facts, commitments, timing, recipients, or decisions. When context does not support a specific answer, draft the smallest honest reply or clarification request. Return only the proposed reply body with no subject line, commentary, label, analysis, or Markdown fence.

Source message ID: ${context.messageId}
From: ${context.sender?.name || ""} <${context.sender?.email || ""}>
To: ${rows(recipients)}
CC: ${rows(cc)}
Subject: ${context.subject}
Received: ${context.receivedAt}
Company: ${context.company || "Unfiled"}

Full cached message or thread:
${normalized(context.body) || "No body was available; use the preview only."}

Accepted writing rules:
${rows(rules, "Use the installed skill defaults.")}

Linked notes:
${rows(notes)}

Smallest relevant linked work context:
${linked}

Regeneration feedback:
${normalized(feedback, 4000) || "None."}

Boundary: this is a bounded review-only drafting utility. Read the supplied context only. Do not send email, create an Outlook draft, modify files or shared systems, create tasks, or route work.`;
}

export function parseMailDraftEventLine(line) {
  try {
    const event = JSON.parse(line);
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") return event.item.text.trim();
  } catch {
    // Non-event stdout is ignored.
  }
  return "";
}

export function hasManualDraftEdits(draft) {
  return Boolean(draft?.current_body && draft.current_body !== draft.generated_body);
}
