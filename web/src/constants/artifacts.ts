export const ARTIFACT_KINDS = [
  "insight",
  "note",
  "project",
  "reference",
  "review",
] as const;

export const ARTIFACT_KIND_FILTERS = ["", ...ARTIFACT_KINDS] as const;

export const ARTIFACT_KIND_LABELS: Record<
  (typeof ARTIFACT_KIND_FILTERS)[number],
  string
> = {
  "": "All",
  insight: "Insight",
  note: "Note",
  project: "Project",
  reference: "Reference",
  review: "Review",
};

export const ARTIFACT_BADGE_COLORS: Record<
  (typeof ARTIFACT_KINDS)[number],
  string
> = {
  insight: "bg-badge-insight-bg text-badge-insight-text",
  note: "bg-badge-note-bg text-badge-note-text",
  project: "bg-badge-theory-bg text-badge-theory-text",
  reference: "bg-badge-reference-bg text-badge-reference-text",
  review: "bg-badge-note-bg text-badge-note-text",
};
