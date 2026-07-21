const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function dueDateInputValue(dueAt: string | null | undefined) {
  if (!dueAt) return "";
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return "";
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dueDateEndOfLocalDayIso(inputValue: string) {
  const normalized = inputValue.trim();
  if (!normalized) return null;
  const match = DATE_INPUT_PATTERN.exec(normalized);
  if (!match) throw new Error("Choose a valid due date.");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const dueAt = new Date(year, monthIndex, day, 23, 59, 59, 999);
  if (dueAt.getFullYear() !== year || dueAt.getMonth() !== monthIndex || dueAt.getDate() !== day) {
    throw new Error("Choose a valid due date.");
  }
  return dueAt.toISOString();
}
