"use client";

type Evidence = {
  label?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  freshness?: string;
  retrievedAt?: string;
  observedAt?: string;
};

export type IntelligenceReviewView = {
  id: string;
  mode: "shadow";
  status: "current" | "new_evidence" | "needs_reconciliation";
  whatItMeans: string;
  whyItMattersNow: string;
  recommendedNextMove: string;
  ownerDependency: string;
  definitionOfDone: string;
  evidence: Evidence[];
  evidenceWatermark: string | null;
  reviewedBy: string;
  lastReconciledAt: string | null;
  updatedAt: string;
};

export type RelationshipView = {
  id: string;
  direction: "outgoing" | "incoming";
  relationType: "part_of" | "depends_on" | "informs" | "duplicates" | "blocked_by" | "supports";
  state: "proposed" | "confirmed" | "dismissed";
  rationale: string;
  otherWorkItemId: string;
  otherTitle: string;
  otherStatus: string;
  otherCompanySlug: string | null;
};

function relativeFreshness(value?: string | null) {
  if (!value) return "Freshness unknown";
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "Freshness unknown";
  const hours = Math.max(0, Math.round(elapsed / 3_600_000));
  if (hours < 1) return "Checked within the hour";
  if (hours < 24) return `Checked ${hours}h ago`;
  return `Checked ${Math.round(hours / 24)}d ago`;
}

function relationLabel(relationship: RelationshipView) {
  const labels = {
    part_of: "Part of",
    depends_on: "Depends on",
    informs: "Informs",
    duplicates: "Duplicates",
    blocked_by: "Blocked by",
    supports: "Supports",
  };
  return labels[relationship.relationType];
}

export function CEORead({ review, relationships, onOpenWorkItem }: { review: IntelligenceReviewView | null; relationships: RelationshipView[]; onOpenWorkItem: (id: string) => void }) {
  if (!review) {
    return (
      <section className="ceo-read ceo-read-empty" aria-labelledby="ceo-read-heading">
        <header><div><span className="eyebrow">CEO READ</span><h3 id="ceo-read-heading">No shadow review yet</h3></div><span className="semantic-chip chip-neutral">Read only</span></header>
        <p>The durable card remains the source of truth. The CEO / PM can add a cited shadow read during reconciliation.</p>
      </section>
    );
  }
  const needsAttention = review.status !== "current";
  return (
    <section className={`ceo-read ceo-read-${review.status}`} aria-labelledby="ceo-read-heading">
      <header>
        <div><span className="eyebrow">CEO READ · SHADOW</span><h3 id="ceo-read-heading">{review.whatItMeans || "Review the connected evidence"}</h3></div>
        <span className={`semantic-chip ${needsAttention ? "chip-reconciliation" : "chip-fresh"}`}>{review.status === "new_evidence" ? "New evidence" : review.status === "needs_reconciliation" ? "Needs reconciliation" : "Current"}</span>
      </header>
      <div className="ceo-read-grid">
        <div className="ceo-read-lead"><span>Recommended next move</span><strong>{review.recommendedNextMove || "No recommendation recorded."}</strong></div>
        <dl>
          <div><dt>Why now</dt><dd>{review.whyItMattersNow || "No timing judgment recorded."}</dd></div>
          <div><dt>Owner / dependency</dt><dd>{review.ownerDependency || "Not reconciled"}</dd></div>
          <div><dt>Done when</dt><dd>{review.definitionOfDone || "Not reconciled"}</dd></div>
        </dl>
      </div>
      {relationships.length ? <div className="connected-work"><div className="subsection-label">Connected work</div>{relationships.slice(0, 6).map((relationship) => <button type="button" key={relationship.id} onClick={() => onOpenWorkItem(relationship.otherWorkItemId)}><span>{relationLabel(relationship)}</span><strong>{relationship.otherTitle}</strong><small>{relationship.state}</small></button>)}</div> : null}
      <div className="ceo-evidence"><div className="subsection-label">Evidence and freshness</div>{review.evidence.length ? review.evidence.slice(0, 5).map((evidence, index) => evidence.sourceUrl ? <a key={`${evidence.sourceUrl}-${index}`} href={evidence.sourceUrl} target="_blank" rel="noreferrer"><strong>{evidence.label || evidence.sourceLabel || "Source evidence"}</strong><span>{evidence.freshness || relativeFreshness(evidence.retrievedAt || evidence.observedAt)}</span></a> : <div key={`${evidence.label || "evidence"}-${index}`}><strong>{evidence.label || evidence.sourceLabel || "Source evidence"}</strong><span>{evidence.freshness || relativeFreshness(evidence.retrievedAt || evidence.observedAt)}</span></div>) : <p>No cited evidence was attached to this shadow read.</p>}</div>
      <footer><span>Reviewed by {review.reviewedBy}</span><span>{review.lastReconciledAt ? `Last reconciled ${new Date(review.lastReconciledAt).toLocaleString()}` : "Not yet reconciled"}</span></footer>
    </section>
  );
}
