// Haiku gloss-fill for Kindle lookups. Used by both import-lookups (online
// during sync) and the standalone backfill script. Batched 25 rows per
// request so 364 lookups cost ~$0.20 total at Haiku rates.

import type pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import {
  getRowsNeedingGloss,
  setGloss,
} from "../db/queries/vocab-reviews.js";

const BATCH_SIZE = 25;

interface GlossInput {
  id: string;
  stem: string;
  lang: string;
  sample_usage: string;
}

const SYSTEM_PROMPT =
  "You write tight English glosses for Spanish vocabulary tapped in a Kindle. " +
  "For each entry, output one short gloss followed by a part-of-speech tag in " +
  "parentheses, e.g. `step / rung (noun)`. Cover the meaning that fits the " +
  "sample sentence first; add a `/`-separated alternative if the word is " +
  "ambiguous out of context. Keep each gloss under 60 characters. Output " +
  "strict JSON: an array of `{id, gloss}` objects, no preface, no commentary.";

async function callHaiku(batch: GlossInput[]): Promise<Map<string, string>> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY missing — can't backfill glosses.");
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
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  if (!textBlock) throw new Error("Haiku returned no text block");
  const trimmed = textBlock.text.trim().replace(/^```json\s*|\s*```$/g, "");
  const parsed = JSON.parse(trimmed) as { id: string; gloss: string }[];
  const map = new Map<string, string>();
  for (const row of parsed) {
    if (typeof row.id === "string" && typeof row.gloss === "string") {
      map.set(row.id, row.gloss.trim());
    }
  }
  return map;
}

/**
 * Fill missing glosses for up to `limit` rows. Returns the number of rows
 * written. Logs (but does not throw) on per-batch failures so a transient
 * Haiku outage doesn't poison the import.
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
      const glosses = await callHaiku(batch);
      for (const [id, gloss] of glosses) {
        await setGloss(pool, id, gloss);
        written += 1;
      }
    } catch (err) {
      console.error(
        `[gloss-fill] batch ${i / BATCH_SIZE + 1} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return written;
}
