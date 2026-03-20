/**
 * Reprocess Pending/ directory in R2:
 *
 * 1. Delete all existing files under Pending/
 * 2. List all .md files under Reviews/ and Analysis/
 * 3. Download each, extract title + body (strip frontmatter)
 * 4. Semantic search for relevant artifacts (embedding + hybrid search)
 * 5. Send to Claude Opus for atomic insight extraction
 * 6. Write each insight as .md to Pending/ in R2
 *
 * Usage:
 *   pnpm tsx scripts/reprocess-pending.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.production.local", override: true });

import Anthropic from "@anthropic-ai/sdk";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import matter from "gray-matter";
import pg from "pg";
import { z } from "zod";

import { generateEmbedding } from "../src/db/embeddings.js";
import { searchArtifacts } from "../src/db/queries/artifacts.js";
import {
  createClient,
  getObjectContent,
  listAllObjects,
  putObjectContent,
} from "../src/storage/r2.js";

// ============================================================================
// Config
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

interface ExtractedInsight {
  title: string;
  body: string;
  tags: string[];
  linkedTo: string[];
  addToProject?: string;
}

// ============================================================================
// Helpers (mirroring src/obsidian/extraction.ts exactly)
// ============================================================================

async function fetchArtifactContext(
  pool: pg.Pool,
  reviewText: string
): Promise<string> {
  const queryText = reviewText.slice(0, 1000);
  const embedding = await generateEmbedding(queryText);
  const results = await searchArtifacts(pool, embedding, queryText, {}, 30);

  return results
    .map(
      (r) =>
        `- [${r.kind}] ${r.title}: ${r.body.slice(0, 200).replace(/\n/g, " ")}`
    )
    .join("\n");
}

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

function insightToMarkdown(
  insight: ExtractedInsight,
  sourceReviewTitle: string
): string {
  const tags = insight.tags.map((t) => `  - ${t}`).join("\n");
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
tags:
${tags}
---
# ${insight.title}

${insight.body}

## Sources
${links.join("\n")}
`;
}

function titleToFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const r2Client = createClient();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const claude = new Anthropic({ apiKey: anthropicKey });

  let deletedCount = 0;
  let reviewsProcessed = 0;
  let insightsExtracted = 0;

  try {
    // ── Step 1: Delete all existing Pending/ files ──────────────────────
    console.log("Step 1: Clearing existing Pending/ files...");
    const pendingFiles = await listAllObjects(r2Client, VAULT_BUCKET, "Pending/");
    for (const obj of pendingFiles) {
      await r2Client.send(
        new DeleteObjectCommand({ Bucket: VAULT_BUCKET, Key: obj.key })
      );
      deletedCount++;
    }
    console.log(`  Deleted ${deletedCount} file(s) from Pending/`);

    // ── Step 2: List Reviews/ and Analysis/ .md files ───────────────────
    console.log("\nStep 2: Listing Reviews/ and Analysis/ files...");
    const [reviewObjs, analysisObjs] = await Promise.all([
      listAllObjects(r2Client, VAULT_BUCKET, "Reviews/"),
      listAllObjects(r2Client, VAULT_BUCKET, "Analysis/"),
    ]);
    const allReviewObjs = [...reviewObjs, ...analysisObjs].filter((o) =>
      o.key.endsWith(".md")
    );
    console.log(
      `  Found ${reviewObjs.length} Reviews/ and ${analysisObjs.length} Analysis/ files (${allReviewObjs.length} .md total)`
    );

    // ── Steps 3-6: Process each review ──────────────────────────────────
    for (const obj of allReviewObjs) {
      console.log(`\nProcessing: ${obj.key}`);

      // Step 3: Download and parse
      const raw = await getObjectContent(r2Client, VAULT_BUCKET, obj.key);
      const { data: _frontmatter, content: bodyWithTitle } = matter(raw);

      // Extract title from first markdown heading, fallback to filename
      const titleMatch = bodyWithTitle.match(/^#\s+(.+)$/m);
      const title = titleMatch
        ? titleMatch[1].trim()
        : obj.key.replace(/^.*\//, "").replace(/\.md$/, "");
      // Strip the title line from body
      const body = titleMatch
        ? bodyWithTitle.replace(/^#\s+.+$/m, "").trim()
        : bodyWithTitle.trim();

      if (!body || body.length < 50) {
        console.log("  Skipping (body too short)");
        continue;
      }

      // Step 5: Semantic search for context
      console.log("  Fetching artifact context...");
      const artifactContext = await fetchArtifactContext(pool, body);

      // Step 6: LLM extraction
      console.log("  Extracting insights via Claude...");
      const prompt = buildExtractionPrompt(body, title, artifactContext);
      const response = await claude.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log("  WARNING: No JSON in LLM response, skipping");
        continue;
      }

      const parsed = extractionResponseSchema.safeParse(
        JSON.parse(jsonMatch[0])
      );
      if (!parsed.success) {
        console.log(`  WARNING: Invalid extraction response: ${parsed.error.message}`);
        continue;
      }

      const insights = parsed.data.insights;
      reviewsProcessed++;

      if (insights.length === 0) {
        console.log("  No insights extracted");
        continue;
      }

      // Step 7: Write insights to Pending/
      for (const insight of insights) {
        const markdown = insightToMarkdown(insight, title);
        const filename = `${titleToFilename(insight.title)}.md`;
        const key = `Pending/${filename}`;
        await putObjectContent(r2Client, VAULT_BUCKET, key, markdown);
        insightsExtracted++;
        console.log(`  ✓ ${key}`);
      }
    }

    // ── Summary ─────────────────────────────────────────────────────────
    console.log("\n" + "=".repeat(60));
    console.log("Summary:");
    console.log(`  Pending files deleted:  ${deletedCount}`);
    console.log(`  Reviews processed:     ${reviewsProcessed}`);
    console.log(`  Insights extracted:    ${insightsExtracted}`);
    console.log("=".repeat(60));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
