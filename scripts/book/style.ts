import { readFile, writeFile, stat } from "fs/promises";
import { existsSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";

const VIVO_PATH = "Artifacts/Project/Español Vivo.md";
const STYLE_PATH = "books/style.md";

const DISTILL_PROMPT = `You are distilling a Spanish-learning journal into a compact style guide for a writer who will produce 1950-2400 word Spanish tomos (mini-books) for the learner. The guide must be actionable inside a prompt — no meta-commentary, no "this document contains".

Extract and organize into these sections (use these exact headings):

## Reader
One paragraph: level, background, disposition.

## Tenses — comfortable
Bullet list of tenses the reader uses naturally. One line each.

## Tenses — learning (use, but sparingly and clearly)
Bullet list of tenses marked 🟡 in the source. One line each.

## Current grammar focus
The active "Focus Actual" from the source, paraphrased in one short paragraph. Call out trigger phrases and common traps.

## Vocabulary to lean into
Bullet list of recently resolved / newly emerging words and phrases the reader should see again. Include brief gloss in parens if useful.

## Avoid
Bullet list of anglicisms, false friends, and recurring errors to steer clear of.

## Voice
2-3 sentences: warm, specific, not academic, not motivational. Match the reader's actual journaling voice when possible.

Output pure markdown starting with the first "## Reader". No preamble. No closing note. Keep it under 700 words total.`;

export async function ensureStyle(): Promise<string> {
  if (await isStyleFresh()) {
    return readFile(STYLE_PATH, "utf-8");
  }
  console.log("[style] regenerating books/style.md from Español Vivo.md");
  const vivo = await readFile(VIVO_PATH, "utf-8");
  const style = await distill(vivo);
  await writeFile(STYLE_PATH, style, "utf-8");
  return style;
}

async function isStyleFresh(): Promise<boolean> {
  if (!existsSync(STYLE_PATH)) return false;
  const [vivoStat, styleStat] = await Promise.all([
    stat(VIVO_PATH),
    stat(STYLE_PATH),
  ]);
  return styleStat.mtimeMs >= vivoStat.mtimeMs;
}

async function distill(vivo: string): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to distill style.md");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: DISTILL_PROMPT,
    messages: [{ role: "user", content: vivo }],
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("Anthropic returned no text block for style distillation");
  }
  return text.text.trim() + "\n";
}
