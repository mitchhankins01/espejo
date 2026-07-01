import { config } from "../../src/config.js";
import { bookChat, bookChatMeta } from "./llm.js";

/**
 * Faithful, readable bilingual interleave. For every Spanish sentence we emit
 * the sentence, then on the NEXT line a meaning-faithful English rendering in
 * italics — close to the Spanish so the reader can map it back, but written as
 * careful, natural English. NOT a mechanical structural gloss: no bracket-glosses,
 * no word-order contortions, no forced-literal idioms.
 *
 * Done in chunks: the output is ~2x the input (ES + EN for every sentence), so a
 * single 4000-word book would blow the token ceiling and truncate mid-book.
 * Chunks are order-independent → translated in parallel and reassembled in order.
 */

const SYSTEM = `You are producing a FAITHFUL, READABLE bilingual study version of a Spanish text for a fluent reader. Each Spanish sentence is paired with an English line that stays close to the Spanish — so the reader can map one to the other — but reads like careful, natural English a person would actually write.

For every Spanish sentence, output the Spanish sentence on its own line, then on the NEXT line its English translation wrapped in single asterisks for italics. The two lines form one pair; separate pairs with a blank line.

The English is FAITHFUL but READABLE — close to the source, never mechanical:
- Track the Spanish closely: keep its clause order, emphasis, and register where natural English tolerates it. But when literal order would be awkward, reorder for readable English. Readability wins over mirroring word order.
- Translate meaning, not tokens. Do NOT surface grammatical mechanics with bracket-glosses or hyphenated word-for-word renderings. Examples:
  - "Llevo años haciéndolo" → "I've been doing it for years" (NOT "I carry years doing it").
  - "Quiero que vengas" → "I want you to come" (NOT "I want [that] you come").
  - "Se me cayó el vaso" → "I dropped the glass" / "The glass slipped from my hands" (NOT "[itself] to-me it-fell").
  - "No lo hice por miedo, sino por amor" → "I didn't do it out of fear, but out of love".
- Keep por/para and similar distinctions only when they change the meaning and natural English would carry the distinction anyway ("because of you" vs "for you") — don't contort the sentence to flag grammar.
- Render idioms with their natural English equivalent, not a literal calque.
- The result must read as fluent, faithful English: no brackets, no hyphenated literal compounds, no salad. Smooth to natural English while keeping the meaning and feel of the Spanish.

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
*I didn't do it out of fear, but out of love.*

Example heading (unchanged, no English line):

## Para llevarte

Example bullet:

- El cerebro no percibe la realidad directamente.
  *The brain does not perceive reality directly.*`;

// The "## Para llevarte" takeaways are rendered English-only (renamed
// "## Takeaways") so the reader can confirm they understood the book without the
// Spanish carrying them. Natural, idiomatic English here — NOT the structural
// literal style used for the body.
const TAKEAWAYS_SYSTEM = `You translate the takeaways section of a Spanish essay into natural English so a learner can check their comprehension.

Input is a "## Para llevarte" heading followed by Spanish bullet points.

Output:
- First line: exactly "## Takeaways" (translate the heading to this).
- Then a blank line.
- Then one English bullet per input bullet, each starting with "- ".
- Natural, idiomatic, fluent English — convey the meaning clearly. This is a comprehension check, NOT a literal/structural gloss. Do not include the Spanish, do not add asterisks/italics.
- Preserve the order and count of the bullets. No preamble, no commentary.`;

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

/**
 * Guarantee every English translation line is wrapped in `*...*` italics. The
 * bilingual model occasionally drops the asterisks for a whole chunk (observed
 * in tomos 0064 and 0066), which renders the English as plain text on the
 * Kindle. The output format is strict ES/EN pairs separated by blank lines, so
 * within each non-heading block the English lines sit at odd indices (line 2, 4,
 * …). We re-wrap any that the model left bare. Deterministic — no extra LLM call.
 */
export function ensureItalics(bilingualBody: string): string {
  return bilingualBody
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      // Headings stay verbatim, no English line beneath them.
      if (/^#{1,6}\s/.test(lines[0].trim())) return block;
      // Only normalize clean ES/EN pair blocks (even line count). Odd-length
      // blocks don't pair cleanly, so leave them rather than mis-wrap a line.
      if (lines.length === 0 || lines.length % 2 !== 0) return block;
      return lines.map((line, i) => (i % 2 === 1 ? wrapItalic(line) : line)).join("\n");
    })
    .join("\n\n");
}

/** Wrap a single English line in `*...*`, preserving indent; no-op if already italic or empty. */
function wrapItalic(line: string): string {
  const trailing = line.match(/\s*$/)?.[0] ?? "";
  const trimmed = line.replace(/\s+$/, "");
  const indentMatch = trimmed.match(/^(\s*)(.*)$/);
  const indent = indentMatch?.[1] ?? "";
  const content = indentMatch?.[2] ?? "";
  if (content === "") return line;
  if (content.startsWith("*") && content.endsWith("*") && content.length >= 2) return line;
  return `${indent}*${content}*${trailing}`;
}

async function translateTakeaways(takeawaysMarkdown: string): Promise<string> {
  const text = await bookChat({
    model: config.models.anthropicFast,
    system: TAKEAWAYS_SYSTEM,
    messages: [{ role: "user", content: takeawaysMarkdown }],
    maxTokens: 2000,
    label: "bilingual.takeaways",
  });
  return text.trim();
}

export async function interleave(markdown: string): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the bilingual pass");
  }
  // Split the Spanish "## Para llevarte" takeaways off the body: the body gets
  // the structural ES/EN interleave; the takeaways become English-only.
  const takeawaysIdx = markdown.search(/^##\s+Para llevarte\s*$/m);
  const bodyMarkdown =
    takeawaysIdx === -1 ? markdown : markdown.slice(0, takeawaysIdx).trimEnd();
  const takeawaysMarkdown =
    takeawaysIdx === -1 ? "" : markdown.slice(takeawaysIdx).trim();

  const chunks = chunkMarkdown(bodyMarkdown);
  console.log(
    `      [bilingual] ${chunks.length} chunk(s), up to ${CHUNK_CONCURRENCY} in parallel`
  );
  const translated = await mapWithConcurrency(
    chunks,
    CHUNK_CONCURRENCY,
    async (chunk, i) => {
      // The bilingual output is ~2x the input (ES + EN per sentence). Reasoning
      // models bill their reasoning tokens against this same ceiling: the gpt-5
      // fast tier truncated 800-word chunks at a 4000 cap (tomos 0068-0071,
      // 2026-06-14), and the deepseek-v4-pro default (a reasoning model) tipped
      // an 800-word chunk over an 8000 cap on a denser tomo (0082, 2026-06-27).
      // Since the cap now backstops a reasoning model by default, give it the
      // same headroom as the writer (16000) AND fail loud on truncation — a
      // dropped tail used to ship silently because finishReason was ignored.
      const { text, finishReason } = await bookChatMeta({
        model: config.models.anthropicFast,
        system: SYSTEM,
        messages: [{ role: "user", content: chunk }],
        maxTokens: 16000,
        label: `bilingual.${i + 1}/${chunks.length}`,
      });
      if (finishReason === "length") {
        throw new Error(
          `bilingual chunk ${i + 1}/${chunks.length} hit the token ceiling (truncated). ` +
            `Lower CHUNK_WORD_BUDGET or raise maxTokens — refusing to ship a partial interleave.`
        );
      }
      return text.trim();
    }
  );
  const body = ensureItalics(translated.join("\n\n"));

  if (!takeawaysMarkdown) return body + "\n";
  const takeaways = await translateTakeaways(takeawaysMarkdown);
  return `${body}\n\n${takeaways}\n`;
}
