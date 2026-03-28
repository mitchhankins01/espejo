import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { z } from "zod";

import { config } from "../config.js";
import { searchArtifacts } from "../db/queries/artifacts.js";
import { generateEmbedding } from "../db/embeddings.js";
import { createClient, putObjectContent } from "../storage/r2.js";
import { sendTelegramMessage } from "../telegram/client.js";

// ============================================================================
// LLM-based insight extraction from review artifacts
// ============================================================================

const EXTRACTION_MODEL = "claude-opus-4-6";
const VAULT_BUCKET = "artifacts";

const extractedInsightSchema = z.object({
  title: z.string(),
  body: z.string(),
  linkedTo: z.array(z.string()),
  addToProject: z.string().nullable().optional(),
});

const extractionResponseSchema = z.object({
  insights: z.array(extractedInsightSchema),
});

export interface ExtractedInsight {
  title: string;
  body: string;
  linkedTo: string[];
  addToProject?: string | null;
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

  return `---
kind: insight
status: pending
---
${insight.body}

## Sources
${links.join("\n")}
`;
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

    // Write insight files to R2
    const r2Client = createClient();
    for (const insight of result.insights) {
      try {
        const markdown = insightToMarkdown(insight, reviewTitle);
        const filename = `${titleToFilename(insight.title)}.md`;
        const key = `Pending/${filename}`;

        await putObjectContent(r2Client, VAULT_BUCKET, key, markdown);
        result.filesWritten.push(key);
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

  const lines = allResults
    .filter((r) => r.insights.length > 0)
    .map((r) => {
      const insightList = r.insights
        .map((i) => `  • ${escapeHtml(i.title)}`)
        .join("\n");
      return `📝 <b>${escapeHtml(r.reviewTitle)}</b>\n${insightList}`;
    });

  const message = `🔍 <b>Review extraction</b> — ${totalInsights} pending insight(s):\n\n${lines.join("\n\n")}\n\nApprove in Obsidian: change <code>status: pending</code> → <code>status: approved</code>`;

  await sendTelegramMessage(config.telegram.allowedChatId, message);
}
