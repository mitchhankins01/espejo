import type { InsightCandidate } from "./analyzers.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

function formatTemporalEcho(insight: InsightCandidate): string {
  const meta = insight.metadata;
  const similarity = typeof meta.similarity === "number"
    ? `${Math.round(meta.similarity * 100)}%`
    : "";
  const currentPreview = typeof meta.current_preview === "string"
    ? truncate(meta.current_preview, 150)
    : "";

  const lines: string[] = [
    `<b>${escapeHtml(insight.title)}</b>`,
    "",
    `<i>"${escapeHtml(truncate(insight.body, 150))}"</i>`,
  ];

  if (currentPreview) {
    lines.push("", "Today you wrote:", `<i>"${escapeHtml(currentPreview)}"</i>`);
  }

  if (similarity) {
    lines.push("", `Similarity: ${similarity}`);
  }

  return lines.join("\n");
}

function formatBiometricCorrelation(insight: InsightCandidate): string {
  const lines: string[] = [
    `<b>${escapeHtml(insight.title)}</b>`,
    "",
    "Journal entries from around that time:",
    "",
    `<i>"${escapeHtml(truncate(insight.body, 300))}"</i>`,
  ];

  return lines.join("\n");
}

function formatStaleTodo(insight: InsightCandidate): string {
  const meta = insight.metadata;
  const days = typeof meta.days_stale === "number" ? meta.days_stale : 0;
  const important = meta.important === true;

  const lines: string[] = [
    `<b>${escapeHtml(insight.title)}</b>`,
    "",
    escapeHtml(insight.body),
  ];

  if (important) {
    lines.push("", "This is marked as important.");
  }

  if (days > 14) {
    lines.push("", "Consider breaking it into a smaller next step, deferring to someday, or completing it.");
  }

  return lines.join("\n");
}

export function formatInsightNotification(insight: InsightCandidate): string {
  switch (insight.type) {
    case "temporal_echo":
      return formatTemporalEcho(insight);
    case "biometric_correlation":
      return formatBiometricCorrelation(insight);
    case "stale_todo":
      return formatStaleTodo(insight);
  }
}
