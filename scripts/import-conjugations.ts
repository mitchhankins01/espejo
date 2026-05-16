/**
 * Import vendored Spanish conjugation data into the `conjugations` table.
 *
 *   pnpm import:conjugations
 *
 * Reads:
 *   - data/conjugations-es/verbs.json   — flat array of raw cells (verbecc-derived)
 *   - data/verb-frequency-es.txt        — Hermit Dave word/rank list, one per line
 *
 * Each input row is normalized (subject pronoun stripped, reflexive clitics
 * stripped, voseo dropped), classified into a pattern bucket via
 * `classifyPattern`, joined to the frequency rank for its lemma, then
 * upserted with `(lemma, tense, person)` as the conflict key. Re-runs are
 * idempotent and refresh `frequency_rank` / `pattern` / `form` in place.
 */

import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import {
  classifyPattern,
  type Person,
  type Tense,
} from "./lib/pattern-classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = path.resolve(__dirname, "..", "data");
const VERBS_JSON_PATH = path.join(DATA_DIR, "conjugations-es", "verbs.json");
const FREQUENCY_PATH = path.join(DATA_DIR, "verb-frequency-es.txt");

interface RawCell {
  lemma: string;
  tense: string;
  person: string;
  /** Subject pronoun + form (verbecc style). Used for normalization tests. */
  raw_form?: string;
  /** Already-stripped form (preferred when verbecc exposes it directly). */
  form?: string;
  template?: string | null;
}

interface NormalizedCell {
  lemma: string;
  tense: Tense;
  person: Person;
  form: string;
  template: string | null;
}

const VALID_TENSES = new Set<string>([
  "present_indicative",
  "preterite",
  "imperfect",
  "future_indicative",
  "conditional",
  "present_perfect",
  "pluperfect",
  "future_perfect",
  "conditional_perfect",
  "present_subjunctive",
  "imperfect_subjunctive",
  "present_perfect_subjunctive",
  "pluperfect_subjunctive",
  "imperative_affirmative",
  "imperative_negative",
]);

// Raw person token → normalized person. Handles raw verbecc variants and a
// few hand-typed spellings the contract describes.
const PERSON_MAP: Record<string, Person | "drop"> = {
  yo: "yo",
  tu: "tu",
  tú: "tu",
  "tu (you)": "tu",
  el: "el",
  él: "el",
  "él/ella/usted": "el",
  ella: "el",
  usted: "el",
  ud: "el",
  nosotros: "nosotros",
  "nosotros/as": "nosotros",
  vosotros: "vosotros",
  "vosotros/as": "vosotros",
  ellos: "ellos",
  ellas: "ellos",
  ustedes: "ellos",
  uds: "ellos",
  "ellos/ellas/ustedes": "ellos",
  vos: "drop",
};

const SUBJECT_PRONOUN_STRIP = new Set([
  "yo",
  "tú",
  "tu",
  "él",
  "ella",
  "usted",
  "ud",
  "nosotros",
  "nosotras",
  "vosotros",
  "vosotras",
  "ellos",
  "ellas",
  "ustedes",
  "uds",
]);

const REFLEXIVE_CLITICS = new Set(["me", "te", "se", "nos", "os"]);

function loadFrequency(): Map<string, number> {
  if (!fs.existsSync(FREQUENCY_PATH)) return new Map();
  const map = new Map<string, number>();
  const lines = fs.readFileSync(FREQUENCY_PATH, "utf-8").split("\n");
  let nextRank = 1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [word] = trimmed.split(/\s+/);
    if (!word) continue;
    if (!map.has(word)) {
      map.set(word.toLowerCase(), nextRank);
      nextRank += 1;
    }
  }
  return map;
}

function loadVerbsJson(): RawCell[] {
  const raw = fs.readFileSync(VERBS_JSON_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("verbs.json must be an array of cells");
  }
  return parsed as RawCell[];
}

/** Strip leading subject pronoun and reflexive clitics from a raw form. */
export function stripPronouns(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  // Strip subject pronoun
  const firstSpace = s.indexOf(" ");
  if (firstSpace !== -1) {
    const head = s.slice(0, firstSpace).toLowerCase();
    if (SUBJECT_PRONOUN_STRIP.has(head)) {
      s = s.slice(firstSpace + 1).trim();
    }
  }
  // Strip leading reflexive clitic (handles `me levanto`, `te dormiste`, etc.)
  const nextSpace = s.indexOf(" ");
  if (nextSpace !== -1) {
    const head = s.slice(0, nextSpace).toLowerCase();
    if (REFLEXIVE_CLITICS.has(head)) {
      s = s.slice(nextSpace + 1).trim();
    }
  }
  return s;
}

/** Strip enclitic reflexive pronouns from imperative-affirmative forms
 *  (e.g. `levántate` → `levanta`, `levántese` → `levante`). */
function stripEncliticReflexive(form: string): string {
  const suffixes = ["monos", "te", "se", "nos", "os"];
  // We don't actually need to demote levántate → levanta for the v1 system —
  // we just keep the raw form. (The contract above says strip clitics from
  // `me levanto`, not from `levántate`.) Leaving this here intentionally as a
  // future hook; today the simple identity is correct.
  void suffixes;
  return form;
}

function normalize(cell: RawCell): NormalizedCell | null {
  if (!VALID_TENSES.has(cell.tense)) return null;
  const personKey = String(cell.person ?? "").toLowerCase();
  const personMapped = PERSON_MAP[personKey];
  if (!personMapped || personMapped === "drop") return null;

  // Imperative skips yo entirely.
  if (
    (cell.tense === "imperative_affirmative" ||
      cell.tense === "imperative_negative") &&
    personMapped === "yo"
  ) {
    return null;
  }

  let form: string;
  if (cell.form && cell.form.trim()) {
    form = cell.form.trim();
  } else if (cell.raw_form) {
    form = stripPronouns(cell.raw_form);
  } else {
    return null;
  }
  form = form.replace(/\s+/g, " ").trim();
  if (!form) return null;
  // Strip enclitic clitics in imperative-affirmatives (future hook).
  if (cell.tense === "imperative_affirmative") {
    form = stripEncliticReflexive(form);
  }
  // Strip leading reflexive clitic again in case verbecc emitted `me levanto`
  // under `form` directly (the test contract requires this normalization).
  const lead = form.split(" ")[0]?.toLowerCase();
  if (lead && REFLEXIVE_CLITICS.has(lead)) {
    form = form.slice(lead.length + 1).trim();
  }
  return {
    lemma: cell.lemma,
    tense: cell.tense as Tense,
    person: personMapped,
    form,
    template: cell.template ?? null,
  };
}

interface ImportSummary {
  attempted: number;
  inserted: number;
  updated: number;
  skipped: number;
  duplicatesDropped: number;
}

export async function importConjugations(
  pool: pg.Pool,
  rawCells: RawCell[],
  frequency: Map<string, number>
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    attempted: rawCells.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    duplicatesDropped: 0,
  };

  // Normalize then deduplicate on (lemma, tense, person). Last-wins among
  // duplicates, which mirrors verbecc's typical "prefer non-voseo" emission.
  const dedup = new Map<string, NormalizedCell>();
  for (const raw of rawCells) {
    const normalized = normalize(raw);
    if (!normalized) {
      summary.skipped += 1;
      continue;
    }
    const key = `${normalized.lemma}|${normalized.tense}|${normalized.person}`;
    if (dedup.has(key)) {
      summary.duplicatesDropped += 1;
    }
    dedup.set(key, normalized);
  }

  for (const cell of dedup.values()) {
    const pattern = classifyPattern({
      lemma: cell.lemma,
      tense: cell.tense,
      person: cell.person,
      form: cell.form,
      template: cell.template,
    });
    const rank = frequency.get(cell.lemma.toLowerCase()) ?? null;
    const result = await pool.query<{ xmax: string }>(
      `INSERT INTO conjugations
         (lemma, tense, person, form, pattern, source_template, frequency_rank)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (lemma, tense, person) DO UPDATE SET
         form            = EXCLUDED.form,
         pattern         = EXCLUDED.pattern,
         source_template = EXCLUDED.source_template,
         frequency_rank  = EXCLUDED.frequency_rank
       RETURNING xmax::text AS xmax`,
      [
        cell.lemma,
        cell.tense,
        cell.person,
        cell.form,
        pattern,
        cell.template,
        rank,
      ]
    );
    // xmax = '0' on a fresh insert; non-zero when the row was updated.
    const wasUpdate = result.rows[0]?.xmax !== "0";
    if (wasUpdate) summary.updated += 1;
    else summary.inserted += 1;
  }

  return summary;
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ||
    (process.env.NODE_ENV === "test"
      ? "postgresql://test:test@localhost:5433/journal_test"
      : "postgresql://dev:dev@localhost:5434/journal_dev");

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const rawCells = loadVerbsJson();
    const frequency = loadFrequency();
    console.log(
      `Importing ${rawCells.length} raw cells with ${frequency.size} ranked verbs…`
    );
    const summary = await importConjugations(pool, rawCells, frequency);
    console.log(
      `Done. inserted=${summary.inserted} updated=${summary.updated} skipped=${summary.skipped} duplicates_dropped=${summary.duplicatesDropped}`
    );
  } finally {
    await pool.end();
  }
}

// Run only when invoked directly (`pnpm import:conjugations`). The check
// resolves the entrypoint URL the same way Node does so test imports never
// trigger it.
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  main().catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  });
}
