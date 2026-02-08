export function expectSearchResults(
  results: unknown[],
  context: { query: string; minCount?: number }
): void {
  const min = context.minCount ?? 1;
  if (results.length < min) {
    throw new Error(
      `Expected at least ${min} results for query "${context.query}" but got ${results.length}.\n` +
        `Hint: Check that embeddings exist in test fixtures (specs/fixtures/seed.ts).\n` +
        `Hint: Verify the RRF query in src/db/queries.ts handles NULL embeddings.\n` +
        `Run \`pnpm test:integration -- --reporter=verbose\` for full trace.`
    );
  }
}

export function expectEntryShape(entry: Record<string, unknown>): void {
  const required = ["uuid", "created_at", "text"];
  const missing = required.filter((k) => !(k in entry));
  if (missing.length > 0) {
    throw new Error(
      `Entry missing required fields: ${missing.join(", ")}.\n` +
        `Hint: Check the query in src/db/queries.ts returns these columns.\n` +
        `Hint: Check the formatter in src/formatters/entry.ts.`
    );
  }
}

export function expectRrfScore(
  score: number,
  context: { query: string }
): void {
  if (score < 0 || score > 2) {
    throw new Error(
      `RRF score ${score} for query "${context.query}" is out of valid range [0, 2].\n` +
        `Hint: RRF score = 1/(60+rank_s) + 1/(60+rank_f). Max is ~0.033 per source.\n` +
        `Hint: Check the RRF formula in src/db/queries.ts.`
    );
  }
}

export function expectValidDate(
  dateStr: string,
  context: { field: string }
): void {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    throw new Error(
      `Invalid date "${dateStr}" for field "${context.field}".\n` +
        `Hint: Ensure TIMESTAMPTZ is being returned as ISO string.\n` +
        `Hint: Check the query in src/db/queries.ts.`
    );
  }
}

export function expectSimilarityScore(
  score: number,
  context: { uuid: string }
): void {
  if (score < 0 || score > 1) {
    throw new Error(
      `Similarity score ${score} for entry "${context.uuid}" is out of range [0, 1].\n` +
        `Hint: Cosine similarity should be 1 - cosine_distance.\n` +
        `Hint: Check findSimilarEntries in src/db/queries.ts.`
    );
  }
}
