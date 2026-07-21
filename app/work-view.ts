export type WorkView = "open" | "done";

export const workViews: Array<{ id: WorkView; label: string }> = [
  { id: "open", label: "Open Work" },
  { id: "done", label: "Resolved" },
];

export function workViewFor(item: { status: string }): WorkView {
  if (["done", "dismissed"].includes(item.status)) return "done";
  return "open";
}
