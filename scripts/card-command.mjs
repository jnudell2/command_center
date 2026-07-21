const weekdayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function endOfLocalDayIso(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).toISOString();
}

function validCalendarDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function parseDueDateText(value, now = new Date()) {
  const text = String(value || "").trim().replace(/[.!?]+$/, "");
  const normalized = text.toLowerCase().replace(/^on\s+/, "").trim();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (normalized === "today") return endOfLocalDayIso(base);
  if (normalized === "tomorrow") {
    base.setDate(base.getDate() + 1);
    return endOfLocalDayIso(base);
  }

  const weekdayMatch = normalized.match(/^(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (weekdayMatch) {
    const target = weekdayNames.indexOf(weekdayMatch[2]);
    let delta = (target - base.getDay() + 7) % 7;
    if (weekdayMatch[1]) delta += 7;
    else if (delta === 0) delta = 7;
    base.setDate(base.getDate() + delta);
    return endOfLocalDayIso(base);
  }

  const isoMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const date = validCalendarDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    return date ? endOfLocalDayIso(date) : null;
  }

  const numericMatch = normalized.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
  if (numericMatch) {
    let year = numericMatch[3] ? Number(numericMatch[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    let date = validCalendarDate(year, Number(numericMatch[1]), Number(numericMatch[2]));
    if (date && !numericMatch[3] && date < base) date = validCalendarDate(year + 1, Number(numericMatch[1]), Number(numericMatch[2]));
    return date ? endOfLocalDayIso(date) : null;
  }

  if (!/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(text)) return null;
  const parsed = new Date(`${text}${/\b\d{4}\b/.test(text) ? "" : `, ${now.getFullYear()}`} 23:59:59`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (!/\b\d{4}\b/.test(text) && parsed < base) parsed.setFullYear(parsed.getFullYear() + 1);
  return endOfLocalDayIso(parsed);
}

function splitClauses(instruction) {
  return String(instruction || "")
    .replace(/,\s*(?=(?:due|priority|company|mark|set|change|move|push|draft|write|research|build|create|prepare|investigate)\b)/gi, " | ")
    .split(/\s*(?:;|\||\bthen\b|\band\s+(?=(?:due|change|set|move|push|make|mark|rename|assign|draft|write|research|build|create|prepare|investigate|compare)\b))\s*/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function companyFor(value, companies) {
  const target = String(value || "").trim().toLowerCase().replace(/[.!?]+$/, "");
  const compactTarget = target.replace(/[^a-z0-9]/g, "");
  return companies.find((company) => {
    const aliases = [company.slug, company.displayName, ...(company.aliases || [])].filter(Boolean).map((alias) => String(alias).toLowerCase());
    return aliases.includes(target) || aliases.some((alias) => compactTarget === alias.replace(/[^a-z0-9]/g, ""));
  }) || null;
}

function addChange(changes, patch, current, field, value, label) {
  const before = current[field] ?? null;
  if (before === value) return;
  patch[field] = value;
  changes.push({ field, label, before, after: value });
}

export function parseCardCommand({ instruction, current, companies = [], now = new Date() }) {
  const clauses = splitClauses(instruction);
  const changes = [];
  const patch = {};
  const remaining = [];
  let clarification = "";

  for (const clause of clauses) {
    let match = clause.match(/^(?:change|set|update|rename)(?:\s+(?:the|this))?\s*(?:task|card)?\s*title\s+(?:to|as)\s+(.+)$/i)
      || clause.match(/^rename\s+(?:this|the\s+(?:card|task))\s+to\s+(.+)$/i)
      || clause.match(/^(?:change|rename)\s+(?:this|the\s+(?:card|task))?\s*to\s+(.+)$/i);
    if (match) {
      addChange(changes, patch, current, "title", match[1].trim(), "Title");
      continue;
    }

    if (/^(?:clear|remove)\s+(?:the\s+)?due\s+date$/i.test(clause)) {
      addChange(changes, patch, current, "due_at", null, "Due date");
      continue;
    }

    match = clause.match(/^(?:(?:change|set|update|move|push)\s+(?:the\s+)?(?:due\s+date|date)\s+(?:to\s+)?|(?:make\s+)?(?:it\s+)?due\s+)(.+)$/i)
      || clause.match(/^(?:move|push)\s+(?:this|the\s+(?:card|task))\s+to\s+(.+)$/i);
    if (match) {
      const possibleCompany = companyFor(match[1], companies);
      if (possibleCompany && /^(?:move|push)\s+(?:this|the\s+(?:card|task))/i.test(clause)) {
        addChange(changes, patch, current, "company_slug", possibleCompany.slug, "Company");
        continue;
      }
      const dueAt = parseDueDateText(match[1], now);
      if (!dueAt) clarification = `I could not understand the due date "${match[1].trim()}".`;
      else addChange(changes, patch, current, "due_at", dueAt, "Due date");
      continue;
    }

    match = clause.match(/^(?:set|change|make)(?:\s+(?:the|this))?\s*(?:task|card)?\s*priority\s+(?:to\s+)?(urgent|high|normal|low)$/i);
    if (match) {
      addChange(changes, patch, current, "priority", match[1].toLowerCase(), "Priority");
      continue;
    }

    match = clause.match(/^(?:set|change)\s+(?:the\s+)?company\s+to\s+(.+)$/i)
      || clause.match(/^(?:this|it)\s+is\s+for\s+(.+)$/i)
      || clause.match(/^(?:assign|move)\s+(?:this|the\s+(?:card|task))\s+to\s+(.+)$/i);
    if (match) {
      const company = companyFor(match[1], companies);
      if (!company) clarification = `I could not match "${match[1].trim()}" to a Command Center company.`;
      else addChange(changes, patch, current, "company_slug", company.slug, "Company");
      continue;
    }

    if (/^(?:mark\s+)?(?:this|the\s+(?:card|task))?\s*(?:as\s+)?(?:done|complete|completed)$/i.test(clause)) {
      addChange(changes, patch, current, "status", "done", "Status");
      addChange(changes, patch, current, "resolution", "Completed through the card command box.", "Resolution");
      addChange(changes, patch, current, "resolved_at", new Date(now).toISOString(), "Completed at");
      continue;
    }

    match = clause.match(/^(?:(?:mark|set)\s+(?:this|the\s+(?:card|task))\s+(?:as\s+)?|(?:this|it)\s+is\s+)?waiting\s+(?:on|for)\s+(.+)$/i);
    if (match) {
      addChange(changes, patch, current, "status", "waiting_external", "Status");
      continue;
    }

    if (/^(?:reopen|return|move)\s+(?:this|the\s+(?:card|task))?(?:\s+back)?\s*(?:to\s+)?(?:open|open\s+work)$/i.test(clause)) {
      addChange(changes, patch, current, "status", "to_review", "Status");
      addChange(changes, patch, current, "resolution", "", "Resolution");
      addChange(changes, patch, current, "resolved_at", null, "Completed at");
      continue;
    }

    remaining.push(clause);
  }

  const looksLikeEdit = /\b(change|update|rename|set|move|push|mark|assign|due|priority|waiting|reopen)\b/i.test(String(instruction || ""));
  if (clarification) return { handled: true, changes: [], patch: {}, remainingIntent: "", clarification };
  if (!changes.length && looksLikeEdit) return { handled: true, changes: [], patch: {}, remainingIntent: "", clarification: "I understood this as a card change, but I need a clearer field and value." };
  return { handled: changes.length > 0, changes, patch, remainingIntent: remaining.join(" and "), clarification: "" };
}
