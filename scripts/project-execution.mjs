const COMPLETE_STATUSES = new Set(["complete", "done", "dismissed"]);

export function parseDependencies(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

export function projectOwnerState(owner = "") {
  const normalized = String(owner).toLowerCase();
  if (normalized.includes("jake")) return "jake";
  if (normalized.includes("codex")) return "codex";
  return "external";
}

function dateTime(value) {
  return value ? Date.parse(`${value}T12:00:00-07:00`) : Number.NaN;
}

export function daysBetween(date, today) {
  const target = dateTime(date);
  const origin = dateTime(today);
  return Number.isFinite(target) && Number.isFinite(origin) ? Math.ceil((target - origin) / 86_400_000) : null;
}

export function classifyProjectPlanItem(item, allItems, today) {
  if (item.status === "complete") {
    return { state: "complete", ownerState: projectOwnerState(item.owner_label), blockedBy: [], daysUntilDue: daysBetween(item.due_date, today), reason: "Completed." };
  }
  if (item.execution_mode === "never") {
    return { state: "plan_only", ownerState: projectOwnerState(item.owner_label), blockedBy: [], daysUntilDue: daysBetween(item.due_date, today), reason: "Tracked in the plan without creating an execution action." };
  }

  const byId = new Map(allItems.map((candidate) => [candidate.id, candidate]));
  const blockedBy = parseDependencies(item.depends_on)
    .map((id) => byId.get(id))
    .filter((dependency) => dependency && !COMPLETE_STATUSES.has(dependency.status))
    .map((dependency) => ({ id: dependency.id, title: dependency.title }));
  const ownerState = projectOwnerState(item.owner_label);
  const daysUntilDue = daysBetween(item.due_date, today);
  const daysUntilStart = daysBetween(item.start_date, today);

  if (blockedBy.length) {
    return {
      state: "up_next",
      ownerState,
      blockedBy,
      daysUntilDue,
      reason: `Unlocks when ${blockedBy.map((dependency) => dependency.title).join(" and ")} ${blockedBy.length === 1 ? "is" : "are"} complete.`,
    };
  }

  const withinLeadWindow = daysUntilDue !== null && daysUntilDue <= Number(item.surface_days || 21);
  const hasStarted = daysUntilStart === null || daysUntilStart <= 0;
  const activeNow = item.status === "active" || item.status === "blocked" || hasStarted || withinLeadWindow;
  if (!activeNow) {
    return {
      state: "up_next",
      ownerState,
      blockedBy: [],
      daysUntilDue,
      reason: item.start_date ? `Planned to begin ${item.start_date}.` : "Held until it enters the active execution window.",
    };
  }

  if (ownerState === "external" || item.status === "blocked") {
    return {
      state: "waiting",
      ownerState,
      blockedBy: [],
      daysUntilDue,
      reason: ownerState === "external" ? `Waiting on ${item.owner_label || "an external owner"}.` : "Blocked and needs an input or decision before it can move.",
    };
  }

  return {
    state: "do_now",
    ownerState,
    blockedBy: [],
    daysUntilDue,
    reason: item.status === "active"
      ? "This is active work in the current plan."
      : daysUntilDue !== null && daysUntilDue < 0
        ? `${Math.abs(daysUntilDue)} days overdue.`
        : daysUntilDue !== null
          ? `Due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}.`
          : "Ready to begin now.",
  };
}

export function projectExecutionGuidance(items, today) {
  const classified = items.map((item) => ({ ...item, execution: classifyProjectPlanItem(item, items, today) }));
  return {
    items: classified,
    doNow: classified.filter((item) => item.execution.state === "do_now"),
    waiting: classified.filter((item) => item.execution.state === "waiting"),
    upNext: classified.filter((item) => item.execution.state === "up_next"),
  };
}

export function projectFollowUpBucket(item, today) {
  const execution = classifyProjectPlanItem(item, [item], today);
  if (execution.state !== "waiting" || execution.ownerState !== "external" || !item.due_date || execution.daysUntilDue === null || execution.daysUntilDue > 0) return null;
  const overdueDays = Math.abs(execution.daysUntilDue);
  const cadence = Math.max(1, Number(item.follow_up_days || 3));
  return Math.floor(overdueDays / cadence);
}
