import { assignmentPresentation, type Assignment } from "./card-workbench-model";

export default function AssignmentReceiptList({ assignments, busy, formatDate, onCopyPacket, onCancel }: {
  assignments: Assignment[];
  busy: boolean;
  formatDate: (value: string) => string;
  onCopyPacket: (assignment: Assignment) => void;
  onCancel: (assignment: Assignment) => void;
}) {
  if (!assignments.length) return null;
  return <details className="workbench-section" open>
    <summary>Codex assignments ({assignments.length})</summary>
    {assignments.map((assignment) => {
      const presentation = assignmentPresentation(assignment);
      return <article className={`assignment-receipt assignment-${assignment.status}`} key={assignment.id}>
        <div><strong>{assignment.destination === "card" ? "Returns here" : "Separate task"}</strong><span>{presentation.label}</span></div>
        <p>{assignment.instruction}</p>
        <small>{presentation.detail} · Updated {formatDate(assignment.updatedAt)}</small>
        {assignment.ownerId ? <small>Owner: {assignment.ownerId}</small> : null}
        {assignment.status === "prepared" ? <footer><button type="button" disabled={busy} onClick={() => onCopyPacket(assignment)}>Copy handoff packet</button><button className="secondary" type="button" disabled={busy} onClick={() => onCancel(assignment)}>Cancel preparation</button></footer> : null}
      </article>;
    })}
  </details>;
}
