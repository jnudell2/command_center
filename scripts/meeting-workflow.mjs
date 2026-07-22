import path from "node:path";

const ignoredMeeting = /\b(cancel(?:led|ed)?|focus(?: time)?|deep work|lunch|travel|flight|hotel|holiday|out of office|ooo|hold|blocked time)\b/i;
const supportedTranscript = /\.(vtt|srt|txt)$/i;

export function parseAttendees(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function isEligibleCompletedMeeting(event, {
  nowMs = Date.now(),
  enabledAtMs = 0,
  graceMs = 10 * 60_000,
  lookbackMs = 8 * 60 * 60_000,
} = {}) {
  const endMs = Date.parse(event?.end_at || event?.endAt || "");
  if (!Number.isFinite(endMs) || event?.is_all_day || event?.isAllDay) return false;
  if (endMs < enabledAtMs || endMs > nowMs - graceMs || endMs < nowMs - lookbackMs) return false;
  if (ignoredMeeting.test(String(event?.subject || ""))) return false;
  return parseAttendees(event?.attendees_json ?? event?.attendees).length > 0;
}

export function transcriptTimestamp(name) {
  const match = String(name || "").match(/GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const value = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isFinite(value) ? value : null;
}

function usefulTokens(value) {
  return [...new Set(String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !["meeting", "zoom", "call", "with", "the"].includes(token)))];
}

export function scoreTranscriptCandidate(file, event, nowMs = Date.now()) {
  if (!supportedTranscript.test(String(file?.name || ""))) return { score: -1, reasons: [] };
  const startMs = Date.parse(event?.start_at || event?.startAt || "");
  const endMs = Date.parse(event?.end_at || event?.endAt || "");
  const stampedMs = transcriptTimestamp(file.name);
  const modifiedMs = Number(file?.mtimeMs || 0);
  const reasons = [];
  let score = 0;
  if (stampedMs && Number.isFinite(startMs)) {
    const delta = Math.abs(stampedMs - startMs);
    if (delta <= 20 * 60_000) { score += 12; reasons.push("filename time matches the meeting"); }
    else { score -= 8; reasons.push("filename time does not match the meeting"); }
  }
  if (modifiedMs && Number.isFinite(endMs) && modifiedMs >= startMs - 30 * 60_000 && modifiedMs <= Math.max(nowMs, endMs + 8 * 60 * 60_000)) {
    score += 3;
    reasons.push("downloaded around the meeting");
  }
  if (/recording|transcript/i.test(file.name)) { score += 2; reasons.push("looks like a transcript"); }
  const filename = file.name.toLowerCase();
  const matchedTokens = usefulTokens(event?.subject).filter((token) => filename.includes(token));
  if (matchedTokens.length) {
    score += Math.min(4, matchedTokens.length * 2);
    reasons.push("filename matches the meeting title");
  }
  return { score, reasons };
}

export function normalizeMeetingAction(raw, validCompanies = ["avionte", "stockiq", "govworx", "firm"]) {
  if (!raw || !String(raw.title || "").trim()) return null;
  const owner = ["jake", "external"].includes(raw.owner) ? raw.owner : "jake";
  const companySlug = validCompanies.includes(raw.companySlug) ? raw.companySlug : null;
  const priority = ["urgent", "high", "normal", "low"].includes(raw.priority) ? raw.priority : "normal";
  const dueAt = raw.dueAt && Number.isFinite(Date.parse(raw.dueAt)) ? new Date(raw.dueAt).toISOString() : null;
  return {
    title: String(raw.title).trim().slice(0, 240),
    summary: String(raw.summary || raw.title).trim().slice(0, 4000),
    companySlug,
    type: String(raw.type || "follow_up").trim().slice(0, 120),
    priority,
    owner,
    suggestedAction: String(raw.suggestedAction || raw.title).trim().slice(0, 4000),
    evidenceTimestamp: String(raw.evidenceTimestamp || "").trim().slice(0, 80),
    dueAt,
    existingWorkItemId: raw.existingWorkItemId ? String(raw.existingWorkItemId).slice(0, 120) : null,
  };
}

export function suggestedMeetingActionDueAt(priority, meetingEndAt) {
  const businessDays = { urgent: 1, high: 2, normal: 5, low: 10 }[priority] ?? 5;
  const due = new Date(meetingEndAt || Date.now());
  if (Number.isNaN(due.getTime())) return null;
  due.setHours(12, 0, 0, 0);
  let added = 0;
  while (added < businessDays) {
    due.setDate(due.getDate() + 1);
    if (due.getDay() !== 0 && due.getDay() !== 6) added += 1;
  }
  due.setHours(23, 59, 59, 999);
  return due.toISOString();
}

export function safeMeetingName(subject, fallback = "Meeting") {
  return String(subject || fallback)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9 _.-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || fallback;
}

export function isAllowedTranscriptPath(candidatePath, roots) {
  const resolved = path.resolve(String(candidatePath || ""));
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
