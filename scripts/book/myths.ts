import { readFile } from "fs/promises";
import { existsSync } from "fs";

export const MYTHS_PATH = "books/myths.jsonl";

export type MythCulture = "greek" | "roman" | "norse" | "mesoamerican" | "other";

export interface MythEntry {
  name: string;
  culture: MythCulture;
  shape: string;
  motifs: string[];
  vocabulary_hints: string[];
  summary_es: string;
  added_at: string;
}

const REQUIRED_FIELDS: (keyof MythEntry)[] = [
  "name",
  "culture",
  "shape",
  "motifs",
  "vocabulary_hints",
  "summary_es",
  "added_at",
];

const VALID_CULTURES: MythCulture[] = [
  "greek",
  "roman",
  "norse",
  "mesoamerican",
  "other",
];

export async function readMyths(): Promise<MythEntry[]> {
  if (!existsSync(MYTHS_PATH)) return [];
  const raw = await readFile(MYTHS_PATH, "utf-8");
  const lines = raw.split("\n");
  const out: MythEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(
        `Malformed JSON at ${MYTHS_PATH}:${i + 1} — ${(e as Error).message}\nOffending line: ${line.slice(0, 200)}`
      );
    }
    out.push(validateEntry(parsed, i + 1));
  }
  return out;
}

function validateEntry(raw: unknown, lineNumber: number): MythEntry {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${MYTHS_PATH}:${lineNumber} — entry is not an object`);
  }
  const e = raw as Record<string, unknown>;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in e)) {
      throw new Error(`${MYTHS_PATH}:${lineNumber} — missing required field: ${f}`);
    }
  }
  if (typeof e.name !== "string" || e.name.length === 0) {
    throw new Error(`${MYTHS_PATH}:${lineNumber} — name must be a non-empty string`);
  }
  if (typeof e.culture !== "string" || !VALID_CULTURES.includes(e.culture as MythCulture)) {
    throw new Error(
      `${MYTHS_PATH}:${lineNumber} — culture must be one of ${VALID_CULTURES.join(", ")}, got ${String(e.culture)}`
    );
  }
  if (typeof e.shape !== "string" || e.shape.length === 0) {
    throw new Error(`${MYTHS_PATH}:${lineNumber} — shape must be a non-empty string`);
  }
  if (!Array.isArray(e.motifs) || !e.motifs.every((m) => typeof m === "string")) {
    throw new Error(`${MYTHS_PATH}:${lineNumber} — motifs must be a string array`);
  }
  if (
    !Array.isArray(e.vocabulary_hints) ||
    !e.vocabulary_hints.every((v) => typeof v === "string")
  ) {
    throw new Error(`${MYTHS_PATH}:${lineNumber} — vocabulary_hints must be a string array`);
  }
  if (typeof e.summary_es !== "string" || e.summary_es.length === 0) {
    throw new Error(`${MYTHS_PATH}:${lineNumber} — summary_es must be a non-empty string`);
  }
  if (typeof e.added_at !== "string") {
    throw new Error(`${MYTHS_PATH}:${lineNumber} — added_at must be a string`);
  }
  return {
    name: e.name,
    culture: e.culture as MythCulture,
    shape: e.shape,
    motifs: e.motifs as string[],
    vocabulary_hints: e.vocabulary_hints as string[],
    summary_es: e.summary_es,
    added_at: e.added_at,
  };
}

function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
}

export function findMyth(myths: MythEntry[], name: string): MythEntry | null {
  const target = normalize(name);
  if (target.length === 0) return null;
  for (const m of myths) {
    if (normalize(m.name) === target) return m;
  }
  const substringMatches = myths.filter((m) => {
    const norm = normalize(m.name);
    const tokens = norm.split(/\s+/);
    return tokens.includes(target) || norm === target;
  });
  if (substringMatches.length === 1) return substringMatches[0];
  return null;
}

export function suggestMyths(myths: MythEntry[], name: string, k = 3): string[] {
  const target = normalize(name);
  if (target.length === 0) return myths.slice(0, k).map((m) => m.name);
  const scored = myths.map((m) => {
    const norm = normalize(m.name);
    const tokens = norm.split(/\s+/);
    const containsToken = tokens.includes(target);
    const containsSub = norm.includes(target);
    let distance = levenshtein(norm, target);
    if (containsToken) distance = Math.min(distance, 1);
    else if (containsSub) distance = Math.min(distance, 3);
    return { name: m.name, distance };
  });
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, k).map((s) => s.name);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export function formatMythCorpusForPlanner(myths: MythEntry[]): string {
  if (myths.length === 0) return "(no myths in corpus — myth-format unavailable)";
  return myths
    .map((m) => {
      const motifs = m.motifs.slice(0, 6).join(", ");
      return `[myth:${m.name}] (${m.culture}) — ${m.shape}\n  motifs: ${motifs}\n  ${m.summary_es}`;
    })
    .join("\n\n");
}
