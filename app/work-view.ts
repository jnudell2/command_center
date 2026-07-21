export type WorkView = "open" | "codex_working" | "done";

export const workViews: Array<{ id: WorkView; label: string }> = [
  { id: "open", label: "Open Work" },
  { id: "codex_working", label: "Codex Working" },
  { id: "done", label: "Done" },
];

export function workViewFor(item: { status: string }): WorkView {
  if (["done", "dismissed"].includes(item.status)) return "done";
  if (item.status === "working") return "codex_working";
  return "open";
}
