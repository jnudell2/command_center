import type { CardActionMode } from "./card-workbench-model";

const choices: Array<{ id: CardActionMode; label: string; help: string; placeholder: string; button: string }> = [
  { id: "update", label: "Update card", help: "Change fields on this card. No Codex work is started.", placeholder: "Move this to Friday, make it high priority, or assign it to GovWorX…", button: "Update card" },
  { id: "return_here", label: "Ask Codex · Return here", help: "Prepare work whose result, question, or error will appear at the top of this card.", placeholder: "Draft the follow-up, analyze the evidence, or prepare the recommendation…", button: "Prepare card-return work" },
  { id: "separate_task", label: "Prepare separate task", help: "Create a handoff packet for a user-owned Codex task. Preparing it does not start a task.", placeholder: "Describe the bounded outcome for the separate Codex task…", button: "Prepare separate task" },
];

export default function CardActionComposer({ mode, instruction, busy, onMode, onInstruction, onSubmit }: {
  mode: CardActionMode;
  instruction: string;
  busy: boolean;
  onMode: (mode: CardActionMode) => void;
  onInstruction: (instruction: string) => void;
  onSubmit: () => void;
}) {
  const choice = choices.find((item) => item.id === mode) || choices[0];
  return <form className="card-action-composer" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <fieldset aria-label="Choose what should happen">
      {choices.map((item) => <button className={mode === item.id ? "selected" : ""} type="button" key={item.id} onClick={() => onMode(item.id)} aria-pressed={mode === item.id}>
        <strong>{item.label}</strong><span>{item.help}</span>
      </button>)}
    </fieldset>
    <label><span>{choice.label}</span><textarea value={instruction} onChange={(event) => onInstruction(event.target.value)} placeholder={choice.placeholder} aria-label="Card instruction" /></label>
    <footer><small>{choice.help}</small><button type="submit" disabled={busy || !instruction.trim()}>{busy ? "Working…" : choice.button}</button></footer>
  </form>;
}
