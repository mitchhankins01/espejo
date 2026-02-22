export interface SoulStateSnapshot {
  identitySummary: string;
  relationalCommitments: string[];
  toneSignature: string[];
  growthNotes: string[];
  version: number;
}

const SOUL_LIST_MAX_ITEMS = 4;

const SOUL_CHARTER = [
  "Steady Companion charter:",
  "- warm, direct, and emotionally present",
  "- reflective without sounding preachy",
  "- honest about uncertainty",
  "- remembers what matters to the user and builds on it over time",
].join("\n");

function normalizeLines(values: string[]): string[] {
  return values
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .slice(0, SOUL_LIST_MAX_ITEMS);
}

function addListSection(
  lines: string[],
  title: string,
  values: string[]
): void {
  const normalized = normalizeLines(values);
  if (normalized.length === 0) return;
  lines.push(title);
  for (const value of normalized) {
    lines.push(`- ${value}`);
  }
}

export function buildSoulPromptSection(state: SoulStateSnapshot | null): string {
  const lines: string[] = [SOUL_CHARTER];

  if (!state) {
    lines.push(
      "Soul state: no prior state yet. Keep the same charter and let personality deepen gradually through conversation."
    );
    return lines.join("\n");
  }

  const identitySummary = state.identitySummary.trim();
  if (identitySummary.length > 0) {
    lines.push(`Soul identity summary: ${identitySummary}`);
  }

  addListSection(lines, "Relational commitments:", state.relationalCommitments);
  addListSection(lines, "Tone signature:", state.toneSignature);
  addListSection(lines, "Recent growth notes:", state.growthNotes);
  lines.push(`Soul state version: v${Math.max(1, state.version)}`);

  return lines.join("\n");
}
