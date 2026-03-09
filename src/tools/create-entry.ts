import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { createEntry, updateEntryEmbeddingIfVersionMatches } from "../db/queries.js";
import { generateEmbedding } from "../db/embeddings.js";

export async function handleCreateEntry(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("create_entry", input);

  const entry = await createEntry(pool, {
    text: params.text,
    tags: params.tags,
    timezone: params.timezone,
    created_at: params.date,
    city: params.city,
    source: params.source,
  });

  // Fire-and-forget embedding generation (same pattern as REST API)
  if (entry.text) {
    void generateEmbedding(entry.text)
      .then((emb) =>
        updateEntryEmbeddingIfVersionMatches(pool, entry.uuid, entry.version, emb)
      )
      .catch((err) => console.error("Entry embedding failed:", err));
  }

  return JSON.stringify(
    { uuid: entry.uuid, created_at: entry.created_at },
    null,
    2
  );
}
