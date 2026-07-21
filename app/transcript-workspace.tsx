type TranscriptItem = {
  id: string;
  title: string;
  summary: string;
  suggestedAction: string;
  companyName: string;
  type: string;
  updatedAt: string;
  sources: Array<{ id: string; provider: string; label: string; sourceUrl: string; sourcePath: string }>;
};

type TranscriptNote = {
  id: string;
  title: string;
  body: string;
  type: string;
  updatedAt: string;
};

export default function TranscriptWorkspace({ items, notes, onOpenItem, onOpenNote }: {
  items: TranscriptItem[];
  notes: TranscriptNote[];
  onOpenItem: (id: string) => void;
  onOpenNote: (id: string) => void;
}) {
  const transcriptItems = items.filter((item) => item.type === "meeting_follow_up" || item.sources.some((source) => source.provider === "transcripts"));
  const meetingNotes = notes.filter((note) => note.type === "meeting");
  return <section className="content-view transcript-workspace" aria-labelledby="transcript-heading">
    <div className="view-heading compact">
      <p className="kicker">TRANSCRIPTS</p>
      <h2 id="transcript-heading">Meetings turned into useful context</h2>
      <p>Review captured commitments, speaker evidence, saved meeting notes, and the destination project. Processing remains explicit from a meeting card.</p>
    </div>

    <section className="transcript-section" aria-labelledby="transcript-actions-heading">
      <div className="section-heading"><div><span>Captured commitments</span><h3 id="transcript-actions-heading">Meeting follow-through</h3></div><b>{transcriptItems.length}</b></div>
      <div className="transcript-card-grid">
        {transcriptItems.length ? transcriptItems.map((item) => {
          const evidence = item.sources.find((source) => source.provider === "transcripts");
          return <button className="transcript-card" type="button" key={item.id} onClick={() => onOpenItem(item.id)}>
            <span>{item.companyName || "Personal"}</span>
            <strong>{item.title}</strong>
            <p>{item.summary}</p>
            <small><b>Next</b>{item.suggestedAction}</small>
            {evidence ? <em>{evidence.label || evidence.sourcePath || "Transcript evidence linked"}</em> : null}
          </button>;
        }) : <p className="empty-message">No meeting commitments are currently linked to transcript evidence.</p>}
      </div>
    </section>

    <section className="transcript-section" aria-labelledby="meeting-notes-heading">
      <div className="section-heading"><div><span>Saved context</span><h3 id="meeting-notes-heading">Meeting notes</h3></div><b>{meetingNotes.length}</b></div>
      <div className="transcript-note-list">
        {meetingNotes.length ? meetingNotes.map((note) => <button type="button" key={note.id} onClick={() => onOpenNote(note.id)}>
          <div><strong>{note.title}</strong><p>{note.body.replace(/^#.*$/m, "").trim().slice(0, 180) || "Saved meeting note"}</p></div>
          <time>{new Date(note.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</time>
        </button>) : <p className="empty-message">No saved meeting notes yet.</p>}
      </div>
    </section>
  </section>;
}
