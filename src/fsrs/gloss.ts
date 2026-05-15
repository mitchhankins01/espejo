// Haiku enrichment for Kindle lookups. Produces gloss + IPA pronunciation +
// 5 short example sentences per word. Used by both import-lookups (online
// during sync) and the standalone backfill script. Batched 15 rows per
// request (output tokens are heavier with the multi-field schema, so the
// batch is smaller than the gloss-only days).

import type pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import {
  getRowsNeedingGloss,
  setGlossPack,
  type VocabExample,
} from "../db/queries/vocab-reviews.js";

const BATCH_SIZE = 15;

interface GlossInput {
  id: string;
  stem: string;
  lang: string;
  sample_usage: string;
}

interface RawGlossOutput {
  id?: unknown;
  gloss?: unknown;
  pronunciation?: unknown;
  examples?: unknown;
}

const SYSTEM_PROMPT =
  "You enrich Spanish vocabulary entries tapped from a Kindle. For each " +
  "entry, output:\n" +
  "- `gloss`: short English definition + part-of-speech, e.g. " +
  "`step / rung (noun)`. ≤ 60 chars. Cover the meaning that fits the " +
  "sample sentence first; add a `/`-separated alternative if the word is " +
  "ambiguous out of context.\n" +
  "- `pronunciation`: IPA in slashes, e.g. `/pelˈdaɲo/`. Include primary " +
  "stress.\n" +
  "- `examples`: array of 5 short, natural Spanish sentences using the " +
  "word in varied contexts. Each ≤ 80 chars. Each is `{es, en}` where " +
  "`en` is a tight English translation. Vary tense, register, and topic " +
  "so the learner sees the word from multiple angles.\n" +
  "Output strict JSON: an array of `{id, gloss, pronunciation, examples}` " +
  "objects. No preface, no commentary, no Markdown fences.";

function isVocabExample(value: unknown): value is VocabExample {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.es !== "string" || obj.es.length === 0) return false;
  if (obj.en !== undefined && typeof obj.en !== "string") return false;
  return true;
}

async function callHaiku(
  batch: GlossInput[]
): Promise<
  Map<string, { gloss: string; pronunciation: string | null; examples: VocabExample[] }>
> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY missing — can't enrich vocab.");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const userPrompt = JSON.stringify(
    batch.map((b) => ({
      id: b.id,
      stem: b.stem,
      lang: b.lang,
      sample: b.sample_usage,
    }))
  );
  const response = await client.messages.create({
    model: config.models.anthropicFast,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  if (!textBlock) throw new Error("Haiku returned no text block");
  const trimmed = textBlock.text.trim().replace(/^```json\s*|\s*```$/g, "");
  const parsed = JSON.parse(trimmed) as RawGlossOutput[];
  const map = new Map<
    string,
    { gloss: string; pronunciation: string | null; examples: VocabExample[] }
  >();
  for (const row of parsed) {
    if (typeof row.id !== "string" || typeof row.gloss !== "string") continue;
    const pronunciation =
      typeof row.pronunciation === "string" && row.pronunciation.length > 0
        ? row.pronunciation
        : null;
    const examplesRaw = Array.isArray(row.examples) ? row.examples : [];
    const examples = examplesRaw.filter(isVocabExample);
    map.set(row.id, {
      gloss: row.gloss.trim(),
      pronunciation,
      examples,
    });
  }
  return map;
}

/**
 * Enrich rows that are missing gloss/pronunciation/examples. Returns the
 * number of rows written. Logs (but doesn't throw) on per-batch failures so
 * a transient Haiku outage doesn't poison the import.
 */
export async function fillMissingGlosses(
  pool: pg.Pool,
  limit: number
): Promise<number> {
  const rows = await getRowsNeedingGloss(pool, limit);
  if (rows.length === 0) return 0;

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      const packs = await callHaiku(batch);
      for (const [id, pack] of packs) {
        await setGlossPack(pool, id, pack);
        written += 1;
      }
    } catch (err) {
      console.error(
        `[gloss-fill] batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return written;
}
