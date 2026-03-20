import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { z } from "zod";

import { config } from "../config.js";
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
  tags: z.array(z.string()),
  linkedTo: z.array(z.string()),
  addToProject: z.string().optional(),
});

const extractionResponseSchema = z.object({
  insights: z.array(extractedInsightSchema),
});

export interface ExtractedInsight {
  title: string;
  body: string;
  tags: string[];
  linkedTo: string[];
  addToProject?: string;
}

export interface ExtractionResult {
  reviewTitle: string;
  insights: ExtractedInsight[];
  filesWritten: string[];
  errors: string[];
}

/** Fetch existing artifact titles and short bodies for cross-referencing context */
async function fetchArtifactContext(
  pool: pg.Pool
): Promise<string> {
  const result = await pool.query(
    `SELECT title, kind, LEFT(body, 200) AS snippet
     FROM knowledge_artifacts
     WHERE deleted_at IS NULL AND status = 'approved'
     ORDER BY updated_at DESC
     LIMIT 100`
  );

  return result.rows
    .map((r) => `- [${r.kind as string}] ${r.title as string}: ${(r.snippet as string).replace(/\n/g, " ")}`)
    .join("\n");
}

/** Build the extraction prompt */
function buildExtractionPrompt(
  reviewBody: string,
  reviewTitle: string,
  artifactContext: string
): string {
  return `You are extracting atomic knowledge insights from a reflective review.

## Source review
Title: ${reviewTitle}
Body:
${reviewBody}

## Existing artifacts (for cross-referencing and deduplication)
${artifactContext}

## Instructions
1. Identify distinct insights, learnings, realizations, or patterns in this review.
2. Each insight should be ATOMIC — one clear idea per note.
3. Cross-reference with existing artifacts above:
   - If an insight duplicates an existing artifact, skip it.
   - If it connects to existing artifacts, include them in "linkedTo" (use exact titles).
   - If it belongs in an existing project map, set "addToProject" to that project's title.
4. Give each insight a clear, specific title (not "Insight about X" — say what the insight IS).
5. Body should be 2-5 sentences with context from the review.
6. Add relevant tags (lowercase, hyphenated).

Respond ONLY with JSON:
{
  "insights": [
    {
      "title": "specific insight title",
      "body": "the core idea in 2-5 sentences",
      "tags": ["tag1", "tag2"],
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
  const tags = insight.tags.map((t) => `  - ${t}`).join("\n");
  const links = [
    `[[${sourceReviewTitle}]]`,
    ...insight.linkedTo.map((t) => `[[${t}]]`),
  ];

  return `---
kind: insight
status: pending
tags:
${tags}
---

# ${insight.title}

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
    .slice(0, 80);
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
    const artifactContext = await fetchArtifactContext(pool);
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
    const result = await extractInsightsFromReview(pool, review.title, review.body);
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
