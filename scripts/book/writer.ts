import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { Candidate } from "./planner.js";
import type { ContextItem } from "./context.js";

const GRAMMAR_GUARDRAILS = `Spanish grammar guardrails — recurring writer-model errors to avoid:

- Subjuntivo only when triggered. Use subjuntivo ONLY after explicit triggers: querer/esperar/dudar/preferir que; para que; antes/después de que; sin que; cuando + future event ("cuando llegue"); relative clauses with non-specific or hypothetical antecedent ("busco a alguien que sepa"); negative belief ("no creo que sea"). Outside these, use indicative.
- Real, specific ongoing things in relative clauses take indicative: "una parte de ti que actúa" (not "que actúe"); "el escáner que sigue funcionando" (not "siga"); "el programa no dispara la alarma" (not "no dispare").
- After "saber cómo" use the infinitive: "no sabe cómo registrar eso" (not "cómo registre eso").
- After "sin" use the infinitive, not gerundio: "sin apretar los puños" (not "sin apretando").
- Parallel "cuando" clauses describing factual present states stay in indicative: "cuando todo está bien" (not "cuando todo estuviera bien"). Only counterfactual or future-projecting "cuando" takes subjuntivo.
- "Lo que" + verb is singular: "Lo que envejecía" (not "Lo que envejecían"). The neuter "lo que" takes singular agreement.
- Tense floats inside paragraphs: pick a tense per scene and stay in it. Don't drift "Envejece despacio" → "Envejecía despacio" without a clear shift.`;

const ESSAY_SYSTEM = `You are writing one tomo — a Spanish essay (non-fiction) — for a single reader (Mitch).

A tomo is a standalone ~2000-word essay. No references to previous tomos. No translation, no footnotes, no parenthetical English.

Treat the reader as an intelligent adult who is learning Spanish — not a child being protected from complexity. 

Follow the style guide. Respect the reader's grammar level. Lean into the recently-learned vocabulary listed in the style guide. Let current grammar foci appear naturally — don't force them.

The essay teaches a real concept with specificity, anchored to a pattern from the reader's life:
- Open with a concrete hook — a scene, a question, a moment in his journal. Never an abstract or "En este tomo vamos a..." intro.
- Use examples. One specific example beats three generalizations.
- Direct quotations use straight double quotes: "así".
- The intersection between life pattern and domain concept must be real — illuminate, don't decorate.
- Don't preach or summarize inside the body. Distillation belongs in the takeaways section.

Depth, naming, anti-repetition — this is where prior tomos have failed:
- NAME THE CONCEPT BY ITS ACTUAL NAME. If the angle invokes cognitive science, neuroscience, philosophy, etc., use the specific terms by name — interocepción, default mode network, corteza prefrontal dorsolateral, predictive coding, teoría polivagal, Geworfenheit, fenomenología, anatta, hippocampus, eje HPA, amígdala, Brodmann 25, ego dissolution, etc. Gloss them once in-prose in Spanish ("la interocepción — la percepción de las señales internas del cuerpo —") and then keep using them. Do NOT soften them into generic phrasing like "el cuerpo dice una cosa y la mente otra" or "una parte de ti que vigila". That register is the failure mode.
- Don't restate the same insight three times in different metaphors. If you've made the point with one image, MOVE FORWARD to the next mechanism, the next consequence, the next refinement — not the next paraphrase. Metaphor stacking is avoidance dressed as style.
- Develop one frame linearly and DEEPLY. A tomo that explores one concept with three mechanisms in detail beats a tomo that gestures at five concepts.
- If a real piece of research, named figure, or specific framework is relevant — cite it. ("Stephen Porges...", "el trabajo de Lisa Feldman Barrett sobre construcción afectiva...", "lo que en IFS se llama un protector preventivo..."). The reader can verify; vagueness is a tell.
- The "Planner take" block in the user message contains the editor's deeper reasoning for this angle. USE IT as the spine of the tomo — its specificity is what you should match in the body, not dilute.

Length: 1800 Spanish body words is a HARD floor — not a suggestion. Target ~2000, 2400 ceiling. Before writing "## Para llevarte", check whether the body has cleared 1800. If it has not, you MUST extend with one more beat — a remembered scene, an aftermath, a sensory dwell on a detail already introduced — and only then append the takeaways. Do not stop the body under 1800 because "the ending feels natural"; the natural ending arrives after 1800, not before. Don't pad with summary.

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

const FLOW_SYSTEM = `You are writing one tomo — a Spanish "flow" piece — for a single reader (Mitch).

A flow tomo is more creative and less structured than an essay. You have wide latitude on shape and voice. Pick one and commit:
- a narrative scene (third-person past, or first-person present — you choose)
- a prose poem or lyrical reflection
- a stream-of-consciousness fragment
- a fragment-collage (numbered/titled vignettes)
- a dialogue or monologue
- a hybrid of any of the above

The only invariants:
- Anchored on the source material provided — transformed, not quoted. The reader will not see the sources, only the finished tomo.
- Body of ~2000 words. 1800 is a HARD floor — if you arrive at a natural ending under 1800, extend with one more vignette, image, or beat before appending "## Para llevarte". 2400 is the ceiling.
- A final "## Para llevarte" section with 5-8 bullets distilling what the piece surfaced. Bullets are short Spanish sentences starting with "- ".
- No translation, no footnotes, no parenthetical English.

Wider latitude than essay-mode means: you can break linear time, use recurring images, leave things implicit, end on an image rather than a thesis. But the texture must still feel anchored to the reader's actual life — recognizable mirror text, not generic. Be specific. Name the texture.

Specificity over evocation — recurring failure mode in prior flow tomos:
- Name the thing. The street is Calle de Aragó or Passeig Sant Joan, not "una calle". The smell is el pino quemado del incienso, not "un olor familiar". The bracing is in la mandíbula o en el suelo pélvico, not "en algún lugar del cuerpo". Lyrical flow does not excuse vagueness — it demands more specificity, not less.
- One concrete image developed in depth beats five evocative gestures. Don't recycle the same emotional beat through three metaphors.
- Treat the reader as an adult. Don't soften interior states into "una cosa pequeña que late". If it's the pilot light, name it. If it's a part of him, name which one (the watchtower, Mitchie, the self-monitor).
- The "Planner take" block in the user message has the editor's deeper reasoning. Match its specificity, don't dilute it into mood.

${GRAMMAR_GUARDRAILS}

Output format:
- "# <title>" on the first line.
- Blank line, then the body. Optional "## <heading>" Spanish section breaks allowed if the form calls for them (never named "Para llevarte").
- No markdown in the body other than headings (no bold, italic, lists, quotes, links, code) — except dialogue in straight double quotes "así".
- Blank line, then "## Para llevarte" with 5-8 bullets.
- End immediately after the last bullet — no closing paragraph, no "Fin", no author's note.`;

export async function write(
  plan: Candidate,
  context: ContextItem[],
  lookupsBlock = "",
  highlightsBlock = ""
): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the writer");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const sources = context.filter((c) => plan.source_refs.includes(c.uuid));
  const sourcesBlock = sources
    .map((c) => {
      const head = `[${c.kind}:${c.uuid}] ${c.date}${c.title ? " — " + c.title : ""}`;
      return `${head}\n${c.text.slice(0, 2000)}`;
    })
    .join("\n\n---\n\n");

  const system = plan.format === "flow" ? FLOW_SYSTEM : ESSAY_SYSTEM;
  const planLabel = plan.format === "flow" ? "Tomo plan (flow)" : "Tomo plan";
  const closing =
    plan.format === "flow"
      ? 'Write the tomo now in Spanish. Pick a form that fits the angle. Target ~2000 words of body (1800 hard floor, 2400 ceiling — extend before takeaways if under 1800). After the body, append "## Para llevarte" with 5-8 distilled bullets, then stop. Start with the title heading.'
      : 'Write the tomo now in Spanish. Target ~2000 words of body (1800 hard floor, 2400 ceiling — extend before takeaways if under 1800). After the body, append "## Para llevarte" with 5-8 distilled bullets, then stop. Start with the title heading.';

  const user = [
    ...(lookupsBlock ? [lookupsBlock, ""] : []),
    ...(highlightsBlock ? [highlightsBlock, ""] : []),
    `# ${planLabel}`,
    `- Título: ${plan.title}`,
    `- Dominio: ${plan.domain}`,
    `- Tema: ${plan.topic}`,
    `- Ángulo: ${plan.angle}`,
    "",
    "# Planner take (use as the spine — match its specificity, don't dilute)",
    plan.take,
    "",
    "# Source material",
    "Draw from these — transform them into the tomo. Do not quote the reader's entries verbatim. The reader will not see these sources, only the finished tomo.",
    "",
    sourcesBlock,
    "",
    closing,
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: user },
  ];

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 8192,
    system,
    messages,
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Writer returned no text block");
  }

  let markdown = textBlock.text.trim() + "\n";
  const firstCount = countWords(markdown).total;
  if (firstCount < 1800) {
    console.warn(
      `      [writer] first pass ${firstCount} words — retrying with extension prompt`
    );
    const stripped = markdown.replace(/^##\s+Para llevarte[\s\S]*$/m, "").trim();
    const extendPrompt = `The body you wrote came in at ${firstCount} words — under the 1800 hard floor. Extend it by adding one or two more substantive beats BEFORE the takeaways: a remembered scene, an aftermath, a developed mechanism, a sensory dwell. Do NOT pad with summary, restatement, or new metaphors for the same insight. Develop NEW ground — name another mechanism, ground another consequence, follow the thread one step further. Target 1900-2100 body words total when you re-emit.

Re-emit the WHOLE tomo from "# <title>" through "## Para llevarte" with its bullets. Keep the existing opening and any beats that work; add depth where the body thinned out. Same Spanish register, same naming-the-concept rule.

Here is the current draft (without takeaways):

${stripped}`;

    messages.push({ role: "assistant", content: markdown });
    messages.push({ role: "user", content: extendPrompt });

    const retry = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 8192,
      system,
      messages,
    });
    const retryBlock = retry.content.find((b) => b.type === "text");
    if (retryBlock && retryBlock.type === "text") {
      const retryMd = retryBlock.text.trim() + "\n";
      const retryCount = countWords(retryMd).total;
      console.warn(
        `      [writer] retry produced ${retryCount} words${retryCount >= 1800 ? " ✓" : " (still under floor)"}`
      );
      if (retryCount > firstCount) markdown = retryMd;
    }
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
