import type { ModelMessage } from "ai";
import { config } from "../../src/config.js";
import type { Candidate } from "./planner.js";
import type { ContextItem } from "./context.js";
import { bookChat, bookChatMeta } from "./llm.js";

// Length band for a tomo body (Spanish words, excluding "## Para llevarte").
// The reader doubled the target length; these replace the old ~2000-word band.
const TARGET_WORDS = 4000;
const FLOOR_WORDS = 3600;
const CEILING_WORDS = 4400;

// Max output tokens for the writer. ~4000 Spanish words ≈ 5300 tokens; the
// ceiling leaves ample headroom so a complete book never hits `length`.
const WRITER_MAX_TOKENS = 16000;

const GRAMMAR_GUARDRAILS = `Spanish grammar guardrails — recurring writer-model errors to avoid:

- Subjuntivo only when triggered. Use subjuntivo ONLY after explicit triggers: querer/esperar/dudar/preferir que; para que; antes/después de que; sin que; cuando + future event ("cuando llegue"); relative clauses with non-specific or hypothetical antecedent ("busco a alguien que sepa"); negative belief ("no creo que sea"). Outside these, use indicative.
- Real, specific ongoing things in relative clauses take indicative: "una parte de ti que actúa" (not "que actúe"); "el escáner que sigue funcionando" (not "siga"); "el programa no dispara la alarma" (not "no dispare").
- After "saber cómo" use the infinitive: "no sabe cómo registrar eso" (not "cómo registre eso").
- After "sin" use the infinitive, not gerundio: "sin apretar los puños" (not "sin apretando").
- Parallel "cuando" clauses describing factual present states stay in indicative: "cuando todo está bien" (not "cuando todo estuviera bien"). Only counterfactual or future-projecting "cuando" takes subjuntivo.
- "Lo que" + verb is singular: "Lo que envejecía" (not "Lo que envejecían"). The neuter "lo que" takes singular agreement.
- Tense floats inside paragraphs: pick a tense per scene and stay in it. Don't drift "Envejece despacio" → "Envejecía despacio" without a clear shift.`;

const ESSAY_SYSTEM = `You are writing one tomo — a Spanish essay (non-fiction) — for a single reader (Mitch).

A tomo is a standalone ~${TARGET_WORDS}-word essay. No references to previous tomos. No translation, no footnotes, no parenthetical English, no inline glosses.

The reader is a fluent adult who reads full, natural Spanish — and a literal English translation is generated separately and pairs with every sentence. So write the richest, most natural Spanish the subject calls for: real vocabulary, real syntax, idioms, full tenses. Do NOT simplify, do NOT pin to a learner register, do NOT avoid a word because it might be hard. Clarity and precision, not difficulty-avoidance.

The essay does TWO jobs at once: it teaches a real domain mechanism in genuine depth, AND anchors it to a pattern from the reader's life. The life pattern is the anchor; the mechanism is the lesson. A tomo that only reflects his life back to him — with the science merely name-dropped — is the exact failure the reader has complained about. Teach him something he did not already know.
- Open with a concrete hook. The hook MUST trace to something actually present in the SOURCE MATERIAL — a moment, a quote, a detail he wrote. If the sources are abstract (distilled insights with no concrete scene), open on the abstract TENSION or on the domain mechanism itself — NOT on an invented scene. Never an "En este tomo vamos a..." intro.
- Use examples. One specific example beats three generalizations.
- Direct quotations use straight double quotes: "así".
- The intersection between life pattern and domain mechanism must be real — illuminate, don't decorate.
- Don't preach or summarize inside the body. Distillation belongs in the takeaways section.

Anchoring and anti-hallucination — this is the failure mode the reader cares most about:
- Anchor every scene, detail, and quote in the SOURCE MATERIAL provided. Transform it; never invent a scene, a person, a place, an object (e.g. a specific gift), or an event that the sources don't support — and never invent one just to satisfy the "open with a concrete hook" rule. If the sources don't give you enough concrete texture, open on the abstract tension or the mechanism and develop the IDEA more deeply rather than fabricating biography. A fabricated specific the reader can't recognize as his own breaks the whole point of the series.
- Preserve the DIRECTION of every action exactly as the sources state it: who did what TO whom, who gave and who received, who reached out and who went silent. Do not swap roles or default to a stereotype (e.g. assuming the other person was the gift-giver). If the sources don't make the direction unambiguous, don't assert one.
- Treat the "Current state" block (if present in the user message) as authoritative ground truth about who is current vs. past and the live status of each thread. The source insights/entries are snapshots from when they were written and may describe a relationship or situation that has since changed. If a source frames something as live (an ongoing bond, an unmet need from someone) but the Current state block says it has ended, write it in the past — do not portray an ended relationship as a current source of need.
- TEACH THE NAMED MECHANISM. The user message names a "mechanism_to_teach". That mechanism is the lesson of the tomo — devote substantial, structured space to actually TEACHING it: what it is, how it works, what the research broadly shows, and how it explains the reader's pattern. Don't name-drop it and move on; a passing mention is the failure mode the reader complained about. Name it by its actual name and explain the machinery.
- NAME CONCEPTS BY THEIR ACTUAL NAMES — this is encouraged, not risky. Established domain concepts (interocepción, default mode network, corteza prefrontal dorsolateral, predictive coding, teoría polivagal, Geworfenheit, fenomenología, anatta, hipocampo, eje HPA, amígdala, ego dissolution, etc.) are general knowledge — naming them is NOT a hallucination risk and the confidence threshold below does NOT apply to them. Gloss each once in-prose in Spanish ("la interocepción — la percepción de las señales internas del cuerpo —") and then keep using it. Do NOT soften a real concept into generic phrasing like "el cuerpo dice una cosa y la mente otra" — that vague register is itself a failure mode. When you are confident of how an established mechanism works, explain it confidently.
- Don't restate the same insight three times in different metaphors. If you've made the point with one image, MOVE FORWARD to the next mechanism, the next consequence, the next refinement — not the next paraphrase. Metaphor stacking is avoidance dressed as style.
- Develop one frame linearly and DEEPLY. A tomo that explores one concept with several mechanisms in detail beats one that gestures at five.
- Confidence threshold — applies to PROPER NOUNS AND PRECISE ATTRIBUTIONS ONLY, not to naming concepts. Give a specific researcher's name, a study, a year, or attribute the coining of a term to a specific person ONLY when you are confident of the exact spelling AND the attribution. If you'd hesitate to bet $20 on it — wrong first name, wrong year, wrong author for a coined term — make the claim generically instead: "la investigación sobre interocepción sugiere", "el trabajo sobre apego adulto distingue". A wrong proper name survives the reader's verification step and contaminates the tomo's authority. This is NOT license to avoid naming the concept itself — name the concept, just don't pin a shaky proper noun to it.
- If a "Research grounding" block is present in the user message, those are real fetched paper abstracts. You MAY cite them (surname + year) for domain claims — but at most one or two, and ONLY if a paper directly supports the specific point. If none fit the narrative, IGNORE them and stay generic. Never contort the essay to wedge a paper in, and never cite a paper not in that block.
- The "Planner take" block in the user message contains the editor's deeper reasoning for this angle. USE IT as the spine of the tomo — match its specificity, don't dilute it.

Length: target ${TARGET_WORDS} Spanish body words. ${FLOOR_WORDS} is a HARD floor — not a suggestion; ${CEILING_WORDS} is the ceiling. Aim for the band around ${TARGET_WORDS} so the floor never binds. Before writing "## Para llevarte", check whether the body has cleared the floor. If it has not, you MUST extend with one more beat — a remembered scene, an aftermath, a developed mechanism, a sensory dwell on a detail already introduced — and only then append the takeaways. Don't stop the body short because "the ending feels natural"; and don't pad with summary.

After the body, append a final takeaways section:
- Heading: exactly "## Para llevarte" (no variant).
- 5-8 short bullets, one Spanish sentence each, starting with "- ".
- Distill the actual ideas, observations, contrasts — not the structure of the argument.
- Excluded from the body word count.

${GRAMMAR_GUARDRAILS}

Output format:
- "# <title>" on the first line.
- Blank line, then prose body in paragraphs. 2-4 optional "## <heading>" Spanish section breaks allowed (never named "Para llevarte").
- No markdown in the body other than headings (no bold, italic, lists, quotes, links, code).
- Blank line, then "## Para llevarte" with bullets.
- End immediately after the last bullet — no closing paragraph, no "Fin", no author's note.`;

const CLOSING = `Write the tomo now in Spanish. Target ${TARGET_WORDS} words of body (${FLOOR_WORDS} hard floor, ${CEILING_WORDS} ceiling — extend before takeaways if under the floor). After the body, append "## Para llevarte" with 5-8 distilled bullets, then stop. Start with the title heading.`;

function hasTakeaways(markdown: string): boolean {
  return /^##\s+Para llevarte\s*$/m.test(markdown);
}

export async function write(
  plan: Candidate,
  context: ContextItem[],
  lookupsBlock = "",
  highlightsBlock = "",
  academicBlock = "",
  currentStateBlock = ""
): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the writer");
  }

  const sources = context.filter((c) => plan.source_refs.includes(c.uuid));
  const sourcesBlock = sources
    .map((c) => {
      const head = `[${c.kind}:${c.uuid}] ${c.date}${c.title ? " — " + c.title : ""}`;
      return `${head}\n${c.text.slice(0, 2000)}`;
    })
    .join("\n\n---\n\n");

  const stateBlock = currentStateBlock.trim()
    ? [
        "# Current state — ground truth (derived from the reader's most recent journal entries)",
        "Who is current vs. past and the live status of each thread, distilled from the reader's latest entries. Because it is built from newer data than the source material, it OVERRIDES stale framing there: if a source describes a relationship or need as live but this block says it has ended, write it in the past tense.",
        "",
        currentStateBlock.trim(),
        "",
      ]
    : [];

  const user = [
    ...(lookupsBlock ? [lookupsBlock, ""] : []),
    ...(highlightsBlock ? [highlightsBlock, ""] : []),
    ...(academicBlock ? [academicBlock, ""] : []),
    ...stateBlock,
    `# Tomo plan`,
    `- Título: ${plan.title}`,
    `- Dominio: ${plan.domain}`,
    `- Tema: ${plan.topic}`,
    `- Mecanismo a enseñar (the lesson — teach this in depth, don't just name it): ${plan.mechanism_to_teach}`,
    `- Ángulo: ${plan.angle}`,
    "",
    "# Planner take (use as the spine — match its specificity, don't dilute)",
    plan.take,
    "",
    "# Source material — biographical facts (the reader's own life)",
    "Draw from these — transform them into the tomo. Do not quote the reader's entries verbatim. The reader will not see these sources, only the finished tomo. These are the ONLY biographical facts you may use: every scene, person, gift, event, and quote must come from here (or be consistent with the Current state block). Preserve the direction of every action exactly as stated.",
    "",
    sourcesBlock,
    "",
    CLOSING,
  ].join("\n");

  const messages: ModelMessage[] = [{ role: "user", content: user }];

  const first = await bookChatMeta({
    model: config.models.bookWriter,
    system: ESSAY_SYSTEM,
    messages,
    maxTokens: WRITER_MAX_TOKENS,
    label: "writer",
    progress: true,
  });
  let markdown = first.text.trim() + "\n";

  // Gate 1 — truncation. A book cut off at the token ceiling, or one that never
  // reached "## Para llevarte", is incomplete; a naive word count would pass it
  // and ship a mid-sentence book to the Kindle. Detect and regenerate once.
  const truncated = first.finishReason === "length" || !hasTakeaways(markdown);
  if (truncated) {
    console.warn(
      `      [writer] incomplete draft (finishReason=${first.finishReason}, hasParaLlevarte=${hasTakeaways(markdown)}) — regenerating once`
    );
    const retry = await bookChatMeta({
      model: config.models.bookWriter,
      system: ESSAY_SYSTEM,
      messages: [
        { role: "user", content: user },
        {
          role: "user",
          content:
            "Your previous draft was cut off before finishing. Re-emit the COMPLETE tomo from the title heading through the full \"## Para llevarte\" bullets. You have ample room — pace the body so you reach the takeaways well within it. Do not stop mid-section.",
        },
      ],
      maxTokens: WRITER_MAX_TOKENS,
      label: "writer/complete",
      progress: true,
    });
    const retryMd = retry.text.trim() + "\n";
    if (hasTakeaways(retryMd) && retry.finishReason !== "length") {
      markdown = retryMd;
    } else {
      console.warn(
        `      [writer] regeneration still incomplete (finishReason=${retry.finishReason}) — keeping longer of the two; Phase-3 review must check the ending`
      );
      if (countWords(retryMd).total > countWords(markdown).total) markdown = retryMd;
    }
  }

  // Gate 2 — length floor. A complete-but-short book gets ONE extend pass that
  // develops new ground (not summary) up to the band. Fires only below the floor.
  const bodyWords = countWords(markdown).total;
  if (hasTakeaways(markdown) && bodyWords < FLOOR_WORDS) {
    console.warn(
      `      [writer] body ${bodyWords} words — under the ${FLOOR_WORDS} floor; one extend pass`
    );
    const stripped = markdown.replace(/^##\s+Para llevarte[\s\S]*$/m, "").trim();
    const extendPrompt = `The body came in at ${bodyWords} words — under the ${FLOOR_WORDS} hard floor. Extend it by adding one or two substantive beats BEFORE the takeaways: a remembered scene, an aftermath, a developed mechanism, a sensory dwell. Do NOT pad with summary, restatement, or new metaphors for the same insight — develop NEW ground. Target ${TARGET_WORDS} body words total.

Re-emit the WHOLE tomo from "# <title>" through "## Para llevarte" with its bullets. Keep the existing opening and any beats that work; add depth where the body thinned out.

Current draft (without takeaways):

${stripped}`;
    const extended = await bookChat({
      model: config.models.bookWriter,
      system: ESSAY_SYSTEM,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: markdown },
        { role: "user", content: extendPrompt },
      ],
      maxTokens: WRITER_MAX_TOKENS,
      label: "writer/extend",
      progress: true,
    });
    const extendedMd = extended.trim() + "\n";
    const extendedWords = countWords(extendedMd).total;
    console.warn(
      `      [writer] extend produced ${extendedWords} words${extendedWords >= FLOOR_WORDS ? " ✓" : " (still under floor)"}`
    );
    if (hasTakeaways(extendedMd) && extendedWords > bodyWords) markdown = extendedMd;
  }

  return markdown;
}

export interface WordCounts {
  total: number;
}

export function countWords(markdown: string): WordCounts {
  const parts = splitTomo(markdown);
  const stripHeadings = (s: string): string => s.replace(/^##\s.+$/gm, "");
  const stripped = stripHeadings(parts.body).trim();
  if (stripped.length === 0) return { total: 0 };
  const total = stripped.split(/\s+/).filter((w) => w.length > 0).length;
  return { total };
}

export interface TomoParts {
  title: string;
  body: string;
  takeaways: string;
  nota: string;
}

export function splitTomo(markdown: string): TomoParts {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const withoutTitle = markdown.replace(/^#\s+.+\n?/, "");

  const takeawaysIdx = withoutTitle.search(/^##\s+Para llevarte\s*$/m);
  const notaIdx = withoutTitle.search(/^##\s+Reader notes\s*$/m);

  if (takeawaysIdx === -1 && notaIdx === -1) {
    return { title, body: withoutTitle.trim(), takeaways: "", nota: "" };
  }

  if (takeawaysIdx === -1) {
    return {
      title,
      body: withoutTitle.slice(0, notaIdx).trim(),
      takeaways: "",
      nota: withoutTitle.slice(notaIdx).trim(),
    };
  }

  if (notaIdx === -1) {
    return {
      title,
      body: withoutTitle.slice(0, takeawaysIdx).trim(),
      takeaways: withoutTitle.slice(takeawaysIdx).trim(),
      nota: "",
    };
  }

  return {
    title,
    body: withoutTitle.slice(0, takeawaysIdx).trim(),
    takeaways: withoutTitle.slice(takeawaysIdx, notaIdx).trim(),
    nota: withoutTitle.slice(notaIdx).trim(),
  };
}
