import { pool } from "../../src/db/client.js";
import { embedTextSimple } from "../../src/llm/index.js";
import type { Candidate } from "./planner.js";

/**
 * Optional academic grounding. The Madriguera workflow persists fetched paper
 * abstracts to the vault's Reference/Academic/ folder; they sync into
 * `knowledge_artifacts` (kind='reference') WITH embeddings. For a picked
 * candidate we embed its pitch and cosine-match the closest few papers so the
 * writer can ground domain claims in real fetched science instead of
 * hallucinating — but only as enrichment: if nothing matches well, we inject
 * nothing and the writer stays generic.
 *
 * NB: `knowledge_artifacts` has no tags column (obsidian sync only persists
 * source_path/title/body/kind), so we select the academic corpus by source_path.
 */

const ACADEMIC_PATH_LIKE = "%Reference/Academic/%";
const TOP_K = 3;
// Relative floor: keep the best match, drop anything more than this far below it.
const REL_DELTA = 0.08;
// Absolute sanity floor — text-embedding-3-small related-doc sims cluster low,
// so this is intentionally generous; below it the "match" is noise.
const ABS_FLOOR = 0.3;
const ABSTRACT_CHARS = 1200;

export interface AcademicMatch {
  title: string;
  abstract: string;
  similarity: number;
}

/** Count academic papers that actually have embeddings (the matchable corpus). */
export async function academicCorpusSize(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::int AS n
       FROM knowledge_artifacts
      WHERE kind = 'reference'
        AND deleted_at IS NULL
        AND source_path LIKE $1
        AND embedding IS NOT NULL`,
    [ACADEMIC_PATH_LIKE]
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Cosine-match the closest academic papers to a candidate's pitch. */
export async function matchAcademic(plan: Candidate): Promise<AcademicMatch[]> {
  const query = `${plan.topic}. ${plan.angle} ${plan.take}`;
  const vec = await embedTextSimple(query);
  const vecLiteral = `[${vec.join(",")}]`;
  const r = await pool.query(
    `SELECT title, body, 1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge_artifacts
      WHERE kind = 'reference'
        AND deleted_at IS NULL
        AND source_path LIKE $2
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [vecLiteral, ACADEMIC_PATH_LIKE, TOP_K]
  );
  const rows = r.rows.map((row) => ({
    title: row.title as string,
    abstract: (row.body as string) ?? "",
    similarity: Number(row.similarity),
  }));
  if (rows.length === 0) return [];
  const best = rows[0].similarity;
  return rows.filter(
    (m) => m.similarity >= ABS_FLOOR && m.similarity >= best - REL_DELTA
  );
}

/** Format matched papers into the writer's optional "Research grounding" block. */
export function formatAcademicForWriter(matches: AcademicMatch[]): string {
  if (matches.length === 0) return "";
  const papers = matches
    .map((m) => {
      const abstract = m.abstract.replace(/\s+/g, " ").trim().slice(0, ABSTRACT_CHARS);
      return `- ${m.title} (similarity ${m.similarity.toFixed(2)})\n  ${abstract}`;
    })
    .join("\n\n");
  return [
    "# Research grounding (optional)",
    "Real fetched paper abstracts that may relate to this tomo's domain. You MAY cite one or two (surname + year, which is in the title) for a domain claim — but ONLY if a paper directly supports the specific point. If none fit the narrative, IGNORE them entirely and stay generic. Never contort the essay to wedge a paper in. Do not cite any paper not listed here.",
    "",
    papers,
  ].join("\n");
}

/**
 * Extract surnames mentioned in the writer's source-citation block (the titles
 * are "Surname YEAR — Title"), for a post-write allowlist check. Returns the set
 * of lowercase surnames that are legitimately citable.
 */
export function citableSurnames(matches: AcademicMatch[]): Set<string> {
  const out = new Set<string>();
  for (const m of matches) {
    const first = m.title.trim().split(/\s+/)[0];
    if (first) out.add(first.toLowerCase());
  }
  return out;
}
