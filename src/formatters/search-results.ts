import type { SearchResultRow, SimilarResultRow } from "../db/queries.js";

/**
 * Format search results as a ranked list with previews.
 */
export function formatSearchResults(results: SearchResultRow[]): string {
  if (results.length === 0) {
    return "No results found. Try broadening your search query or adjusting filters.";
  }

  const lines: string[] = [];
  lines.push(`Found ${results.length} result${results.length > 1 ? "s" : ""}:\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const date = new Date(r.created_at);
    const dateStr = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });

    const matchSources: string[] = [];
    if (r.has_semantic) matchSources.push("semantic");
    if (r.has_fulltext) matchSources.push("keyword");

    const headerParts: string[] = [`${i + 1}.`, `\uD83D\uDCC5 ${dateStr}`];
    if (r.city) headerParts.push(`\uD83D\uDCCD ${r.city}`);
    if (r.starred) headerParts.push("\u2B50");

    lines.push(headerParts.join(" "));

    if (r.tags.length > 0) {
      lines.push(`   \uD83C\uDFF7\uFE0F ${r.tags.join(", ")}`);
    }

    const preview = r.text ? r.text.replace(/\n/g, " ").trim() : "";
    if (preview) {
      const truncated = preview.length > 200 ? preview.slice(0, 200) + "..." : preview;
      lines.push(`   ${truncated}`);
    }

    lines.push(
      `   Score: ${r.rrf_score.toFixed(4)} [${matchSources.join(" + ")}] | ID: ${r.uuid}`
    );
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Format similar entry results.
 */
export function formatSimilarResults(results: SimilarResultRow[]): string {
  if (results.length === 0) {
    return "No similar entries found. The source entry may not have an embedding.";
  }

  const lines: string[] = [];
  lines.push(`Found ${results.length} similar entr${results.length > 1 ? "ies" : "y"}:\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const date = new Date(r.created_at);
    const dateStr = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });

    const headerParts: string[] = [`${i + 1}.`, `\uD83D\uDCC5 ${dateStr}`];
    if (r.city) headerParts.push(`\uD83D\uDCCD ${r.city}`);

    lines.push(headerParts.join(" "));

    if (r.tags.length > 0) {
      lines.push(`   \uD83C\uDFF7\uFE0F ${r.tags.join(", ")}`);
    }

    const preview = r.text ? r.text.replace(/\n/g, " ").trim() : "";
    if (preview) {
      const truncated = preview.length > 200 ? preview.slice(0, 200) + "..." : preview;
      lines.push(`   ${truncated}`);
    }

    lines.push(
      `   Similarity: ${(r.similarity_score * 100).toFixed(1)}% | ID: ${r.uuid}`
    );
    lines.push("");
  }

  return lines.join("\n").trim();
}
