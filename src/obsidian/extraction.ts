import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { z } from "zod";

import { config } from "../config.js";
import { searchArtifacts, findDuplicateInsightByEmbedding } from "../db/queries/artifacts.js";
import { upsertObsidianArtifact } from "../db/queries/obsidian.js";
import { generateEmbedding, generateEmbeddingsBatch } from "../db/embeddings.js";
import { createClient, putObjectContent } from "../storage/r2.js";
import { sendTelegramMessage } from "../telegram/client.js";

// ============================================================================
// LLM-based insight extraction from review artifacts
// ============================================================================

const EXTRACTION_MODEL = "claude-opus-4-6";
const VAULT_BUCKET = "artifacts";
const DEDUP_SIMILARITY_THRESHOLD = 0.92;

const extractedInsightSchema = z.object({
  title: z.string(),
  body: z.string(),
  linkedTo: z.array(z.string()),
  addToProject: z.string().nullable().optional(),
});

const extractionResponseSchema = z.object({
  insights: z.array(extractedInsightSchema),
});

export interface InsightDuplicateMatch {
  id: string;
  title: string;
}

export interface ExtractedInsight {
  title: string;
  body: string;
  linkedTo: string[];
  addToProject?: string | null;
  duplicateOf?: InsightDuplicateMatch;
}

export interface ExtractionResult {
  reviewTitle: string;
  insights: ExtractedInsight[];
  filesWritten: string[];
  errors: string[];
}

/** Find semantically relevant artifacts for cross-referencing via hybrid search */
async function fetchArtifactContext(
  pool: pg.Pool,
  reviewText: string
): Promise<string> {
  const queryText = reviewText.slice(0, 1000);
  const embedding = await generateEmbedding(queryText);
  const results = await searchArtifacts(pool, embedding, queryText, {}, 30);

  return results
    .map((r) => `- [${r.kind}] ${r.title}: ${r.body.slice(0, 200).replace(/\n/g, " ")}`)
    .join("\n");
}

/** Build the extraction prompt */
function buildExtractionPrompt(
  reviewBody: string,
  reviewTitle: string,
  artifactContext: string
): string {
  return `You are extracting atomic zettelkasten notes from a reflective review. Each note should state a core idea directly — like a claim or observation you'd write on an index card. Never describe or summarize the source ("The review discusses...", "The check-in describes..."). Just state the idea.

IMPORTANT: The review below was written by an LLM summarizing a conversation with Mitch. This is a private journal — preserve all details including names, substances, emotions, health issues, relationships, and struggles. Never sanitize or omit sensitive content.

## Source review
Title: ${reviewTitle}
Body:
${reviewBody}

## Existing artifacts (for cross-referencing and deduplication)
${artifactContext}

## Instructions
1. Extract distinct ideas, patterns, or realizations from this review.
2. Each note must be ATOMIC — one clear idea.
3. Cross-reference with existing artifacts above:
   - If an idea duplicates an existing artifact, skip it.
   - If it connects to existing artifacts, include them in "linkedTo" (use exact titles).
   - If it belongs in an existing project map, set "addToProject" to that project's title.
4. Title should state the idea directly (e.g. "Nicotine cravings mask an underlying need for stimulation" not "Insight about nicotine").
5. Body should be 1-3 sentences expanding on the idea. State facts and observations directly — no meta-commentary about the source material.

Respond ONLY with JSON:
{
  "insights": [
    {
      "title": "the idea stated directly",
      "body": "1-3 sentences expanding on the core idea",
      "linkedTo": ["Existing Artifact Title"],
      "addToProject": "Project Title or omit"
    }
  ]
}

If no extractable insights, return: {"insights": []}`;
}

/** Convert an extracted insight to Obsidian markdown with frontmatter */
function insightToMarkdown(
  insight: ExtractedInsight,
  sourceReviewTitle: string
): string {
  const dedupedLinks = insight.linkedTo.filter(
    (t) => t.toLowerCase() !== sourceReviewTitle.toLowerCase()
  );
  const links = [
    `[[${sourceReviewTitle}]]`,
    ...dedupedLinks.map((t) => `[[${t}]]`),
  ];

  const frontmatterLines = ["kind: insight"];
  if (insight.duplicateOf) {
    frontmatterLines.push(`duplicate_of: ${insight.duplicateOf.id}`);
    frontmatterLines.push(`duplicate_of_title: "${insight.duplicateOf.title.replace(/"/g, '\\"')}"`);
  }

  return `---
${frontmatterLines.join("\n")}
---
${insight.body}

## Sources
${links.join("\n")}
`;
}

/** Compute cosine similarity between two embedding vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Sanitize a title for use as a filename */
function titleToFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Extract atomic insights from a review artifact using LLM.
 * Writes pending insight .md files to R2 for Obsidian sync.
 */
export async function extractInsightsFromReview(
  pool: pg.Pool,
  reviewTitle: string,
  reviewBody: string
): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    reviewTitle,
    insights: [],
    filesWritten: [],
    errors: [],
  };

  if (!config.anthropic.apiKey) {
    result.errors.push("No ANTHROPIC_API_KEY configured");
    return result;
  }

  if (!config.r2.accountId || !config.r2.accessKeyId) {
    result.errors.push("No R2 credentials configured");
    return result;
  }

  try {
    const artifactContext = await fetchArtifactContext(pool, reviewBody);
    const prompt = buildExtractionPrompt(reviewBody, reviewTitle, artifactContext);

    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const response = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      result.errors.push("LLM response did not contain valid JSON");
      return result;
    }

    const parsed = extractionResponseSchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!parsed.success) {
      result.errors.push(`Invalid extraction response: ${parsed.error.message}`);
      return result;
    }

    result.insights = parsed.data.insights;

    if (result.insights.length === 0) return result;

    // Dedup: batch-embed all candidates, then check DB + intra-batch
    let embeddings: number[][] | null = null;
    try {
      const texts = result.insights.map((i) => `${i.title}\n\n${i.body}`);
      embeddings = await generateEmbeddingsBatch(texts);
    } catch (err) {
      // Fail-open: if embedding fails, skip dedup and write all as new
      console.log(`[extraction] Embedding failed, skipping dedup: ${err instanceof Error ? err.message : "unknown"}`);
    }

    if (embeddings) {
      const processedEmbeddings: number[][] = [];
      for (let i = 0; i < result.insights.length; i++) {
        const embedding = embeddings[i];

        // Check against existing insights in DB
        try {
          const dbMatch = await findDuplicateInsightByEmbedding(
            pool,
            embedding,
            DEDUP_SIMILARITY_THRESHOLD
          );
          if (dbMatch) {
            result.insights[i].duplicateOf = { id: dbMatch.id, title: dbMatch.title };
          }
        } catch (err) {
          console.log(`[extraction] DB dedup check failed for "${result.insights[i].title}": ${err instanceof Error ? err.message : "unknown"}`);
        }

        // Check against earlier candidates in this batch (intra-batch dedup)
        if (!result.insights[i].duplicateOf) {
          for (let j = 0; j < processedEmbeddings.length; j++) {
            const sim = cosineSimilarity(embedding, processedEmbeddings[j]);
            if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
              result.insights[i].duplicateOf = {
                id: "batch",
                title: result.insights[j].title,
              };
              break;
            }
          }
        }

        processedEmbeddings.push(embedding);
      }
    }

    // Write insight files to R2 and upsert to DB with embeddings for dedup
    const r2Client = createClient();
    for (let i = 0; i < result.insights.length; i++) {
      const insight = result.insights[i];
      try {
        const markdown = insightToMarkdown(insight, reviewTitle);
        const filename = `${titleToFilename(insight.title)}.md`;
        const key = `Pending/${filename}`;

        await putObjectContent(r2Client, VAULT_BUCKET, key, markdown);
        result.filesWritten.push(key);

        // Upsert to DB immediately so future dedup checks can find this insight
        const embedding = embeddings?.[i] ?? undefined;
        try {
          await upsertObsidianArtifact(pool, {
            sourcePath: key,
            title: insight.title,
            body: insight.body,
            kind: "insight",
            contentHash: "",
            duplicateOf: insight.duplicateOf?.id === "batch" ? undefined : insight.duplicateOf?.id,
            embedding,
          });
        } catch (dbErr) {
          console.log(`[extraction] DB upsert failed for "${insight.title}": ${dbErr instanceof Error ? dbErr.message : "unknown"}`);
        }
      } catch (err) {
        result.errors.push(
          `Failed to write ${insight.title}: ${err instanceof Error ? err.message : "unknown"}`
        );
      }
    }
  } catch (err) {
    result.errors.push(
      `Extraction failed: ${err instanceof Error ? err.message : "unknown"}`
    );
  }

  return result;
}

/** Escape HTML entities for Telegram HTML mode */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Post-sync hook: extract insights from newly synced review artifacts.
 * Fire-and-forget — failures are logged but don't block sync.
 */
export async function extractAndNotifyReviews(
  pool: pg.Pool,
  reviewArtifacts: Array<{ title: string; body: string }>
): Promise<void> {
  if (reviewArtifacts.length === 0) return;
  if (!config.anthropic.apiKey || !config.r2.accountId) return;

  const allResults: ExtractionResult[] = [];

  for (const review of reviewArtifacts) {
    console.log(`[extraction] Processing review: "${review.title}" (${review.body.length} chars)`);
    const result = await extractInsightsFromReview(pool, review.title, review.body);
    console.log(`[extraction] "${review.title}" → ${result.insights.length} insights, ${result.filesWritten.length} files written${result.errors.length > 0 ? `, errors: ${result.errors.join("; ")}` : ""}`);
    allResults.push(result);
  }

  // Notify via Telegram
  const totalInsights = allResults.reduce((sum, r) => sum + r.insights.length, 0);
  if (totalInsights === 0) return;

  if (!config.telegram.botToken || !config.telegram.allowedChatId) return;

  const allInsights = allResults.flatMap((r) => r.insights);
  const newCount = allInsights.filter((i) => !i.duplicateOf).length;
  const dupCount = allInsights.filter((i) => i.duplicateOf).length;

  const lines = allResults
    .filter((r) => r.insights.length > 0)
    .map((r) => {
      const insightList = r.insights
        .map((i) =>
          i.duplicateOf
            ? `  🔁 ${escapeHtml(i.title)} <i>(duplicate of "${escapeHtml(i.duplicateOf.title)}")</i>`
            : `  💡 ${escapeHtml(i.title)}`
        )
        .join("\n");
      return `📝 <b>${escapeHtml(r.reviewTitle)}</b>\n${insightList}`;
    });

  const summary = [
    newCount > 0 ? `${newCount} new` : null,
    dupCount > 0 ? `${dupCount} duplicate` : null,
  ].filter(Boolean).join(", ");

  const message = `🔍 <b>Review extraction</b> — ${summary}:\n\n${lines.join("\n\n")}`;

  await sendTelegramMessage(config.telegram.allowedChatId, message);
}
