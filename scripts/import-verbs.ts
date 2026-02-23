import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}
import fs from "fs";
import path from "path";
import pg from "pg";

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://dev:dev@localhost:5434/journal_dev";

const VERBS_CSV_URL =
  "https://raw.githubusercontent.com/ghidinelli/fred-jehle-spanish-verbs/master/jehle_verb_database.csv";
const CACHE_DIR = path.resolve("data");
const CACHE_FILE = path.join(CACHE_DIR, "jehle_verb_database.csv");
const PROGRESS_EVERY = 500;

interface VerbCsvRow {
  infinitive: string;
  infinitive_english: string;
  mood: string;
  tense: string;
  verb_english: string;
  form_1s: string;
  form_2s: string;
  form_3s: string;
  form_1p: string;
  form_2p: string;
  form_3p: string;
  gerund: string;
  pastparticiple: string;
}

function elapsed(start: bigint): string {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map((value) => value.trim());
}

function parseCsv(content: string): VerbCsvRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]);
  const headerIndex = new Map<string, number>();
  for (let i = 0; i < header.length; i++) {
    headerIndex.set(header[i].replace(/^"|"$/g, ""), i);
  }

  const required = [
    "infinitive",
    "infinitive_english",
    "mood",
    "tense",
    "verb_english",
    "form_1s",
    "form_2s",
    "form_3s",
    "form_1p",
    "form_2p",
    "form_3p",
    "gerund",
    "pastparticiple",
  ];

  for (const key of required) {
    if (!headerIndex.has(key)) {
      throw new Error(`Missing required CSV column: ${key}`);
    }
  }

  const rows: VerbCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const get = (key: string): string => {
      const idx = headerIndex.get(key)!;
      return (cells[idx] ?? "").replace(/^"|"$/g, "");
    };

    rows.push({
      infinitive: get("infinitive"),
      infinitive_english: get("infinitive_english"),
      mood: get("mood"),
      tense: get("tense"),
      verb_english: get("verb_english"),
      form_1s: get("form_1s"),
      form_2s: get("form_2s"),
      form_3s: get("form_3s"),
      form_1p: get("form_1p"),
      form_2p: get("form_2p"),
      form_3p: get("form_3p"),
      gerund: get("gerund"),
      pastparticiple: get("pastparticiple"),
    });
  }

  return rows;
}

function expectedRegularForms(infinitive: string): {
  form_1s: string;
  form_2s: string;
  form_3s: string;
  form_1p: string;
  form_2p: string;
  form_3p: string;
  gerund: string;
  pastParticiple: string;
} | null {
  const lower = infinitive.toLowerCase();
  if (lower.length < 3) return null;
  const ending = lower.slice(-2);
  const stem = lower.slice(0, -2);

  if (ending === "ar") {
    return {
      form_1s: `${stem}o`,
      form_2s: `${stem}as`,
      form_3s: `${stem}a`,
      form_1p: `${stem}amos`,
      form_2p: `${stem}áis`,
      form_3p: `${stem}an`,
      gerund: `${stem}ando`,
      pastParticiple: `${stem}ado`,
    };
  }

  if (ending === "er") {
    return {
      form_1s: `${stem}o`,
      form_2s: `${stem}es`,
      form_3s: `${stem}e`,
      form_1p: `${stem}emos`,
      form_2p: `${stem}éis`,
      form_3p: `${stem}en`,
      gerund: `${stem}iendo`,
      pastParticiple: `${stem}ido`,
    };
  }

  if (ending === "ir") {
    return {
      form_1s: `${stem}o`,
      form_2s: `${stem}es`,
      form_3s: `${stem}e`,
      form_1p: `${stem}imos`,
      form_2p: `${stem}ís`,
      form_3p: `${stem}en`,
      gerund: `${stem}iendo`,
      pastParticiple: `${stem}ido`,
    };
  }

  return null;
}

function isLikelyIrregular(row: VerbCsvRow): boolean {
  const expected = expectedRegularForms(row.infinitive);
  if (!expected) return false;

  const mood = row.mood.toLowerCase();
  const tense = row.tense.toLowerCase();

  if (mood.includes("indicativo") && tense.includes("presente")) {
    return (
      row.form_1s.toLowerCase() !== expected.form_1s ||
      row.form_2s.toLowerCase() !== expected.form_2s ||
      row.form_3s.toLowerCase() !== expected.form_3s ||
      row.form_1p.toLowerCase() !== expected.form_1p ||
      row.form_2p.toLowerCase() !== expected.form_2p ||
      row.form_3p.toLowerCase() !== expected.form_3p
    );
  }

  return (
    row.gerund.toLowerCase() !== expected.gerund ||
    row.pastparticiple.toLowerCase() !== expected.pastParticiple
  );
}

async function ensureCsv(refresh: boolean): Promise<string> {
  if (!refresh && fs.existsSync(CACHE_FILE)) {
    return fs.readFileSync(CACHE_FILE, "utf-8");
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`Downloading verb dataset from ${VERBS_CSV_URL}`);
  const response = await fetch(VERBS_CSV_URL);
  if (!response.ok) {
    throw new Error(`Failed to download verb CSV (${response.status} ${response.statusText})`);
  }
  const text = await response.text();
  fs.writeFileSync(CACHE_FILE, text, "utf-8");
  console.log(`Saved CSV cache to ${CACHE_FILE}`);
  return text;
}

async function importVerbs(refresh: boolean): Promise<void> {
  const t0 = process.hrtime.bigint();
  const csv = await ensureCsv(refresh);
  const rows = parseCsv(csv);
  if (rows.length === 0) {
    throw new Error("CSV parse produced 0 rows.");
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("SELECT 1");
    console.log(`PostgreSQL connected. Importing ${rows.length} rows...`);
    await pool.query("BEGIN");

    let imported = 0;
    for (const row of rows) {
      if (!row.infinitive || !row.mood || !row.tense) continue;
      await pool.query(
        `INSERT INTO spanish_verbs (
          infinitive,
          infinitive_english,
          mood,
          tense,
          verb_english,
          form_1s,
          form_2s,
          form_3s,
          form_1p,
          form_2p,
          form_3p,
          gerund,
          past_participle,
          is_irregular,
          source
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11,
          $12, $13, $14, 'jehle'
        )
        ON CONFLICT (infinitive, mood, tense) DO UPDATE SET
          infinitive_english = EXCLUDED.infinitive_english,
          verb_english = EXCLUDED.verb_english,
          form_1s = EXCLUDED.form_1s,
          form_2s = EXCLUDED.form_2s,
          form_3s = EXCLUDED.form_3s,
          form_1p = EXCLUDED.form_1p,
          form_2p = EXCLUDED.form_2p,
          form_3p = EXCLUDED.form_3p,
          gerund = EXCLUDED.gerund,
          past_participle = EXCLUDED.past_participle,
          is_irregular = EXCLUDED.is_irregular,
          source = EXCLUDED.source`,
        [
          row.infinitive.toLowerCase(),
          row.infinitive_english || null,
          row.mood,
          row.tense,
          row.verb_english || null,
          row.form_1s || null,
          row.form_2s || null,
          row.form_3s || null,
          row.form_1p || null,
          row.form_2p || null,
          row.form_3p || null,
          row.gerund || null,
          row.pastparticiple || null,
          isLikelyIrregular(row),
        ]
      );
      imported++;
      if (imported % PROGRESS_EVERY === 0) {
        console.log(`  Imported ${imported}/${rows.length}...`);
      }
    }

    await pool.query("COMMIT");
    const countResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM spanish_verbs"
    );
    console.log(
      `Done. Upserted ${imported} rows. Table count: ${countResult.rows[0].count}. [${elapsed(t0)}]`
    );
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  } finally {
    await pool.end();
  }
}

const refresh = process.argv.includes("--refresh");
importVerbs(refresh).catch((err) => {
  console.error("Verb import failed:", err);
  process.exit(1);
});

