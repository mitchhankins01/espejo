/**
 * Dedup Stage 1 — retrieval. Hybrid RRF + intra-batch cluster, emits JSON plan
 * for the council (Stage 2).
 *
 * Usage:
 *   pnpm dedup:retrieve --mode pending             # pending → Insight only, intra-batch clustered separately
 *   pnpm dedup:retrieve --mode existing            # Insight pairwise sweep
 *   pnpm dedup:retrieve --mode existing --threshold 0.27
 *   pnpm dedup:retrieve --mode existing --top 10
 *   pnpm dedup:retrieve --mode pending --intra-batch-threshold 0.15
 *
 * Mode pending emits TWO outputs:
 *   - `plan[]`              — each Pending source × top-K Insight candidates (council classifies)
 *   - `intra_batch_dups[]`  — Pending × Pending pairs above the intra-batch sim threshold
 *                             (pre-classified as Duplicate, survivor = longer body; council never sees them).
 *
 * The 2026-05-28 split fixes the "council merges two Pending twins into a
 * synthetic combined body" failure mode. Intra-batch near-twins are a Phase 1
 * over-extraction artifact and should be resolved by survivor-selection, not
 * by 3-leg deliberation + body synthesis.
 *
 * Output: JSON to stdout. No DB writes, no filesystem mutations.
 *
 * Bakes in 2026-04-26 council-review fixes:
 *   - Parameterized SQL
 *   - websearch_to_tsquery (BM25-on-long-bodies fix)
 *   - Strip "## Sources" before embedding (matches embed-entries.ts)
 *   - NFC-normalize filesystem paths
 *   - Filesystem manifest is authoritative
 */
import { readdir } from "fs/promises";
import { normalize } from "path";
import OpenAI from "openai";
import "dotenv/config";
import { pool } from "../../src/db/client.js";
import { config } from "../../src/config.js";

const INSIGHT_DIR = "Artifacts/Insight";
const PENDING_DIR = "Artifacts/Pending";
const EMBED_MODEL = config.openai.embeddingModel;
const RRF_K = 60;
const SEMANTIC_LIMIT = 20;
const FULLTEXT_LIMIT = 20;

// ─── args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const arg = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const mode = arg("--mode") as "pending" | "existing" | null;
if (mode !== "pending" && mode !== "existing") {
  console.error("Usage: --mode pending|existing");
  console.error("Optional: --threshold 0.27  --top 50  --candidates 10");
  process.exit(1);
}

const threshold = Number(arg("--threshold") ?? "0.27");
const topN = Number(arg("--top") ?? "100");
const candidatesPerSource = Number(arg("--candidates") ?? "10");
// Intra-batch near-twin threshold: pairs at or below this cosine distance are
// resolved by survivor-selection (longer body wins) and skip the council.
// 0.15 ≈ 0.85 cosine similarity — chosen conservatively; tuning lever.
const intraBatchThreshold = Number(arg("--intra-batch-threshold") ?? "0.15");

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip "## Sources" section before embedding so retrieval matches what
 * scripts/embed-entries.ts:167 indexed. Otherwise pendings would match on
 * shared wikilink targets, not actual content similarity.
 */
function stripSources(body: string): string {
  const idx = body.search(/^## Sources\s*$/m);
  return (idx === -1 ? body : body.slice(0, idx)).trim();
}

async function listSourcePaths(dir: string, prefix: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return files
    .filter((f) => f.endsWith(".md"))
    .map((f) => normalize(`${prefix}/${f}`).normalize("NFC"));
}

interface Candidate {
  id: string;
  title: string;
  body: string;
  source_path: string;
  rrf_score: number;
  cosine_distance: number | null;
  has_semantic: boolean;
  has_fulltext: boolean;
}

interface SourceArtifact {
  id: string;
  title: string;
  body: string;
  source_path: string;
}

interface CandidatePairPlan {
  source: SourceArtifact;
  candidates: Candidate[];
}

interface PairwisePlan {
  a: SourceArtifact;
  b: SourceArtifact;
  cosine_distance: number;
}

interface IntraBatchDup {
  loser_path: string;
  loser_title: string;
  survivor_path: string;
  survivor_title: string;
  cosine_distance: number;
  reason: string;
}

interface ModePendingOutput {
  plan: CandidatePairPlan[];
  intra_batch_dups: IntraBatchDup[];
}

// ─── modes ───────────────────────────────────────────────────────────────────

/**
 * MODE A: each pending insight → top-K Insight candidates for the council,
 * PLUS a separate intra-batch dup list (Pending × Pending near-twins resolved
 * by survivor-selection).
 *
 * Pending IS already in the DB (per src/obsidian/sync.ts:30 — only .obsidian/,
 * .trash/, Templates/ are excluded). So we use its existing embedding rather
 * than embedding the body fresh. Falls back to embedding-on-the-fly only if
 * the pending row has no embedding yet (sync hasn't run, or content changed
 * and embedding was invalidated per src/db/queries/obsidian.ts:105).
 */
async function modePending(): Promise<ModePendingOutput> {
  const pendingPaths = await listSourcePaths(PENDING_DIR, "Pending");
  const insightPaths = await listSourcePaths(INSIGHT_DIR, "Insight");
  if (pendingPaths.length === 0) return { plan: [], intra_batch_dups: [] };

  // Pendings: rows that exist on disk AND in the DB.
  const pendings = await pool.query<{
    id: string;
    title: string;
    body: string;
    source_path: string;
    has_embedding: boolean;
  }>(
    `SELECT id, title, body, source_path,
            (embedding IS NOT NULL) AS has_embedding
       FROM knowledge_artifacts
      WHERE kind = 'insight'
        AND source = 'obsidian'
        AND source_path = ANY($1::text[])
        AND deleted_at IS NULL
      ORDER BY source_path`,
    [pendingPaths]
  );

  if (pendings.rows.length === 0) {
    console.error(
      `No DB rows for ${pendingPaths.length} pending file(s). Run \`pnpm sync:obsidian\` first.`
    );
    return { plan: [], intra_batch_dups: [] };
  }

  // ─── Intra-batch cluster sweep ─────────────────────────────────────────────
  // Find Pending × Pending pairs at/below the intra-batch threshold. Build
  // clusters via union-find; in each cluster, the longest-body file wins
  // (tiebreak: source_path lex order, deterministic). Losers skip the council
  // and flow straight through synth as Duplicates.
  const intraDups: IntraBatchDup[] = [];
  const loserSet = new Set<string>();

  if (pendings.rows.length >= 2) {
    const pairs = await pool.query<{
      a_path: string;
      a_title: string;
      a_len: number;
      b_path: string;
      b_title: string;
      b_len: number;
      cosine_distance: number;
    }>(
      `WITH pending_rows AS (
         SELECT id, title, body, source_path, embedding
           FROM knowledge_artifacts
          WHERE kind = 'insight'
            AND source = 'obsidian'
            AND source_path = ANY($1::text[])
            AND deleted_at IS NULL
            AND embedding IS NOT NULL
       )
       SELECT a.source_path  AS a_path,
              a.title        AS a_title,
              LENGTH(a.body) AS a_len,
              b.source_path  AS b_path,
              b.title        AS b_title,
              LENGTH(b.body) AS b_len,
              (a.embedding <=> b.embedding)::float AS cosine_distance
         FROM pending_rows a
         JOIN pending_rows b ON a.source_path < b.source_path
        WHERE (a.embedding <=> b.embedding) <= $2
        ORDER BY cosine_distance ASC`,
      [pendingPaths, intraBatchThreshold]
    );

    // Union-find over Pending paths
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r) as string;
      // path compression
      let cur = x;
      while (parent.get(cur) !== r) {
        const next = parent.get(cur) as string;
        parent.set(cur, r);
        cur = next;
      }
      return r;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const row of pairs.rows) {
      union(row.a_path, row.b_path);
    }

    // Group members by root and pick survivor per cluster: longest body wins,
    // tiebreak by source_path ascending (deterministic).
    const meta = new Map(pendings.rows.map(p => [p.source_path, { title: p.title, len: p.body.length }]));
    const clusters = new Map<string, string[]>();
    for (const p of pendings.rows) {
      if (!parent.has(p.source_path)) continue; // not in any pair
      const root = find(p.source_path);
      if (!clusters.has(root)) clusters.set(root, []);
      (clusters.get(root) as string[]).push(p.source_path);
    }

    // Build a fast lookup of pairwise cosine distance for reason-printing
    const dist = new Map<string, number>();
    for (const row of pairs.rows) {
      dist.set(`${row.a_path}\t${row.b_path}`, row.cosine_distance);
      dist.set(`${row.b_path}\t${row.a_path}`, row.cosine_distance);
    }

    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      // Survivor: longest body, lex-tiebreak ascending
      members.sort((a, b) => {
        const la = meta.get(a)?.len ?? 0, lb = meta.get(b)?.len ?? 0;
        if (la !== lb) return lb - la;
        return a < b ? -1 : 1;
      });
      const survivor = members[0];
      for (const loser of members.slice(1)) {
        loserSet.add(loser);
        const cd = dist.get(`${loser}\t${survivor}`) ?? 0;
        intraDups.push({
          loser_path: loser,
          loser_title: meta.get(loser)?.title ?? loser,
          survivor_path: survivor,
          survivor_title: meta.get(survivor)?.title ?? survivor,
          cosine_distance: cd,
          reason: `intra-batch near-twin (cosine ${cd.toFixed(3)} ≤ ${intraBatchThreshold}); survivor has longer body`,
        });
      }
    }
  }

  // ─── Council plan: surviving Pendings × Insight candidates only ────────────
  const plan: CandidatePairPlan[] = [];
  let openai: OpenAI | null = null;

  for (const p of pendings.rows) {
    if (loserSet.has(p.source_path)) continue; // handled by intra-batch dedup

    let embedding: string | null = null;

    if (p.has_embedding) {
      // Fetch the existing embedding as a string for the SQL cast.
      const r = await pool.query<{ embedding: string }>(
        `SELECT embedding::text AS embedding FROM knowledge_artifacts WHERE id = $1`,
        [p.id]
      );
      embedding = r.rows[0]?.embedding ?? null;
    }

    if (!embedding) {
      if (!openai) {
        if (!process.env.OPENAI_API_KEY) {
          console.error(
            `Pending ${p.source_path} has no embedding and OPENAI_API_KEY is unset.`
          );
          continue;
        }
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      }
      const text = `${p.title}\n\n${stripSources(p.body)}`;
      const emb = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
      embedding = `[${emb.data[0].embedding.join(",")}]`;
    }

    // Council sees Insight candidates only — Pending twins are pre-resolved above.
    const candidates = await rrfCandidates(embedding, p.title, p.id, insightPaths);
    plan.push({
      source: { id: p.id, title: p.title, body: p.body, source_path: p.source_path },
      candidates,
    });
  }

  return { plan, intra_batch_dups: intraDups };
}

/**
 * Hybrid RRF over kind='insight', filtered to filesystem manifest of the
 * candidate pool (Insight or Insight ∪ Pending depending on caller). Mirrors
 * src/db/queries/artifacts.ts:620 (searchArtifacts) but scoped tighter.
 */
async function rrfCandidates(
  embedding: string,
  queryText: string,
  excludeId: string,
  candidatePool: string[]
): Promise<Candidate[]> {
  const sql = `
    WITH params AS (
      SELECT
        $1::vector AS qe,
        websearch_to_tsquery('english', $2) AS tq
    ),
    semantic AS (
      SELECT a.id,
             ROW_NUMBER() OVER (ORDER BY a.embedding <=> p.qe) AS rank_s,
             (a.embedding <=> p.qe)::float AS dist
        FROM knowledge_artifacts a, params p
       WHERE a.kind = 'insight'
         AND a.deleted_at IS NULL
         AND a.embedding IS NOT NULL
         AND a.source_path = ANY($3::text[])
         AND a.id <> $4
       ORDER BY a.embedding <=> p.qe
       LIMIT ${SEMANTIC_LIMIT}
    ),
    fulltext AS (
      SELECT a.id,
             ROW_NUMBER() OVER (ORDER BY ts_rank(a.tsv, p.tq) DESC) AS rank_f
        FROM knowledge_artifacts a, params p
       WHERE a.kind = 'insight'
         AND a.deleted_at IS NULL
         AND a.tsv @@ p.tq
         AND a.source_path = ANY($3::text[])
         AND a.id <> $4
       ORDER BY ts_rank(a.tsv, p.tq) DESC
       LIMIT ${FULLTEXT_LIMIT}
    )
    SELECT a.id, a.title, a.body, a.source_path,
           COALESCE(1.0 / (${RRF_K} + s.rank_s), 0)
         + COALESCE(1.0 / (${RRF_K} + f.rank_f), 0) AS rrf_score,
           s.dist AS cosine_distance,
           s.id IS NOT NULL AS has_semantic,
           f.id IS NOT NULL AS has_fulltext
      FROM knowledge_artifacts a
 LEFT JOIN semantic s ON s.id = a.id
 LEFT JOIN fulltext f ON f.id = a.id
     WHERE s.id IS NOT NULL OR f.id IS NOT NULL
  ORDER BY rrf_score DESC
     LIMIT $5
  `;

  const r = await pool.query(sql, [
    embedding,
    queryText,
    candidatePool,
    excludeId,
    candidatesPerSource,
  ]);

  return r.rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    body: row.body as string,
    source_path: row.source_path as string,
    rrf_score: parseFloat(row.rrf_score as string),
    cosine_distance:
      row.cosine_distance === null ? null : parseFloat(row.cosine_distance as string),
    has_semantic: row.has_semantic as boolean,
    has_fulltext: row.has_fulltext as boolean,
  }));
}

/**
 * MODE B: pairwise cosine sweep over Insight/* below threshold.
 *
 * Single query at the top threshold, ordered by distance — no multi-pass band
 * choreography. Filesystem manifest filters out DB rows whose file is gone.
 */
async function modeExisting(): Promise<PairwisePlan[]> {
  const insightPaths = await listSourcePaths(INSIGHT_DIR, "Insight");
  if (insightPaths.length === 0) return [];

  const sql = `
    WITH insights AS (
      SELECT id, title, body, source_path, embedding
        FROM knowledge_artifacts
       WHERE kind = 'insight'
         AND deleted_at IS NULL
         AND embedding IS NOT NULL
         AND source_path = ANY($1::text[])
    )
    SELECT (a.embedding <=> b.embedding)::float AS dist,
           a.id   AS a_id,   a.title AS a_title,
           a.body AS a_body, a.source_path AS a_path,
           b.id   AS b_id,   b.title AS b_title,
           b.body AS b_body, b.source_path AS b_path
      FROM insights a JOIN insights b ON b.id > a.id
     WHERE a.embedding <=> b.embedding < $2
  ORDER BY a.embedding <=> b.embedding
     LIMIT $3
  `;

  const r = await pool.query(sql, [insightPaths, threshold, topN]);

  return r.rows.map((row) => ({
    a: {
      id: row.a_id as string,
      title: row.a_title as string,
      body: row.a_body as string,
      source_path: row.a_path as string,
    },
    b: {
      id: row.b_id as string,
      title: row.b_title as string,
      body: row.b_body as string,
      source_path: row.b_path as string,
    },
    cosine_distance: parseFloat(row.dist as string),
  }));
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (mode === "pending") {
    const { plan, intra_batch_dups } = await modePending();
    console.log(
      JSON.stringify(
        {
          mode: "pending",
          generated_at: new Date().toISOString(),
          source_count: plan.length,
          intra_batch_dup_count: intra_batch_dups.length,
          intra_batch_threshold: intraBatchThreshold,
          candidates_per_source: candidatesPerSource,
          plan,
          intra_batch_dups,
        },
        null,
        2
      )
    );
  } else {
    const plan = await modeExisting();
    console.log(
      JSON.stringify(
        {
          mode: "existing",
          generated_at: new Date().toISOString(),
          threshold,
          top: topN,
          pair_count: plan.length,
          plan,
        },
        null,
        2
      )
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
