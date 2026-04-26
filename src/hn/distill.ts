import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { computeCost, type CostBreakdown, type TokenUsage } from "./pricing.js";

const DISTILL_MODEL = "claude-opus-4-7";
const MAX_OUTPUT_TOKENS = 4096;

let cachedClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return cachedClient;
}

export interface DistillInput {
  hnUrl: string;
  hnTitle: string | null;
  hnAuthor: string | null;
  hnPoints: number | null;
  totalComments: number;
  selfPostBody: string | null;
  article: { url: string; title: string | null; text: string } | null;
  threadText: string;
}

export interface DistillResult {
  markdown: string;
  model: string;
  usage: TokenUsage;
  cost: CostBreakdown;
}

const SYSTEM_PROMPT = `You distill Hacker News threads into "signal from various angles" — not summaries, not exhaustive lists. Surface what matters. Skip the noise.

OUTPUT FORMAT (markdown):

## Headline facts
Lead with what the article actually says or what shipped. Boring "what" first — facts before takes. 3-6 sentences max. Strip marketing language.

## Where it wins / Where it loses
(Or an equivalent structural framing if the post isn't a product release — e.g., "What the data shows / What it leaves out", "Why it's interesting / Why skeptics push back".)
Two short subsections. Bullets allowed.

## The hidden number
The single fact, statistic, or detail buried in the discussion or article that nobody is leading with — but probably matters most. One paragraph. Skip this section entirely if there isn't a clear hidden number; do not fabricate one.

## Comments by angle
Group substantive HN comments by the kind of contribution they make, not by chronology. Use these categories as starting points (only include those that apply, add others if needed):
- **Practitioner reports** — real-world usage, benchmarks people ran, "I tried X and Y happened"
- **Contrarian takes** — disagreements worth engaging, not pile-ons
- **Structural / cynical takes** — market dynamics, enshittification, incentives
- **Anecdotes** — concrete stories that illustrate something general

Within each, paraphrase in one or two sentences. Quote sparingly — only when a phrase is load-bearing (a meme, a coined term, distinctive framing). When you do quote, keep it short.

## Useful resources
Tools, links, papers, prior threads mentioned in passing that are worth saving. Bullet list with a short note each. Skip the section entirely if none.

## The actual signal
Numbered list (typically 3-6 items) of what the story really is, beyond the surface complaints. Sharp, opinionated, specific. This IS the closing — no separate "in conclusion" wrap-up.

SKIP:
- Generic agreement comments
- Jokes that don't carry information
- Pile-on comments that don't add a new angle
- Marketing language from the original post
- Trying to cover every comment — selectivity is the point

VOICE:
- Concise. Pleasant to read in email. No filler.
- Plain prose for nuance, sparing bullets for enumerations, headers for structure.
- Markdown only. No emoji unless the article itself uses them.

The user message contains an ARTICLE block (or "(no linked article)" for self-posts) and an HN THREAD block with flattened comments tagged by [path] and indentation. Read everything before writing.`;

function buildUserMessage(input: DistillInput): string {
  const articleBlock = input.article
    ? [
        "ARTICLE",
        `Title: ${input.article.title ?? "(unknown)"}`,
        `URL: ${input.article.url}`,
        "Body:",
        input.article.text || "(empty body)",
      ].join("\n")
    : "ARTICLE\n(no linked article — this is a self-post; the body is in the HN thread block below.)";

  const threadHeader = [
    "HN THREAD",
    `URL: ${input.hnUrl}`,
    `Title: ${input.hnTitle ?? "(untitled)"}`,
    `Submitted by: ${input.hnAuthor ?? "[deleted]"}` +
      (input.hnPoints != null ? ` (${input.hnPoints} points` : " (") +
      `${input.totalComments} comments)`,
  ].join("\n");

  const selfPost = input.selfPostBody
    ? `\n\nSelf-post body:\n${input.selfPostBody}`
    : "";

  return [
    articleBlock,
    "",
    threadHeader + selfPost,
    "",
    "COMMENTS (indent = depth, [path] = position in tree):",
    input.threadText || "(no comments)",
  ].join("\n");
}

export async function distillThread(input: DistillInput): Promise<DistillResult> {
  const anthropic = getAnthropic();
  const userMessage = buildUserMessage(input);

  const response = await anthropic.messages.create({
    model: DISTILL_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const markdown = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  const cost = computeCost(DISTILL_MODEL, usage);

  return { markdown, model: DISTILL_MODEL, usage, cost };
}
