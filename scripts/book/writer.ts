import type { ModelMessage } from "ai";
import { config } from "../../src/config.js";
import type { Candidate } from "./planner.js";
import type { ContextItem } from "./context.js";
import { bookChat } from "./llm.js";
import { extractGlosses, findLongGlosses } from "./coverage-checks.js";

// Inline-gloss floor before the gloss-injection safety net fires. The
// open-question structures must actually get taught — a draft below this gets
// one targeted pass that inserts glosses without rewriting the prose. Override
// with BOOK_MIN_GLOSSES (e.g. set high to exercise the retry path in testing).
const MIN_GLOSSES =
  process.env.BOOK_MIN_GLOSSES !== undefined
    ? Number(process.env.BOOK_MIN_GLOSSES)
    : 3;

// Over-length glosses (>12 words) that trigger the brevity-tightening pass.
// Override with BOOK_MAX_LONG_GLOSSES (e.g. set 1 to force the pass in testing).
const MAX_LONG_GLOSSES =
  process.env.BOOK_MAX_LONG_GLOSSES !== undefined
    ? Number(process.env.BOOK_MAX_LONG_GLOSSES)
    : 3;

const OPEN_QUESTIONS_RULE = `Open Spanish questions — if the user message includes an "Open Spanish questions" block, those are grammar/conjugation structures the reader is actively trying to lock in. Two requirements, both mandatory:

1. **Spread.** Weave EVERY listed item into the tomo at least once or twice — not just one of them. Don't deep-dive on a single structure and skip the rest. Pick sentences where each structure fits the meaning, then deliver it. Don't anchor a broad category on a single sub-pattern (e.g. if the open question is "subjuntivo vs indicativo", don't fulfill it solely with "creo que / no creo que" — reach for other triggers like querer que, para que, antes de que, sin que, relative clauses with hypothetical antecedents, negative commands).

2. **Gloss every occurrence, with contrast.**

   Scope (strict): inline glosses exist ONLY to explain the grammar/conjugation structures listed in OPEN SPANISH QUESTIONS. Never gloss vocabulary. Never annotate reused words. Never write "tomo NN", "word seen before", "from vocab", or any callback to prior tomos. If a vocab item needs help, leave it bare — the reader has a Kindle dictionary. The lookups/highlights blocks in the user message are your context for reuse decisions, not material to echo back in the body.

   Coverage: EVERY occurrence of a listed structure gets a gloss — first, second, tenth. The repetition is the lock-in. No "I already glossed this one earlier."

   Form — brevity is the whole point: ideally 5–8 English words, NEVER more than 12. Shape: the quoted Spanish form, then \`=\`, then its job in a few words. Count the words before moving on; if it runs over 12, rewrite it shorter. A gloss that needs a semicolon and a second clause (\`…; "X" would mean…\`) is already too long — cut it. Vary the phrasing so it doesn't read as boilerplate. The body stays Spanish; only the parenthetical is English. No footnotes, no em-dashes for this purpose.

   Placement: put the gloss at the END of the sentence that contains the structure — never mid-sentence. A parenthetical dropped between subject and verb breaks the reader's flow; let the Spanish sentence land complete first, then explain. Because the gloss is now detached from the word it describes, it MUST open by naming that word — the Spanish form in straight double quotes — so the reader knows which structure it refers to. If one sentence uses two listed structures, stack both glosses at the sentence end in the order they appeared, each opening with its own quoted form.

   **Contrast, compactly — and brevity wins.** Where it fits the word budget, name the wrong alternative in a word or two (\`"por" = cause, not "para" = purpose\`). But if the contrast can't be made briefly, DROP it and just name the form's job — a short bare label beats a correct-but-bloated mini-lesson. Never let the contrast push a gloss past 12 words.

   GOOD (note how short each one is):
   - \`Quiero que vengas, aunque no es seguro. (*subjunctive after "querer que"; the arriving isn't real yet*)\`
   - \`Si pudiera, te lo diría. (*"pudiera/diría" = unreal-condition pair; "puedo/diré" = a real plan*)\`
   - \`Yo hablaría con él primero. (*"hablaría" = conditional "would"; "hablaré" = a plain promise*)\`
   - \`Cuando llegué, ya se había ido. (*"había ido" = the past before the past; not "se fue"*)\`
   - \`No mires atrás todavía. (*"no mires" = negative command, borrows subjunctive; "no miras" = a statement*)\`
   - \`Lo hice por ti, no para ti. (*"por" = because of you; "para" = for your benefit*)\`
   - two structures, one sentence: \`No me lo habían dicho antes. (*"habían dicho" = pluperfect, the prior past*) (*"me lo" = indirect + direct object stacked*)\`

   BAD:
   - \`No mires (*…*) atrás\`                      ← mid-sentence, breaks the flow
   - \`(*the past before the past*)\`             ← detached but doesn't name its form
   - \`(*"le" = indirect object pronoun*)\`      ← no contrast, just a label
   - \`(*"habría hablado" — this is the conditional perfect, used for things that would have happened in the past but didn't because some condition wasn't met*)\` ← way too long, a mini-lesson; cut to \`(*"habría hablado" = would have (but didn't)*)\`
   - \`(*tomo 30*)\`                              ← callback, not grammar
   - \`(*word seen before: "rincón"*)\`           ← vocab annotation
   - \`(*"máscara" — mask*)\`                     ← vocab translation
   - \`(*"hervir" — to boil*)\`                   ← vocab translation

3. **Grammaticality wins over coverage — per structure, never wholesale.** If a SINGLE listed structure can't be woven into a sentence without breaking Spanish — mixing incompatible constructions (e.g. \`llevaba semanas iba siendo\`), mangling word order to force an "iba" in, inventing a subjuntivo trigger, jamming a contrast gloss onto a sentence that doesn't actually use the structure — drop THAT ONE for this tomo; it must fit naturally or not appear. But dropping is the rare exception, not the default: a ~2000-word tomo naturally contains many of these structures, so weave and gloss several of them. **Glossing none is never acceptable** — a tomo with zero inline glosses has failed its core teaching job, and a near-empty one is nearly as bad. If you reach "## Para llevarte" and the body has no glosses, stop and add them where the structures already occur before finishing.

If no Open Spanish questions block is present, ignore this rule — and emit no inline parenthetical glosses at all.`;

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
- Confidence threshold for named citations. Cite a named researcher, study, year, anatomical region, or invented technical term ONLY when you are confident of the exact spelling AND the attribution. If you'd hesitate to bet $20 on it — wrong first name (Alan vs Uta Frith), wrong brain region (subgenual cingulate vs insula for interoception), wrong author for a coined term (Jourard didn't write "transparencia unilateral") — attribute generically instead: "la investigación sobre interocepción sugiere", "el trabajo sobre apego adulto distingue", "estudios sobre la brecha caliente-fría muestran". A wrong proper name printed survives the reader's verification step and contaminates the tomo's authority. When in doubt, go generic — vagueness about WHO is cheaper than confident error.
- The "Planner take" block in the user message contains the editor's deeper reasoning for this angle. USE IT as the spine of the tomo — its specificity is what you should match in the body, not dilute.

Length: target 2100–2300 Spanish body words. 1800 is a HARD floor — not a suggestion; 2400 is the ceiling. Aim for the 2100–2300 band so the floor never binds. Before writing "## Para llevarte", check whether the body has cleared 2100. If it has not, you MUST extend with one more beat — a remembered scene, an aftermath, a sensory dwell on a detail already introduced — and only then append the takeaways. Do not stop the body under 2100 because "the ending feels natural"; the natural ending arrives after 2100, not before. Don't pad with summary.

After the body, append a final takeaways section:
- Heading: exactly "## Para llevarte" (no variant).
- 5-8 short bullets, one Spanish sentence each, starting with "- ".
- Distill the actual ideas, observations, contrasts — not the structure of the argument.
- Excluded from the body word count.

${GRAMMAR_GUARDRAILS}

${OPEN_QUESTIONS_RULE}

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
- Body of 2100–2300 words. 1800 is a HARD floor — if you arrive at a natural ending under 2100, extend with one more vignette, image, or beat before appending "## Para llevarte". 2400 is the ceiling.
- A final "## Para llevarte" section with 5-8 bullets distilling what the piece surfaced. Bullets are short Spanish sentences starting with "- ".
- No translation, no footnotes, no parenthetical English.

Wider latitude than essay-mode means: you can break linear time, use recurring images, leave things implicit, end on an image rather than a thesis. But the texture must still feel anchored to the reader's actual life — recognizable mirror text, not generic. Be specific. Name the texture.

Specificity over evocation — recurring failure mode in prior flow tomos:
- Name the thing. The street is Calle de Aragó or Passeig Sant Joan, not "una calle". The smell is el pino quemado del incienso, not "un olor familiar". The bracing is in la mandíbula o en el suelo pélvico, not "en algún lugar del cuerpo". Lyrical flow does not excuse vagueness — it demands more specificity, not less.
- One concrete image developed in depth beats five evocative gestures. Don't recycle the same emotional beat through three metaphors.
- Treat the reader as an adult. Don't soften interior states into "una cosa pequeña que late". If it's the pilot light, name it. If it's a part of him, name which one (the watchtower, Mitchie, the self-monitor).
- The "Planner take" block in the user message has the editor's deeper reasoning. Match its specificity, don't dilute it into mood.

${GRAMMAR_GUARDRAILS}

${OPEN_QUESTIONS_RULE}

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
  highlightsBlock = "",
  openQuestionsBlock = ""
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

  const system = plan.format === "flow" ? FLOW_SYSTEM : ESSAY_SYSTEM;
  const planLabel = plan.format === "flow" ? "Tomo plan (flow)" : "Tomo plan";
  const closing =
    plan.format === "flow"
      ? 'Write the tomo now in Spanish. Pick a form that fits the angle. Target 2100–2300 words of body (1800 hard floor, 2400 ceiling — extend before takeaways if under 2100). After the body, append "## Para llevarte" with 5-8 distilled bullets, then stop. Start with the title heading.'
      : 'Write the tomo now in Spanish. Target 2100–2300 words of body (1800 hard floor, 2400 ceiling — extend before takeaways if under 2100). After the body, append "## Para llevarte" with 5-8 distilled bullets, then stop. Start with the title heading.';

  const user = [
    ...(lookupsBlock ? [lookupsBlock, ""] : []),
    ...(highlightsBlock ? [highlightsBlock, ""] : []),
    ...(openQuestionsBlock ? [openQuestionsBlock, ""] : []),
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

  const messages: ModelMessage[] = [{ role: "user", content: user }];

  let markdown =
    (
      await bookChat({
        model: config.models.anthropicChat,
        system,
        messages,
        maxTokens: 8192,
        label: "writer",
        progress: true,
      })
    ).trim() + "\n";
  const firstCount = countWords(markdown).total;
  if (firstCount < 1800) {
    console.warn(
      `      [writer] first pass ${firstCount} words — retrying with extension prompt`
    );
    const stripped = markdown.replace(/^##\s+Para llevarte[\s\S]*$/m, "").trim();
    const extendPrompt = `The body you wrote came in at ${firstCount} words — under the 1800 hard floor. Extend it by adding one or two more substantive beats BEFORE the takeaways: a remembered scene, an aftermath, a developed mechanism, a sensory dwell. Do NOT pad with summary, restatement, or new metaphors for the same insight. Develop NEW ground — name another mechanism, ground another consequence, follow the thread one step further. Target 2100-2300 body words total when you re-emit.

Re-emit the WHOLE tomo from "# <title>" through "## Para llevarte" with its bullets. Keep the existing opening and any beats that work; add depth where the body thinned out. Same Spanish register, same naming-the-concept rule.

Here is the current draft (without takeaways):

${stripped}`;

    messages.push({ role: "assistant", content: markdown });
    messages.push({ role: "user", content: extendPrompt });

    const retryMd =
      (
        await bookChat({
          model: config.models.anthropicChat,
          system,
          messages,
          maxTokens: 8192,
          label: "writer/extend",
          progress: true,
        })
      ).trim() + "\n";
    const retryCount = countWords(retryMd).total;
    console.warn(
      `      [writer] retry produced ${retryCount} words${retryCount >= 1800 ? " ✓" : " (still under floor)"}`
    );
    if (retryCount > firstCount) markdown = retryMd;
  }

  // Gloss safety net: the open-question structures must actually get taught.
  // The model occasionally ships a draft with zero inline glosses (a teaching
  // failure that also happens on the raw path — it's writer variance, not a
  // plumbing bug). When open questions were provided and the draft glossed
  // none, run ONE targeted pass that inserts concise glosses into the existing
  // prose without rewriting it. Fires only on the zero case, like the word
  // floor above — healthy drafts pay nothing.
  if (openQuestionsBlock) {
    let glossCount = extractGlosses(splitTomo(markdown).body).length;
    // The injection pass can itself flake and add nothing, so retry up to twice
    // before giving up to the Phase-3 coverage warning.
    for (let attempt = 1; glossCount < MIN_GLOSSES && attempt <= 2; attempt++) {
      console.warn(
        `      [writer] ${glossCount} inline gloss(es) (< ${MIN_GLOSSES} floor) — gloss-injection pass ${attempt}/2`
      );
      const originalWords = countWords(markdown).total;
      const glossRetryUser = [
        openQuestionsBlock,
        "",
        `The draft below has only ${glossCount} inline grammar gloss(es) — too few; its job is to teach the OPEN SPANISH QUESTIONS structures. These structures ARE present: any ~2300-word Spanish essay uses subjunctives (after querer que / para que / cuando+future / aunque), conditionals, pluperfects (había + participle), object pronouns (lo/la/le/se), and por/para. Find them and gloss them — you MUST add several glosses; do NOT return the text unchanged. Insert glosses where the structures ALREADY occur; keep any already present. Do NOT rewrite the prose or change meaning — only insert parenthetical glosses at sentence ends.\n\nCRITICAL — keep every gloss SHORT: 5–8 words, 12 the hard max. Shape: quoted form = its job, with at most a one- or two-word contrast. You will be tempted to over-explain — do not.\nSHORT (do this): \`(*"por" = cause; "para" = purpose*)\`, \`(*"había ido" = past-before-the-past, not "fue"*)\`, \`(*"diría" = conditional "would," not plain future*)\`\nTOO LONG (never): \`(*"le da crédito" = indirect object; the signal receives credit; "lo da" would swap what's given*)\`\n\nRe-emit the WHOLE tomo from the title through "## Para llevarte", unchanged except for the added glosses.`,
        "",
        markdown,
      ].join("\n");
      const glossMd =
        (
          await bookChat({
            model: config.models.anthropicChat,
            system,
            messages: [{ role: "user", content: glossRetryUser }],
            maxTokens: 8192,
            label: `writer/gloss.${attempt}`,
            progress: true,
          })
        ).trim() + "\n";
      const newGlossCount = extractGlosses(splitTomo(glossMd).body).length;
      const newWords = countWords(glossMd).total;
      console.warn(
        `      [writer] gloss pass ${attempt} produced ${newGlossCount} gloss(es), ${newWords} words${newGlossCount > glossCount ? " ✓" : " (no gain)"}`
      );
      // Accept only if it added glosses AND didn't gut the prose (glosses add
      // words, so a big drop means the model rewrote instead of annotating).
      if (newGlossCount > glossCount && newWords >= originalWords * 0.9) {
        markdown = glossMd;
        glossCount = newGlossCount;
      } else if (newGlossCount > glossCount) {
        console.warn(
          `      [writer] gloss pass ${attempt} altered body length too much (${originalWords}→${newWords}) — discarding`
        );
      }
    }
  }

  // Brevity safety net: a gloss is a quick aside, not a mini-lesson. The model
  // reliably overshoots the 12-word ceiling, so when a significant share run
  // long, do ONE focused pass that shortens every gloss and touches nothing
  // else — shortening complies far better than the original brevity rule does.
  // A few stragglers are left to the Phase-3 warning rather than burning a call.
  if (openQuestionsBlock) {
    const bodyNow = splitTomo(markdown).body;
    const totalNow = extractGlosses(bodyNow).length;
    const longNow = findLongGlosses(bodyNow).length;
    // Fire on 3+ over-length glosses; 1–2 stragglers go to the Phase-3 warning.
    if (longNow >= MAX_LONG_GLOSSES) {
      console.warn(
        `      [writer] ${longNow}/${totalNow} glosses over 12 words — retrying with a brevity-tightening pass`
      );
      const wordsBefore = countWords(markdown).total;
      const shortenUser = [
        `The tomo below has inline grammar glosses that run too long — ${longNow} exceed 12 words. Rewrite EVERY inline gloss to be SHORT: 5–8 words, 12 absolute max. Keep the quoted Spanish form and its core job; cut explanations, second clauses, and long contrasts down to a one- or two-word contrast (or none). Change ONLY the text inside the (* ... *) glosses — leave every word of the surrounding Spanish prose, every paragraph, and "## Para llevarte" exactly as they are. Re-emit the WHOLE tomo.`,
        "",
        "Target length:",
        '`(*"por" = cause; "para" = purpose*)`  `(*"había ido" = past-before-the-past, not "fue"*)`  `(*"diría" = conditional "would"*)`',
        "",
        markdown,
      ].join("\n");
      const shortMd =
        (
          await bookChat({
            model: config.models.anthropicChat,
            system,
            messages: [{ role: "user", content: shortenUser }],
            maxTokens: 8192,
            label: "writer/brevity",
            progress: true,
          })
        ).trim() + "\n";
      const newLong = findLongGlosses(splitTomo(shortMd).body).length;
      const newTotal = extractGlosses(splitTomo(shortMd).body).length;
      const wordsAfter = countWords(shortMd).total;
      console.warn(
        `      [writer] brevity pass: ${newLong} long / ${newTotal} glosses (was ${longNow}/${totalNow}), ${wordsAfter} words`
      );
      // Accept only if it cut long glosses, kept the gloss set, and preserved
      // the prose (shortening trims a little; a big drop means deleted content).
      if (
        newLong < longNow &&
        newTotal >= totalNow * 0.8 &&
        wordsAfter >= wordsBefore * 0.85
      ) {
        markdown = shortMd;
      } else {
        console.warn(
          `      [writer] brevity pass rejected (long ${longNow}→${newLong}, glosses ${totalNow}→${newTotal}, words ${wordsBefore}→${wordsAfter}) — keeping original`
        );
      }
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
