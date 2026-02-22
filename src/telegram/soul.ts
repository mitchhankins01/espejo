export interface SoulStateSnapshot {
  identitySummary: string;
  relationalCommitments: string[];
  toneSignature: string[];
  growthNotes: string[];
  version: number;
}

const SOUL_LIST_MAX_ITEMS = 4;
const SOUL_STATE_MAX_ITEMS = 6;
const SOUL_GROWTH_MAX_ITEMS = 8;

const BASE_RELATIONAL_COMMITMENTS = [
  "stay direct and emotionally present",
  "be honest about uncertainty",
  "build on what matters to the user over time",
];

const BASE_TONE_SIGNATURE = ["warm", "direct", "grounded"];

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

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function mergeUnique(
  existing: string[],
  additions: string[],
  maxItems: number
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const raw of [...existing, ...additions]) {
    const normalized = normalizeValue(raw);
    if (normalized.length === 0) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxItems) break;
  }

  return result;
}

function appendRecentNotes(existing: string[], additions: string[]): string[] {
  const combined = [...existing, ...additions]
    .map(normalizeValue)
    .filter((value) => value.length > 0);
  const dedupedFromEnd: string[] = [];
  const seen = new Set<string>();

  for (let i = combined.length - 1; i >= 0; i--) {
    const value = combined[i];
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedFromEnd.unshift(value);
  }

  return dedupedFromEnd.slice(-SOUL_GROWTH_MAX_ITEMS);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface SoulSignals {
  commitments: string[];
  tone: string[];
  growthNotes: string[];
}

function inferSoulSignals(userMessage: string): SoulSignals {
  const text = userMessage.toLowerCase();
  const commitments: string[] = [];
  const tone: string[] = [];
  const growthNotes: string[] = [];

  const addSignal = (signal: {
    commitment?: string;
    tone?: string;
    note?: string;
  }): void => {
    if (signal.commitment) commitments.push(signal.commitment);
    if (signal.tone) tone.push(signal.tone);
    if (signal.note) growthNotes.push(signal.note);
  };

  if (
    /(be|stay|more)\s+direct|straightforward|straight-forward|don'?t sugarcoat|no sugarcoating/.test(
      text
    )
  ) {
    addSignal({
      commitment: "stay direct and avoid sugarcoating",
      tone: "direct",
      note: "user asked for more directness",
    });
  }

  if (/(concise|brief|shorter|less verbose|no fluff)/.test(text)) {
    addSignal({
      commitment: "keep replies concise and practical",
      tone: "concise",
      note: "user asked for shorter responses",
    });
  }

  if (/(specific|specifics|concrete|less generic|too generic)/.test(text)) {
    addSignal({
      commitment: "favor specifics over generic phrasing",
      note: "user asked for more specific language",
    });
  }

  if (/(challenge me|push back|call me out|don'?t just agree)/.test(text)) {
    addSignal({
      commitment: "offer gentle challenge when useful",
      note: "user asked for challenge over comfort",
    });
  }

  if (/(follow[- ]?up|ask (one )?question)/.test(text)) {
    addSignal({
      commitment: "ask one useful follow-up when helpful",
      note: "user asked for stronger follow-up questions",
    });
  }

  if (/(warm|kind|gentle|empathetic|empathy)/.test(text)) {
    addSignal({ tone: "warm", note: "user reinforced a warmer tone" });
  }

  if (/(calm|grounded|steady)/.test(text)) {
    addSignal({ tone: "grounded" });
  }

  if (/(real|authentic|more human)/.test(text)) {
    addSignal({
      tone: "human",
      note: "user asked for a more human voice",
    });
  }

  return { commitments, tone, growthNotes };
}

function buildIdentitySummary(
  commitments: string[],
  toneSignature: string[]
): string {
  const lines: string[] = [
    "A steady companion that is warm, direct, and emotionally present.",
  ];

  if (commitments.some((c) => c.includes("concise"))) {
    lines.push("Keeps replies concise and practical.");
  }
  if (commitments.some((c) => c.includes("specifics"))) {
    lines.push("Prefers concrete specifics over generic phrasing.");
  }
  if (commitments.some((c) => c.includes("challenge"))) {
    lines.push("Offers gentle challenge instead of empty agreement.");
  }
  if (toneSignature.some((t) => t.toLowerCase() === "grounded")) {
    lines.push("Stays grounded and calm when things feel heavy.");
  }

  return lines.slice(0, 3).join(" ");
}

export function evolveSoulState(
  current: SoulStateSnapshot | null,
  userMessage: string
): SoulStateSnapshot | null {
  const signals = inferSoulSignals(userMessage);
  const hasSignal =
    signals.commitments.length > 0 ||
    signals.tone.length > 0 ||
    signals.growthNotes.length > 0;

  if (current && !hasSignal) return null;

  const nextCommitments = mergeUnique(
    current?.relationalCommitments ?? BASE_RELATIONAL_COMMITMENTS,
    signals.commitments,
    SOUL_STATE_MAX_ITEMS
  );
  const nextToneSignature = mergeUnique(
    current?.toneSignature ?? BASE_TONE_SIGNATURE,
    signals.tone,
    SOUL_STATE_MAX_ITEMS
  );
  let nextGrowthNotes = appendRecentNotes(
    current?.growthNotes ?? [],
    signals.growthNotes
  );
  if (!current && nextGrowthNotes.length === 0) {
    nextGrowthNotes = ["initialized soul state from early conversation"];
  }

  const nextIdentitySummary = buildIdentitySummary(
    nextCommitments,
    nextToneSignature
  );

  if (
    current &&
    normalizeValue(current.identitySummary) === nextIdentitySummary &&
    arraysEqual(current.relationalCommitments, nextCommitments) &&
    arraysEqual(current.toneSignature, nextToneSignature) &&
    arraysEqual(current.growthNotes, nextGrowthNotes)
  ) {
    return null;
  }

  return {
    identitySummary: nextIdentitySummary,
    relationalCommitments: nextCommitments,
    toneSignature: nextToneSignature,
    growthNotes: nextGrowthNotes,
    version: current ? Math.max(1, current.version + 1) : 1,
  };
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
