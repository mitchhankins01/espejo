export const ARTIFACT_KINDS = [
  "insight",
  "model",
  "note",
  "reference",
  "theory",
] as const;

export const ARTIFACT_KIND_FILTERS = ["", ...ARTIFACT_KINDS] as const;

export const ARTIFACT_KIND_LABELS: Record<
  (typeof ARTIFACT_KIND_FILTERS)[number],
  string
> = {
  "": "All",
  insight: "Insight",
  theory: "Theory",
  model: "Model",
  reference: "Reference",
  note: "Note",
};

export const ARTIFACT_BADGE_COLORS: Record<
  (typeof ARTIFACT_KINDS)[number],
  string
> = {
  insight: "bg-badge-insight-bg text-badge-insight-text",
  theory: "bg-badge-theory-bg text-badge-theory-text",
  model: "bg-badge-model-bg text-badge-model-text",
  reference: "bg-badge-reference-bg text-badge-reference-text",
  note: "bg-badge-note-bg text-badge-note-text",
};
