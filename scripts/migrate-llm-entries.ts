/**
 * One-time migration: Process ~40 Day One entries tagged `llm` into knowledge artifacts.
 *
 * Step 1: Classify each entry (evening-checkin, weekly-review, monthly-review, deep-analysis, debugging-entry)
 * Step 2: Create artifacts and extract insights based on classification
 * Step 3: Write .md files to R2 for Obsidian sync
 *
 * Usage:
 *   pnpm tsx scripts/migrate-llm-entries.ts
 *   pnpm tsx scripts/migrate-llm-entries.ts --dry-run    # Classify only, no writes
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });

import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
import readline from "readline";

import { createClient, putObjectContent } from "../src/storage/r2.js";

// ============================================================================
// Config
// ============================================================================

const CLASSIFICATION_MODEL = "claude-opus-4-6";
const EXTRACTION_MODEL = "claude-opus-4-6";
const VAULT_BUCKET = "artifacts";
const DRY_RUN = process.argv.includes("--dry-run");

const databaseUrl = process.env.DATABASE_URL || "postgresql://dev:dev@localhost:5434/journal_dev";

type Classification = "evening-checkin" | "weekly-review" | "monthly-review" | "deep-analysis" | "debugging-entry";

interface LlmEntry {
  uuid: string;
  text: string;
  created_at: Date;
  tags: string[];
  classification?: Classification;
}

interface ExtractedInsight {
  title: string;
  body: string;
  tags: string[];
  linkedTo: string[];
}

// ============================================================================
// Step 1: Fetch and classify
// ============================================================================

async function fetchLlmEntries(pool: pg.Pool): Promise<LlmEntry[]> {
  const result = await pool.query(
    `SELECT e.uuid, e.text, e.created_at,
            COALESCE(
              (SELECT array_agg(t.name ORDER BY t.name)
               FROM entry_tags et JOIN tags t ON t.id = et.tag_id
               WHERE et.entry_id = e.id),
              '{}'
            ) AS tags
     FROM entries e
     JOIN entry_tags et ON et.entry_id = e.id
     JOIN tags t ON t.id = et.tag_id
     WHERE t.name = 'llm'
     ORDER BY e.created_at ASC`
  );

  return result.rows.map((r) => ({
    uuid: r.uuid as string,
    text: (r.text as string) ?? "",
    created_at: r.created_at as Date,
    tags: r.tags as string[],
  }));
}

async function classifyEntries(
  client: Anthropic,
  entries: LlmEntry[]
): Promise<LlmEntry[]> {
  console.log(`\nClassifying ${entries.length} entries...`);

  for (const entry of entries) {
    const snippet = entry.text.slice(0, 3000);
    const response = await client.messages.create({
      model: CLASSIFICATION_MODEL,
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: `Classify this journal entry into exactly one category. Respond with ONLY the category name.

Categories:
- evening-checkin: Daily evening reflection/check-in
- weekly-review: Weekly review or summary
- monthly-review: Monthly review or summary
- deep-analysis: Deep self-analysis, framework, or theory (e.g. "The Classroom", "The Car Theory")
- debugging-entry: Technical debugging, troubleshooting, or problem-solving notes

Entry (${entry.created_at.toISOString().split("T")[0]}):
${snippet}`,
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim().toLowerCase() : "";
    const valid: Classification[] = ["evening-checkin", "weekly-review", "monthly-review", "deep-analysis", "debugging-entry"];
    entry.classification = valid.includes(text as Classification) ? text as Classification : "debugging-entry";

    process.stdout.write(".");
  }
  console.log(" done");

  return entries;
}

function printClassificationTable(entries: LlmEntry[]): void {
  console.log("\n┌──────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ Classification Results                                                       │");
  console.log("├────────────────┬───────────────────────┬──────────────────────────────────────┤");
  console.log("│ Classification │ Date                  │ First 50 chars                       │");
  console.log("├────────────────┼───────────────────────┼──────────────────────────────────────┤");

  for (const entry of entries) {
    const cls = (entry.classification ?? "?").padEnd(14);
    const date = entry.created_at.toISOString().split("T")[0].padEnd(21);
    const snippet = entry.text.replace(/\n/g, " ").slice(0, 36).padEnd(36);
    console.log(`│ ${cls} │ ${date} │ ${snippet} │`);
  }

  console.log("└────────────────┴───────────────────────┴──────────────────────────────────────┘");

  // Summary
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const cls = entry.classification ?? "unknown";
    counts[cls] = (counts[cls] ?? 0) + 1;
  }
  console.log("\nSummary:", Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", "));
}

// ============================================================================
// Step 2: Process entries
// ============================================================================

function titleToFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function reviewToMarkdown(
  title: string,
  body: string,
  tags: string[],
  sourceUuid: string
): string {
  const tagLines = tags.map((t) => `  - ${t}`).join("\n");
  return `---
kind: review
status: pending
tags:
${tagLines}
---

# ${title}

${body}

---
Source entry: ${sourceUuid}
`;
}

function insightToMarkdown(
  insight: ExtractedInsight,
  sourceTitle: string
): string {
  const tagLines = insight.tags.map((t) => `  - ${t}`).join("\n");
  const links = [
    `[[${sourceTitle}]]`,
    ...insight.linkedTo.map((t) => `[[${t}]]`),
  ];

  return `---
kind: insight
status: pending
tags:
${tagLines}
---

# ${insight.title}

${insight.body}

## Sources
${links.join("\n")}
`;
}

async function extractInsights(
  client: Anthropic,
  title: string,
  body: string,
  artifactContext: string
): Promise<ExtractedInsight[]> {
  const response = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `Extract atomic knowledge insights from this review/analysis.

## Source
Title: ${title}
Body:
${body.slice(0, 8000)}

## Existing artifacts (for cross-referencing)
${artifactContext}

## Instructions
1. Identify distinct insights, learnings, or patterns.
2. Each should be ATOMIC — one idea per note.
3. Skip duplicates of existing artifacts.
4. Include "linkedTo" with exact titles of related existing artifacts.
5. Clear, specific titles (not "Insight about X").
6. Body: 2-5 sentences with context.

Respond ONLY with JSON:
{
  "insights": [
    {"title": "...", "body": "...", "tags": ["..."], "linkedTo": ["..."]}
  ]
}

If none: {"insights": []}`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { insights: ExtractedInsight[] };
    return parsed.insights ?? [];
  } catch {
    return [];
  }
}

async function processEntries(
  pool: pg.Pool,
  client: Anthropic,
  entries: LlmEntry[]
): Promise<void> {
  // Fetch artifact context for cross-referencing
  const contextResult = await pool.query(
    `SELECT title, kind, LEFT(body, 200) AS snippet
     FROM knowledge_artifacts
     WHERE deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 100`
  );
  const artifactContext = contextResult.rows
    .map((r) => `- [${r.kind as string}] ${r.title as string}: ${(r.snippet as string).replace(/\n/g, " ")}`)
    .join("\n");

  const r2Client = createClient();
  let filesWritten = 0;
  let insightsExtracted = 0;

  for (const entry of entries) {
    const date = entry.created_at.toISOString().split("T")[0];
    const cls = entry.classification!;

    if (cls === "evening-checkin" || cls === "weekly-review" || cls === "monthly-review") {
      // Create review artifact as .md
      const title = `${cls.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} — ${date}`;
      const tags = ["llm", cls, ...entry.tags.filter((t) => t !== "llm")];
      const md = reviewToMarkdown(title, entry.text, tags, entry.uuid);
      const key = `Reviews/${titleToFilename(title)}.md`;

      console.log(`  Writing review: ${key}`);
      await putObjectContent(r2Client, VAULT_BUCKET, key, md);
      filesWritten++;

      // Extract insights
      console.log(`  Extracting insights from: ${title}`);
      const insights = await extractInsights(client, title, entry.text, artifactContext);
      for (const insight of insights) {
        const insightMd = insightToMarkdown(insight, title);
        const insightKey = `Pending/${titleToFilename(insight.title)}.md`;
        console.log(`    → ${insight.title}`);
        await putObjectContent(r2Client, VAULT_BUCKET, insightKey, insightMd);
        filesWritten++;
        insightsExtracted++;
      }
    } else if (cls === "deep-analysis") {
      // Deep analysis → note artifact + extracted insights
      const title = entry.text.split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 200) || `Deep Analysis — ${date}`;
      const tags = ["llm", "deep-analysis", ...entry.tags.filter((t) => t !== "llm")];
      const md = reviewToMarkdown(title, entry.text, tags, entry.uuid);
      const key = `Analysis/${titleToFilename(title)}.md`;

      console.log(`  Writing analysis: ${key}`);
      await putObjectContent(r2Client, VAULT_BUCKET, key, md);
      filesWritten++;

      // Extract insights
      console.log(`  Extracting insights from: ${title}`);
      const insights = await extractInsights(client, title, entry.text, artifactContext);
      for (const insight of insights) {
        const insightMd = insightToMarkdown(insight, title);
        const insightKey = `Pending/${titleToFilename(insight.title)}.md`;
        console.log(`    → ${insight.title}`);
        await putObjectContent(r2Client, VAULT_BUCKET, insightKey, insightMd);
        filesWritten++;
        insightsExtracted++;
      }
    } else {
      // debugging-entry → note artifact
      const title = entry.text.split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 200) || `Debug Notes — ${date}`;
      const tags = ["llm", "debugging", ...entry.tags.filter((t) => t !== "llm")];
      const md = `---
kind: note
status: pending
tags:
${tags.map((t) => `  - ${t}`).join("\n")}
---

# ${title}

${entry.text}

---
Source entry: ${entry.uuid}
`;
      const key = `Notes/${titleToFilename(title)}.md`;

      console.log(`  Writing note: ${key}`);
      await putObjectContent(r2Client, VAULT_BUCKET, key, md);
      filesWritten++;
    }
  }

  console.log(`\nDone: ${filesWritten} files written, ${insightsExtracted} insights extracted.`);
  console.log("\nNext steps:");
  console.log("1. Run Obsidian sync to pick up new files");
  console.log("2. Review pending artifacts in Obsidian");
  console.log("3. Change status: pending → status: approved for keepers");
  console.log("4. Delete unwanted notes from Obsidian vault");
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const entries = await fetchLlmEntries(pool);
    console.log(`Found ${entries.length} entries tagged 'llm'`);

    if (entries.length === 0) {
      console.log("Nothing to migrate.");
      return;
    }

    const classified = await classifyEntries(client, entries);
    printClassificationTable(classified);

    if (DRY_RUN) {
      console.log("\n--dry-run: Skipping writes.");
      return;
    }

    // Ask for confirmation
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("\nProceed with migration? (y/N) ", resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }

    await processEntries(pool, client, classified);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
