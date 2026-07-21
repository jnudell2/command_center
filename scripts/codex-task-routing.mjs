export function codexTaskLaunchMode(existing) {
  if (existing && ["waiting_on_user", "accepted", "starting", "working", "needs_input", "needs_attention"].includes(existing.status)) return "already_running";
  return "prepare";
}
