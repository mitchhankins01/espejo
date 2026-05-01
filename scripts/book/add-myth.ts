/**
 * Add a new myth to books/myths.jsonl. Drafts the entry with Claude, prints it for
 * review, appends only on explicit confirmation.
 *
 * Usage:
 *   pnpm tsx scripts/book/add-myth.ts "Quetzalcóatl" --culture mesoamerican --shape "the feathered serpent who left and is expected to return"
 *
 * The --shape argument is the one-line theme (lower-case English fragment, like the
 * existing entries). If omitted, Claude infers a shape from the name.
 *
 * After Claude drafts the JSON, the script prints it and prompts for confirmation.
 * Y appends to books/myths.jsonl. N exits without writing.
 */

import Anthropic from "@anthropic-ai/sdk";
import { appendFile } from "fs/promises";
import { config } from "../../src/config.js";
import { MYTHS_PATH, readMyths, type MythCulture } from "./myths.js";

const VALID_CULTURES: MythCulture[] = [
  "greek",
  "roman",
  "norse",
  "mesoamerican",
  "other",
];

const SYSTEM = `You are drafting a single entry for a curated mythology corpus used by a Spanish-language tomo writer. Output STRICT JSON for one MythEntry — no preamble, no closing notes, no markdown fences.

Schema:
{
  "name": "string — exact canonical Spanish name",
  "culture": "greek" | "roman" | "norse" | "mesoamerican" | "other",
  "shape": "one-line English fragment naming the myth's structural arc (e.g. 'futile repetition + the moment of relief in the descent')",
  "motifs": ["array of 5-8 lowercase Spanish/English thematic keywords (e.g. 'repetición', 'umbral', 'padre-hijo')"],
  "vocabulary_hints": ["array of 4-6 B1-friendly Spanish phrases that fit the myth's register (e.g. 'la cumbre', 'las alas')"],
  "summary_es": "2-4 sentences in B1-level Spanish, factually accurate canon. Use indefinido and imperfecto naturally. No quotation marks inside the string.",
  "added_at": "YYYY-MM-DD"
}

Rules:
- summary_es must be factually accurate to canonical sources (Hesiod / Ovid / equivalent).
- B1 register: avoid stacked subjunctives, gloss obscure terms in-prose if used.
- shape is in English; everything else can be Spanish or mixed per the field.`;

interface CliArgs {
  name: string;
  culture: MythCulture;
  shape?: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length === 0) {
    throw new Error('Usage: pnpm tsx scripts/book/add-myth.ts "<name>" --culture <culture> [--shape "<shape>"]');
  }
  const name = positional[0];

  const cultureIdx = argv.indexOf("--culture");
  const cultureRaw = cultureIdx >= 0 ? argv[cultureIdx + 1] : "greek";
  if (!VALID_CULTURES.includes(cultureRaw as MythCulture)) {
    throw new Error(`--culture must be one of ${VALID_CULTURES.join(", ")}, got ${cultureRaw}`);
  }
  const culture = cultureRaw as MythCulture;

  const shapeIdx = argv.indexOf("--shape");
  const shape = shapeIdx >= 0 ? argv[shapeIdx + 1] : undefined;

  return { name, culture, shape };
}

async function draft(args: CliArgs): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const today = new Date().toISOString().slice(0, 10);
  const userParts: string[] = [
    `Draft a corpus entry for: ${args.name}`,
    `Culture: ${args.culture}`,
    `Today: ${today}`,
  ];
  if (args.shape) userParts.push(`Suggested shape (use as-is or refine if you have a better one): ${args.shape}`);
  userParts.push("", "Output JSON only.");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: userParts.join("\n") }],
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("draft returned no text block");
  }
  const match = text.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("draft returned no JSON. Raw:\n" + text.text);
  return match[0];
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log("Non-TTY context: refusing to append. Re-run interactively, or pipe `y` to stdin.");
    return false;
  }
  const readline = await import("readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  const existing = await readMyths();
  if (existing.some((m) => m.name.toLowerCase() === args.name.toLowerCase())) {
    throw new Error(`Myth "${args.name}" already exists in corpus. Edit ${MYTHS_PATH} directly to update.`);
  }

  console.log(`[add-myth] drafting entry for ${args.name} (${args.culture})…`);
  const json = await draft(args);

  console.log("\n--- draft ---");
  console.log(json);
  console.log("--- end draft ---\n");

  const ok = await confirm(`Append this entry to ${MYTHS_PATH}? [y/N] `);
  if (!ok) {
    console.log("Aborted. Nothing written.");
    return;
  }

  await appendFile(MYTHS_PATH, json + "\n", "utf-8");
  console.log(`[add-myth] appended to ${MYTHS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
