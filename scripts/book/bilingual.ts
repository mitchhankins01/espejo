import { config } from "../../src/config.js";
import { bookChat } from "./llm.js";

/**
 * Faithful/structural bilingual interleave. For every Spanish sentence we emit
 * the sentence, then on the NEXT line a deliberately literal English rendering
 * in italics — the point is to show the reader HOW Spanish maps to English
 * (clause order, function words, tense/aspect), not a smooth idiomatic gloss.
 *
 * Done in chunks: the output is ~2x the input (ES + EN for every sentence), so a
 * single 4000-word book would blow the token ceiling and truncate mid-book.
 * Chunks are order-independent → translated in parallel and reassembled in order.
 */

const SYSTEM = `You are producing a FAITHFUL, STRUCTURAL bilingual study version of a Spanish text for a fluent reader who wants to see exactly how the Spanish maps to English.

For every Spanish sentence, output the Spanish sentence on its own line, then on the NEXT line its English translation wrapped in single asterisks for italics. The two lines form one pair; separate pairs with a blank line.

The English is FAITHFUL/STRUCTURAL, not idiomatic:
- Keep the Spanish clause order wherever English grammar tolerates it. Do not restructure for smoothness.
- Render each content word with its direct counterpart; surface function words and grammatical mechanics rather than hiding them. Examples:
  - "por ti" → "because of you"; "para ti" → "for you" (keep por/para distinct in English).
  - "Quiero que vengas" → "I want [that] you come" (show the subjunctive complement).
  - "Se me cayó" → "It fell on me" rendered structurally, e.g. "[itself] to-me it-fell" only where that stays readable; otherwise the closest structural English that preserves the reflexive/dative.
  - "Llevo años haciéndolo" → "I carry years doing it" before "I've been doing it for years".
- Translate idioms literally but keep the line parseable English. The goal is transparency of mechanics, never natural-sounding prose.
- It must still be grammatical English a reader can parse — faithful, not word-salad. When a maximally literal rendering would be unreadable, step back to the closest structural version that stays readable, and stop there. Never smooth all the way to idiomatic.

Rules:
- Headings ("# ..." and "## ...") are kept EXACTLY as written, Spanish only, on their own line. Do NOT translate them, do NOT add an English line after them. (In particular "## Para llevarte" must survive verbatim.)
- Body paragraphs: split into sentences; each Spanish sentence becomes a pair (ES line, italic EN line), pairs separated by a blank line.
- Bullets ("- ..."): keep the "- " prefix on the Spanish line; put the italic English on the next line indented by two spaces ("  *...*"). Separate bullets with a blank line.
- Treat short interjections, fragments, and quoted speech as their own sentence pairs.
- Output pure markdown. No preamble, no commentary, no closing note. Process the input block by block in order.

Example body pairs:

El mapa vive en tu cabeza.
*The map lives in your head.*

No lo hice por miedo, sino por amor.
*I did not do it because of fear, but because of love.*

Example heading (unchanged, no English line):

## Para llevarte

Example bullet:

- El cerebro no percibe la realidad directamente.
  *The brain does not perceive reality directly.*`;

const CHUNK_WORD_BUDGET = 800;
const CHUNK_CONCURRENCY = 4;

/** Split markdown into chunks of whole blocks under a word budget, preserving order. */
export function chunkMarkdown(
  markdown: string,
  wordBudget = CHUNK_WORD_BUDGET
): string[] {
  const blocks = markdown.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  const wc = (s: string): number =>
    s.split(/\s+/).filter((w) => w.length > 0).length;
  for (const block of blocks) {
    const bw = wc(block);
    if (current.length > 0 && words + bw > wordBudget) {
      chunks.push(current.join("\n\n"));
      current = [];
      words = 0;
    }
    current.push(block);
    words += bw;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return out;
}

export async function interleave(markdown: string): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the bilingual pass");
  }
  const chunks = chunkMarkdown(markdown);
  console.log(
    `      [bilingual] ${chunks.length} chunk(s), up to ${CHUNK_CONCURRENCY} in parallel`
  );
  const translated = await mapWithConcurrency(
    chunks,
    CHUNK_CONCURRENCY,
    async (chunk, i) => {
      const text = await bookChat({
        model: config.models.anthropicFast,
        system: SYSTEM,
        messages: [{ role: "user", content: chunk }],
        maxTokens: 4000,
        label: `bilingual.${i + 1}/${chunks.length}`,
      });
      return text.trim();
    }
  );
  return translated.join("\n\n") + "\n";
}
