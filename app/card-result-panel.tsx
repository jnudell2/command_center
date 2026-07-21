import { assignmentPresentation, type Assignment } from "./card-workbench-model";

export default function CardResultPanel({ assignment, formatDate, onRevise }: {
  assignment: Assignment;
  formatDate: (value: string) => string;
  onRevise: (assignment: Assignment) => void;
}) {
  const presentation = assignmentPresentation(assignment);
  const value = assignment.status === "failed" ? assignment.error : assignment.result;
  return <section className={`assignment-result assignment-${assignment.status}`} aria-live="polite">
    <div><span>{presentation.label}</span><time>{formatDate(assignment.updatedAt)}</time></div>
    <h3>{assignment.destination === "card" ? "Codex returned to this card" : "Separate task receipt"}</h3>
    <p>{value || presentation.detail}</p>
    {assignment.status === "completed" ? <button type="button" onClick={() => onRevise(assignment)}>Revise with feedback</button> : null}
  </section>;
}
