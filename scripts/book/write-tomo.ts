/**
 * Phase 2 — write the picked tomo(s), end to end.
 *
 *   pnpm write-tomo --pick=3             # write one
 *   pnpm write-tomo --pick=2,3,5         # write several IN PARALLEL (cap 2)
 *   pnpm write-tomo --pick=3 --dry       # print draft + verify report, save nothing
 *   pnpm write-tomo --verify=59,60       # re-run the verifier against written tomo(s)
 *
 * Per pick, in one pass: draft (with truncation/extend/condense gates) →
 * tilde + word-band checks → fact-check verifier → bilingual interleave →
 * EPUB build. Everything lands in books/ ready for review:
 *
 *   books/tomos/NNNN.md              Spanish draft        ← review/edit this
 *   books/tomos/NNNN.verify.md       fact-check flags     ← read this
 *   books/tomos/NNNN-bilingual.md    ES/EN interleave
 *   books/tomos/NNNN.context.json    exact writer context (for --verify re-checks)
 *   books/build/*.epub               ready to send
 *
 * Then deliver with `pnpm publish-tomo NNNN` — which rebuilds the bilingual +
 * EPUB automatically if the .md was edited after review.
 *
 * The candidate menu comes from `pnpm plan-tomo` (books/next-plan.json); each
 * pick is WRITTEN by the author leg that pitched it (model-comparison flow).
 */
import { writeFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { pool } from "../../src/db/client.js";
import {
  bookChat,
  bookChatMeta,
  preflightLegs,
  mechanicalLeg,
  legByline,
  mapWithConcurrency,
  atomicWriteJson,
  errorMessage,
  readHistory,
  appendHistory,
  nextTomoNumber,
  loadSavedPlan,
  updatePlanAfterBatch,
  gatherContext,
  gatherLongArcContext,
  fetchContextByUuid,
  fetchRecentEntries,
  deriveCurrentState,
  formatCurrentStateBlock,
  renderContextItems,
  checkTildes,
  splitTomo,
  countWords,
  interleave,
  buildEpub,
  tomoFilename,
  paddedTomo,
  tomoMdPath,
  tomoBilingualPath,
  BOOK_MODELS,
  TOMOS_DIR,
  BUILD_DIR,
  WRITE_CONCURRENCY,
  type BookLeg,
  type Candidate,
  type ContextItem,
  type TomoRecord,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Length band + writer knobs
// ---------------------------------------------------------------------------

// Length band for a tomo body (Spanish words, excluding "## Para llevarte").
// ~1400: short enough to force a single frame developed cleanly with no room
// to restate a point in fresh metaphors. Floor/ceiling track the target at
// ~±15% so the gates stay coherent.
export const TARGET_WORDS = 1400;
export const FLOOR_WORDS = 1200;
export const CEILING_WORDS = 1600;

// Max output tokens for the writer. ~1400 Spanish words ≈ 1900 tokens; the
// ceiling leaves ample headroom so a complete book never hits `length`.
const WRITER_MAX_TOKENS = 16000;

// gpt-5 output-length dial for the GPT author leg. gpt-5.5 defaults to ~"high"
// and overshoots; live test at the 1400 target: "low" → ~1448 body words (in
// band), "medium" → ~1876 (over the ceiling). Re-test if TARGET_WORDS changes.
// Scoped to openai in lib.ts, so Claude/DeepSeek ignore it.
const WRITER_VERBOSITY = "low" as const;

// ---------------------------------------------------------------------------
// Structural molds — rotated per tomo so the series stops reading like one
// template (micro-scene → "no es X, es Y" reversal → exposition → summary
// bullets). The mold for each tomo is assigned here (not chosen by the model),
// recorded in history (`structure`), and the rotation avoids the molds used in
// the last few tomos.
// ---------------------------------------------------------------------------

interface Mold {
  key: string;
  instruction: string;
}

const MOLDS: Mold[] = [
  {
    key: "escena",
    instruction:
      "ESCENA: open on one concrete scene from the source material, rendered closely — then widen out to the mechanism it exemplifies, and return to the scene at the end transformed by what was learned. (Do NOT use the tired pivot \"no es X, es Y\" — find another hinge between scene and mechanism.)",
  },
  {
    key: "mecanismo",
    instruction:
      "MECANISMO: open cold on the science — plunge straight into the mechanism itself, its machinery, its history, what it predicts — and only midway land it in the reader's life, where it suddenly explains the pattern. The science leads; the biography arrives as the payoff.",
  },
  {
    key: "pregunta",
    instruction:
      "PREGUNTA: open with the genuine question or paradox the reader's pattern poses — stated sharply, almost as an accusation against common sense — and run the essay as an inquiry: hypotheses raised, tested against the mechanism and against his lived data, discarded or kept. End on what the surviving answer demands.",
  },
  {
    key: "caso",
    instruction:
      "CASO: chronological case study. Reconstruct one arc from the source material — before, turning point, after — as a narrative with dates and development, weaving the mechanism in as the explanatory thread at each stage. The essay reads like a case history, not an argument.",
  },
  {
    key: "contrapunto",
    instruction:
      "CONTRAPUNTO: open with the plausible-but-wrong reading of the pattern — the interpretation the reader himself (or common sense) held — and dismantle it step by step with the mechanism, showing exactly where the intuition breaks and what replaces it.",
  },
];

/**
 * Assign a mold per pick: skip molds used in the last `avoid` history records,
 * then take the least-recently-used; consecutive picks in one batch also avoid
 * each other. Falls back gracefully when history has no `structure` yet.
 */
function assignMolds(history: { structure?: string }[], count: number): Mold[] {
  const lastUse = new Map<string, number>();
  history.forEach((r, i) => {
    if (r.structure) lastUse.set(r.structure, i);
  });
  const recentlyUsed = new Set(
    history
      .slice(-3)
      .map((r) => r.structure)
      .filter(Boolean) as string[]
  );

  const assigned: Mold[] = [];
  const takenThisBatch = new Set<string>();
  for (let i = 0; i < count; i++) {
    const ranked = [...MOLDS]
      .filter((m) => !takenThisBatch.has(m.key))
      .sort((a, b) => (lastUse.get(a.key) ?? -1) - (lastUse.get(b.key) ?? -1));
    const pick =
      ranked.find((m) => !recentlyUsed.has(m.key)) ?? ranked[0] ?? MOLDS[i % MOLDS.length];
    assigned.push(pick);
    takenThisBatch.add(pick.key);
  }
  return assigned;
}

// ---------------------------------------------------------------------------
// Writer prompt
// ---------------------------------------------------------------------------

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

The reader is a fluent adult who reads full, natural Spanish — and a faithful English translation is generated separately and pairs with every sentence. So write the richest, most natural Spanish the subject calls for: real vocabulary, real syntax, idioms, full tenses. Do NOT simplify, do NOT pin to a learner register, do NOT avoid a word because it might be hard. Clarity and precision, not difficulty-avoidance.

The essay does TWO jobs at once: it teaches a real domain mechanism in genuine depth, AND anchors it to a pattern from the reader's life. The life pattern is the anchor; the mechanism is the lesson. A tomo that only reflects his life back to him — with the science merely name-dropped — is the exact failure the reader has complained about. Teach him something he did not already know.

STRUCTURE — the user message contains a "Structural mold" block naming the shape of THIS tomo. Follow it. The series had collapsed into one template (micro-scene opening → "no es X, es Y" reversal → brain-region exposition → summary bullets) and the reader noticed; the mold rotation exists to break that. Whatever the mold: no "En este tomo vamos a..." intros, and vary your sentence rhythm — not every paragraph ends on a short punchy reversal.

DEPTH over coverage — the reader wants FEWER ideas developed FURTHER:
- One mechanism, actually developed: what it is, how the machinery works, what the research broadly shows, WHERE IT BREAKS (a boundary condition, an exception, a rival explanation and why it loses here), and one worked example mapped step by step onto the reader's pattern.
- Don't restate the same insight in fresh metaphors. If you've made the point with one image, MOVE FORWARD to the next consequence or refinement — not the next paraphrase. Metaphor stacking is avoidance dressed as style.
- A tomo that explores one concept with several mechanisms in detail beats one that gestures at five.
- NAME CONCEPTS BY THEIR ACTUAL NAMES — this is encouraged, not risky. Established domain concepts (interocepción, default mode network, predictive coding, teoría polivagal, Geworfenheit, eje HPA, etc.) are general knowledge — naming them is NOT a hallucination risk. Gloss each once in-prose in Spanish ("la interocepción — la percepción de las señales internas del cuerpo —") and then keep using it. Do NOT soften a real concept into generic phrasing — that vague register is itself a failure mode.
- TEACH THE NAMED MECHANISM. The user message names a "mechanism_to_teach". Devote substantial, structured space to actually TEACHING it. Don't name-drop it and move on.

ANCHORING and anti-hallucination — the failure mode the reader cares most about:
- Anchor every scene, detail, and quote in the SOURCE MATERIAL provided. Transform it; never invent a scene, a person, a place, an object, or an event that the sources don't support — and never invent one just to satisfy a mold's opening. If the sources don't give you enough concrete texture, open on the abstract tension or the mechanism and develop the IDEA more deeply rather than fabricating biography.
- Weave in at least TWO short direct quotes of the reader's own words from the source material, in straight double quotes ("así") — translated to Spanish where the source is English, but recognizably HIS phrasing. His own words carry more anchor-weight than any paraphrase; this is what makes the essay his rather than generic.
- Preserve the DIRECTION of every action exactly as the sources state it: who did what TO whom, who gave and who received, who reached out and who went silent. If the sources don't make the direction unambiguous, don't assert one.
- Treat the "Current state" block (if present) as authoritative ground truth about who is current vs. past. Source Reviews/entries are snapshots and may describe situations that have since changed; if a source frames something as live but Current state says it ended, write it in the past.
- Confidence threshold — applies to PROPER NOUNS AND PRECISE ATTRIBUTIONS ONLY, not to naming concepts. Give a specific researcher's name, a study, a year, or attribute a coined term ONLY when you are confident of the exact spelling AND the attribution. If you'd hesitate to bet $20 on it, make the claim generically instead: "la investigación sobre interocepción sugiere". A wrong proper name contaminates the tomo's authority. This is NOT license to avoid naming the concept itself.
- The "Planner take" block contains the editor's deeper reasoning for this angle. USE IT as the spine of the tomo — match its specificity, don't dilute it.

Length: target ${TARGET_WORDS} Spanish body words. ${FLOOR_WORDS} is a HARD floor; ${CEILING_WORDS} is the ceiling. Before writing "## Para llevarte", check whether the body has cleared the floor. If not, extend with one more beat — a developed mechanism refinement, an aftermath, a boundary condition — and only then append the takeaways. Don't pad with summary.

After the body, append a final takeaways section:
- Heading: exactly "## Para llevarte" (no variant).
- 5-8 short bullets, one Spanish sentence each, starting with "- ".
- Every bullet must ADD something the body didn't say in that form: an implication, a practical application, a question left open, a sharper one-line formulation that reframes the mechanism. A bullet that merely restates a body sentence is dead weight — cut it.
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

// ---------------------------------------------------------------------------
// Writer — draft + truncation/extend/condense gates
// ---------------------------------------------------------------------------

async function write(
  plan: Candidate,
  context: ContextItem[],
  currentState: string,
  mold: Mold
): Promise<string> {
  // Author leg: a candidate carries the provider+model that pitched it, so the
  // finished tomo is written by the same model (the model-comparison flow).
  // Falls back to the default route for legacy plans that predate model tagging.
  const authorProvider = plan.provider;
  const authorModel = plan.model ?? BOOK_MODELS.anthropic;

  const sources = context.filter((c) => plan.source_refs.includes(c.uuid));

  const user = [
    ...formatCurrentStateBlock(currentState),
    `# Tomo plan`,
    `- Título: ${plan.title}`,
    `- Dominio: ${plan.domain}`,
    `- Tema: ${plan.topic}`,
    `- Mecanismo a enseñar (the lesson — teach this in depth, don't just name it): ${plan.mechanism_to_teach}`,
    `- Ángulo: ${plan.angle}`,
    "",
    "# Structural mold for THIS tomo (follow it)",
    mold.instruction,
    "",
    "# Planner take (use as the spine — match its specificity, don't dilute)",
    plan.take,
    "",
    "# Source material — biographical facts (the reader's own life)",
    "Draw from these — transform them into the tomo. The reader will not see these sources, only the finished tomo. These are the ONLY biographical facts you may use: every scene, person, event, and quote must come from here (or be consistent with the Current state block). Preserve the direction of every action exactly as stated.",
    "",
    renderContextItems(sources, 2000),
    "",
    CLOSING,
  ].join("\n");

  const first = await bookChatMeta({
    provider: authorProvider,
    model: authorModel,
    verbosity: WRITER_VERBOSITY,
    system: ESSAY_SYSTEM,
    messages: [{ role: "user", content: user }],
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
      provider: authorProvider,
      model: authorModel,
      verbosity: WRITER_VERBOSITY,
      system: ESSAY_SYSTEM,
      messages: [
        { role: "user", content: user },
        {
          role: "user",
          content:
            'Your previous draft was cut off before finishing. Re-emit the COMPLETE tomo from the title heading through the full "## Para llevarte" bullets. You have ample room — pace the body so you reach the takeaways well within it. Do not stop mid-section.',
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
        `      [writer] regeneration still incomplete (finishReason=${retry.finishReason}) — keeping longer of the two; review must check the ending`
      );
      if (countWords(retryMd) > countWords(markdown)) markdown = retryMd;
    }
  }

  // Gate 2 — length floor. A complete-but-short book gets ONE extend pass that
  // develops new ground (not summary) up to the band. Fires only below the floor.
  const bodyWords = countWords(markdown);
  if (hasTakeaways(markdown) && bodyWords < FLOOR_WORDS) {
    console.warn(
      `      [writer] body ${bodyWords} words — under the ${FLOOR_WORDS} floor; one extend pass`
    );
    const stripped = markdown.replace(/^##\s+Para llevarte[\s\S]*$/m, "").trim();
    const extendPrompt = `The body came in at ${bodyWords} words — under the ${FLOOR_WORDS} hard floor. Extend it by adding one or two substantive beats BEFORE the takeaways: a developed mechanism refinement, an aftermath, a boundary condition, a sensory dwell on a detail already introduced. Do NOT pad with summary, restatement, or new metaphors for the same insight — develop NEW ground. Target ${TARGET_WORDS} body words total.

Re-emit the WHOLE tomo from "# <title>" through "## Para llevarte" with its bullets. Keep the existing opening and any beats that work; add depth where the body thinned out.

Current draft (without takeaways):

${stripped}`;
    const extended = await bookChat({
      provider: authorProvider,
      model: authorModel,
      verbosity: WRITER_VERBOSITY,
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
    const extendedWords = countWords(extendedMd);
    console.warn(
      `      [writer] extend produced ${extendedWords} words${extendedWords >= FLOOR_WORDS ? " ✓" : " (still under floor)"}`
    );
    if (hasTakeaways(extendedMd) && extendedWords > bodyWords) markdown = extendedMd;
  }

  // Gate 3 — length ceiling. The mirror of Gate 2: a complete book over the
  // ceiling gets condense passes that tighten to the band by cutting restatement
  // and over-elaboration WITHOUT dropping any distinct beat. The gpt-5 leg sets
  // textVerbosity so it usually lands in band on the first pass; this is the
  // model-agnostic backstop (and the only length brake for DeepSeek, which has
  // no verbosity dial). Bounded loop.
  const MAX_CONDENSE_PASSES = 2;
  for (let pass = 1; pass <= MAX_CONDENSE_PASSES; pass++) {
    const overWords = countWords(markdown);
    if (!hasTakeaways(markdown) || overWords <= CEILING_WORDS) break;
    console.warn(
      `      [writer] body ${overWords} words — over the ${CEILING_WORDS} ceiling; condense pass ${pass}/${MAX_CONDENSE_PASSES}`
    );
    const condensePrompt = `The body came in at ${overWords} words — over the ${CEILING_WORDS}-word ceiling. Tighten it to about ${TARGET_WORDS} body words. Cut restatement, redundant transitions, and second metaphors that re-make a point you already landed — NOT distinct scenes, mechanisms, or beats. Every concrete biographical detail, person, and quote must survive; preserve the opening and the ending. Sharpen prose; do not summarize away content.

Re-emit the WHOLE tomo from "# <title>" through "## Para llevarte" with its bullets.`;
    const condensed = await bookChat({
      provider: authorProvider,
      model: authorModel,
      verbosity: WRITER_VERBOSITY,
      system: ESSAY_SYSTEM,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: markdown },
        { role: "user", content: condensePrompt },
      ],
      maxTokens: WRITER_MAX_TOKENS,
      label: `writer/condense ${pass}`,
      progress: true,
    });
    const condensedMd = condensed.trim() + "\n";
    const condensedWords = countWords(condensedMd);
    const inBand = condensedWords >= FLOOR_WORDS && condensedWords <= CEILING_WORDS;
    console.warn(
      `      [writer] condense ${pass} produced ${condensedWords} words${inBand ? " ✓" : " (still outside band)"}`
    );
    // Keep a condensed draft only if it is complete, genuinely shorter, and did
    // not overshoot down past the floor — never trade a long-but-whole book for
    // a gutted one. If a pass doesn't improve, stop.
    if (hasTakeaways(condensedMd) && condensedWords < overWords && condensedWords >= FLOOR_WORDS) {
      markdown = condensedMd;
    } else {
      break;
    }
  }

  return markdown;
}

// ---------------------------------------------------------------------------
// Verifier — post-draft fact-check (advisory; flags surface at the review gate)
// ---------------------------------------------------------------------------

type VerifyIssue = "unsupported" | "contradicted" | "stale" | "overclaimed" | "misattributed";

interface VerifyFlag {
  type: "biographical" | "mechanism";
  severity: "high" | "medium" | "low";
  issue: VerifyIssue;
  /** Short verbatim quote from the draft that triggered the flag. */
  quote: string;
  /** What the sources / current state actually say, and why this is a problem. */
  detail: string;
}

interface VerifyResult {
  flags: VerifyFlag[];
}

const VERIFY_SYSTEM = `You are a fact-checker for a personalized Spanish-language essay ("tomo") written for one reader (Mitch). The essay is anchored to real events from his life and teaches a domain concept. Your ONE job: catch specifics the essay gets WRONG, before he reads it.

You are given the finished draft plus four reference blocks: SOURCE MATERIAL (the specific Reviews/entries the writer was told to draw from), WRITER CONTEXT (everything ELSE the writer could see — the rest of the recent + long-arc Reviews and recent entries; biographical anchors frequently live HERE, not in the narrow source list, especially therapy-session details), RECENT JOURNAL (the last few weeks of raw entries — broader ground truth), and CURRENT STATE (a snapshot of who is current vs. past, derived from the recent entries). A specific is supported if it appears in ANY of these blocks — check WRITER CONTEXT before concluding something is unsupported.

Flag two classes of problem ONLY:

1. BIOGRAPHICAL — a concrete specific about his life (a person, scene, object/gift, event, quote, or who-did-what-to-whom) that is:
   - "unsupported": stated as fact in the draft but found in NONE of the reference blocks (likely fabricated to fill a concrete-scene slot);
   - "contradicted": present in the references but the draft gets it wrong — most importantly DIRECTION (who gave vs. received, who reached out vs. went silent, who did the action);
   - "stale": framed as a live/current situation (an ongoing bond, an unmet need from someone) that the CURRENT STATE or RECENT JOURNAL shows has ended or changed.

2. MECHANISM — a domain/science claim that is:
   - "overclaimed": stated more strongly or specifically than established knowledge supports (a mechanism described as settled when it isn't, a causal claim too strong);
   - "misattributed": a named researcher, study, year, anatomical region, or "coined by X" attribution that is wrong or that you cannot verify with confidence.
   NOTE: simply NAMING an established concept (default mode network, interocepción, predictive coding, Geworfenheit, etc.) is CORRECT and good — do NOT flag a concept just for being named. Only flag a shaky proper noun or an overstated mechanism.

Rules:
- Be conservative. If a specific is supported by ANY reference block, do NOT flag it. Transformation/paraphrase of a real source detail is fine — only flag genuine errors.
- Do NOT emit a flag you then conclude is not an error. If your own reasoning lands on "this is supported" / "no actual error" / "just a note", OMIT it entirely — a flag means a real problem the reader must fix, not a margin note.
- Prefer precision over volume. A short list of real problems beats a long list of nitpicks. An empty list is the correct and expected output for a clean draft.
- "quote" must be a SHORT verbatim span copied from the draft (Spanish is fine).
- Direction errors and stale-state errors are the highest-value catches — weight them "high".

Output STRICT JSON only — no prose, no markdown, no code fences:
{
  "flags": [
    { "type": "biographical", "severity": "high", "issue": "contradicted", "quote": "...", "detail": "The draft says X gave Y flowers, but the source Review says Mitch gave them to Miguel — direction inverted." }
  ]
}
If the draft is clean, return: { "flags": [] }`;

const VALID_ISSUES: VerifyIssue[] = [
  "unsupported",
  "contradicted",
  "stale",
  "overclaimed",
  "misattributed",
];

/** Cross-reference a draft against its sources + recent journal + current state. */
async function verifyTomo(
  plan: Candidate,
  markdown: string,
  context: ContextItem[],
  currentState: string
): Promise<VerifyResult> {
  const recentEntries = await fetchRecentEntries(21);

  // The writer's anchors live across the WHOLE context bundle it was given, not
  // just the planner-picked source_refs — therapy Reviews in particular sit in
  // the broader pool. Render the picked sources as primary, but expose
  // the rest as WRITER CONTEXT so the verifier checks against everything the
  // writer could see (the gap that caused real anchors to be mis-flagged).
  const refSet = new Set(plan.source_refs);
  const sources = context.filter((c) => refSet.has(c.uuid));
  const otherContext = context.filter((c) => !refSet.has(c.uuid));

  const recentBlock =
    recentEntries.length === 0
      ? "(none)"
      : recentEntries
          .map((e) => `[${e.date}]\n${e.text.slice(0, 1500)}`)
          .join("\n\n---\n\n");

  const user = [
    "# DRAFT (the tomo to check)",
    markdown,
    "",
    "# SOURCE MATERIAL (the specific Reviews/entries the writer was told to draw from)",
    renderContextItems(sources, 2000),
    "",
    "# WRITER CONTEXT (everything else the writer could see — other Reviews + recent entries; anchors often live here)",
    renderContextItems(otherContext, 2000),
    "",
    "# RECENT JOURNAL (last 21 days of raw entries — broader ground truth)",
    recentBlock,
    "",
    "# CURRENT STATE (authoritative — who is current vs. past)",
    currentState.trim() || "(none provided)",
    "",
    `The tomo's stated mechanism_to_teach is: ${plan.mechanism_to_teach}`,
    "",
    "Return the JSON flags object now.",
  ].join("\n");

  // The mechanical route defaults to DeepSeek (a reasoning model) whose
  // thinking tokens bill against this cap. At the old 2048 a whole-essay
  // fact-check could burn the budget reasoning and return empty text, which
  // parseVerifyOutput degrades to {flags: []} — a truncated verify is
  // indistinguishable from a clean draft (suspected cause of the 7-tomo
  // zero-flag streak, tomos 84-90). Give reasoning headroom AND fail loud.
  const { text, finishReason } = await bookChatMeta({
    model: BOOK_MODELS.anthropic,
    system: VERIFY_SYSTEM,
    messages: [{ role: "user", content: user }],
    maxTokens: 8000,
    label: "verify",
  });
  if (finishReason === "length") {
    throw new Error(
      "verifier reply hit the token ceiling (truncated) — treating as verifier failure, not a clean draft"
    );
  }

  return parseVerifyOutput(text);
}

/** Tolerant parse — a malformed verifier reply degrades to "no flags", never throws. */
function parseVerifyOutput(text: string): VerifyResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { flags: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { flags: [] };
  }
  const raw = (parsed as { flags?: unknown }).flags;
  if (!Array.isArray(raw)) return { flags: [] };

  const flags: VerifyFlag[] = [];
  for (const f of raw) {
    const o = f as Record<string, unknown>;
    const type = o.type === "mechanism" ? "mechanism" : "biographical";
    const severity = o.severity === "high" || o.severity === "low" ? o.severity : "medium";
    const issue = VALID_ISSUES.includes(o.issue as VerifyIssue)
      ? (o.issue as VerifyIssue)
      : "unsupported";
    const quote = typeof o.quote === "string" ? o.quote : "";
    const detail = typeof o.detail === "string" ? o.detail : "";
    if (!detail && !quote) continue;
    flags.push({ type, severity, issue, quote, detail });
  }
  return { flags };
}

const SEVERITY_RANK: Record<VerifyFlag["severity"], number> = { high: 0, medium: 1, low: 2 };

/** Render flags as a markdown sidecar / console block for the review gate. */
function formatVerifyReport(n: number, result: VerifyResult): string {
  const padded = paddedTomo(n);
  if (result.flags.length === 0) {
    return `# Tomo ${padded} — verifier\n\n✓ No biographical or mechanism flags. Draft is consistent with sources, recent journal, and current state.\n`;
  }
  const sorted = [...result.flags].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
  const lines = sorted.map((f) => {
    const q = f.quote ? `\n  > ${f.quote}` : "";
    return `- **[${f.severity}] ${f.type}/${f.issue}**${q}\n  ${f.detail}`;
  });
  return [
    `# Tomo ${padded} — verifier`,
    "",
    `⚠️ ${result.flags.length} flag(s) — review before delivering to Kindle:`,
    "",
    ...lines,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Per-tomo pipeline: draft → checks → verify → bilingual → EPUB
// ---------------------------------------------------------------------------

interface WrittenTomo {
  n: number;
  candidate: Candidate;
  words: number;
  structure: string;
}

async function writeOne(
  candidate: Candidate,
  n: number,
  mold: Mold,
  allContext: ContextItem[],
  currentState: string,
  dry: boolean
): Promise<WrittenTomo> {
  const padded = paddedTomo(n);
  console.log(
    `\n[tomo ${padded}] "${candidate.title}" (${candidate.domain}, mold: ${mold.key})${candidate.leg ? ` ✍ ${candidate.leg}` : ""}`
  );

  const markdown = await write(candidate, allContext, currentState, mold);
  const words = countWords(markdown);
  console.log(`      [${padded}] ${words} words`);
  if (words < FLOOR_WORDS || words > CEILING_WORDS) {
    console.warn(
      `      [${padded}] WARN: word count ${words} outside ${FLOOR_WORDS}-${CEILING_WORDS} band`
    );
  }

  for (const h of checkTildes(markdown).hits) {
    console.warn(`      [${padded}] WARN: tilde slip "${h.word}" → "${h.correction}" (${h.count}x)`);
  }

  // Post-draft fact-check. Advisory — flags surface at the review gate; a
  // verifier failure must never block the (already-written) tomo, so we degrade
  // to a warning rather than throwing.
  let verifyReport = "";
  try {
    // Feed the verifier the FULL context bundle (not just source_refs) so it
    // checks anchors against everything the writer could see.
    const result = await verifyTomo(candidate, markdown, allContext, currentState);
    verifyReport = formatVerifyReport(n, result);
    const high = result.flags.filter((f) => f.severity === "high").length;
    console.log(
      `      [${padded}] verifier: ${result.flags.length} flag(s)${high > 0 ? ` (${high} high)` : ""}`
    );
    for (const f of result.flags) {
      console.warn(`      [${padded}] ⚠ [${f.severity}] ${f.type}/${f.issue}: ${f.detail}`);
    }
  } catch (err) {
    console.warn(
      `      [${padded}] verifier failed (${errorMessage(err)}) — review the draft manually`
    );
  }

  if (dry) {
    console.log(`\n--- dry run: tomo ${padded} (not saved, no bilingual/EPUB) ---\n`);
    console.log(markdown);
    if (verifyReport) console.log(`\n${verifyReport}`);
    return { n, candidate, words, structure: mold.key };
  }

  await mkdir(TOMOS_DIR, { recursive: true });
  await writeFile(tomoMdPath(n), markdown, "utf-8");
  console.log(`      [${padded}] saved ${tomoMdPath(n)}`);
  // Emit the exact context bundle the writer saw, so review (and a standalone
  // `--verify`) can check anchors against the real ground truth instead of
  // re-deriving "where do the anchors live" by hand.
  await atomicWriteJson(`${TOMOS_DIR}/${padded}.context.json`, {
    tomo_n: n,
    plan: candidate,
    current_state: currentState,
    context: allContext.map((c) => ({
      uuid: c.uuid,
      kind: c.kind,
      date: c.date,
      title: c.title,
      text: c.text,
    })),
  });
  if (verifyReport) {
    await writeFile(`${TOMOS_DIR}/${padded}.verify.md`, verifyReport, "utf-8");
    console.log(`      [${padded}] verifier report ${TOMOS_DIR}/${padded}.verify.md`);
  }

  // Bilingual + EPUB, chained per tomo so review has everything at once. A
  // failure here must not lose the written tomo — publish-tomo rebuilds both.
  try {
    const bilingualMd = await interleave(markdown);
    await writeFile(tomoBilingualPath(n), bilingualMd, "utf-8");
    console.log(`      [${padded}] bilingual ${tomoBilingualPath(n)}`);
    const byline =
      candidate.leg && candidate.model
        ? legByline({ label: candidate.leg, model: candidate.model })
        : undefined;
    const filename = tomoFilename(n, candidate.title).replace(/\.epub$/, " (bilingual).epub");
    await buildEpub({
      tomoNum: n,
      title: candidate.title,
      markdown: bilingualMd,
      outPath: `${BUILD_DIR}/${filename}`,
      model: byline,
    });
    console.log(`      [${padded}] epub ${BUILD_DIR}/${filename}`);
  } catch (err) {
    console.warn(
      `      [${padded}] bilingual/EPUB failed (${errorMessage(err)}) — the Spanish draft is saved; pnpm publish-tomo ${n} will rebuild`
    );
  }

  return { n, candidate, words, structure: mold.key };
}

// ---------------------------------------------------------------------------
// Args + main
// ---------------------------------------------------------------------------

interface Args {
  picks: number[];
  /** Tomo numbers to re-run the verifier against (read-only; prints, writes nothing). */
  verify: number[];
  dry: boolean;
}

function parseIdList(argv: string[], flag: string): number[] {
  const out: number[] = [];
  for (const a of argv) {
    if (!a.startsWith(`${flag}=`)) continue;
    for (const tok of a.slice(flag.length + 1).split(",")) {
      const v = Number(tok.trim());
      if (!Number.isInteger(v) || v < 1) {
        throw new Error(`${flag} values must be positive integers, got "${tok}"`);
      }
      if (!out.includes(v)) out.push(v);
    }
  }
  return out.sort((a, b) => a - b);
}

function parseArgs(): Args {
  const argv = process.argv;
  const picks = parseIdList(argv, "--pick");
  const verify = parseIdList(argv, "--verify");
  if (verify.length > 0 && picks.length > 0) {
    throw new Error("--verify cannot be combined with --pick");
  }
  return { picks, verify, dry: argv.includes("--dry") };
}

/** The distinct legs a pick batch needs live: each author leg + the mechanical route. */
function legsForPicks(picked: Candidate[]): BookLeg[] {
  const legs = new Map<string, BookLeg>();
  const mech = mechanicalLeg();
  legs.set(`${mech.provider}:${mech.model}`, mech);
  for (const c of picked) {
    if (!c.provider || !c.model) continue; // legacy plan — default route covers it
    legs.set(`${c.provider}:${c.model}`, {
      provider: c.provider,
      model: c.model,
      label: c.leg ?? c.provider,
    });
  }
  return [...legs.values()];
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("[1/4] reading history");
  const history = await readHistory();
  const n = nextTomoNumber(history);
  console.log(`      tomo #${n}, ${history.length} prior`);

  console.log("[2/4] gathering context (recent 14d + long-arc 365d)");
  const context = await gatherContext(14);
  const recentUuids = new Set(context.map((c) => c.uuid));
  const longArc = await gatherLongArcContext(recentUuids, 365);
  console.log(`      recent: ${context.length} items, long-arc: ${longArc.length} reviews`);

  const currentState = await deriveCurrentState();
  console.log(
    currentState
      ? `      current-state: derived from recent entries (${currentState.length} chars)`
      : "      current-state: insufficient recent signal — staleness guard relies on verifier only"
  );

  // --verify mode: re-check already-written tomo(s) against the full bundle.
  if (args.verify.length > 0) {
    console.log(`[verify] re-checking tomo(s) ${args.verify.join(", ")}`);
    const allContext = [...longArc, ...context];
    const validUuids = new Set(allContext.map((c) => c.uuid));
    const wanted = args.verify
      .map((v) => history.find((r) => r.n === v))
      .filter((r): r is TomoRecord => Boolean(r));
    const missing = [
      ...new Set(wanted.flatMap((r) => r.source_uuids).filter((u) => !validUuids.has(u))),
    ];
    if (missing.length > 0) {
      const rescued = await fetchContextByUuid(missing);
      if (rescued.length > 0) {
        console.log(`      rescued ${rescued.length} out-of-window source UUID(s)`);
        allContext.push(...rescued);
      }
    }
    for (const v of args.verify) {
      const mdPath = tomoMdPath(v);
      const rec = history.find((r) => r.n === v);
      if (!existsSync(mdPath)) {
        console.error(`[verify] ${mdPath} not found — skipping`);
        continue;
      }
      if (!rec) {
        console.error(`[verify] tomo ${v} not in history — cannot resolve source_refs; skipping`);
        continue;
      }
      const markdown = await readFile(mdPath, "utf-8");
      const pseudo: Candidate = {
        id: 0,
        format: "essay",
        domain: rec.domain as Candidate["domain"],
        topic: rec.topic,
        mechanism_to_teach: rec.topic,
        angle: "",
        title: rec.title,
        source_refs: rec.source_uuids,
        take: "",
      };
      const result = await verifyTomo(pseudo, markdown, allContext, currentState);
      console.log(`\n${formatVerifyReport(v, result)}`);
    }
    return;
  }

  if (args.picks.length === 0) {
    throw new Error("no candidate selected. Run pnpm plan-tomo first, then --pick=<ids>.");
  }

  console.log(`[3/4] loading plan and picking ${args.picks.join(", ")}`);
  const candidates = await loadSavedPlan(n);
  if (!candidates) {
    throw new Error(`no saved plan for tomo #${n}. Run pnpm plan-tomo first.`);
  }
  const picked: Candidate[] = [];
  for (const id of args.picks) {
    const c = candidates.find((x) => x.id === id);
    if (!c) {
      throw new Error(
        `candidate #${id} not in saved plan. Available ids: ${candidates.map((x) => x.id).join(", ")}`
      );
    }
    picked.push(c);
  }

  // Only the legs this batch actually needs get preflighted — all are hard here
  // (a pick whose author leg is down cannot be written by a substitute).
  await preflightLegs(legsForPicks(picked));

  // Freeze context once; rescue any source UUIDs outside the gather windows.
  const allContext = [...longArc, ...context];
  const validUuids = new Set(allContext.map((c) => c.uuid));
  const missing = [
    ...new Set(picked.flatMap((c) => c.source_refs).filter((u) => !validUuids.has(u))),
  ];
  if (missing.length > 0) {
    const rescued = await fetchContextByUuid(missing);
    if (rescued.length > 0) {
      console.log(`      rescuing ${rescued.length} out-of-window source UUID(s)`);
      allContext.push(...rescued);
      rescued.forEach((c) => validUuids.add(c.uuid));
    }
    const stillMissing = picked
      .flatMap((c) => c.source_refs)
      .filter((u) => !validUuids.has(u));
    if (stillMissing.length > 0) {
      throw new Error(
        `Picked candidate(s) reference source UUIDs not in DB: ${[...new Set(stillMissing)].join(", ")}. Re-plan with pnpm plan-tomo --fresh-plan.`
      );
    }
  }

  // Assign tomo numbers and structural molds up front, then write in parallel.
  const molds = assignMolds(history, picked.length);
  console.log(
    `[4/4] writing ${picked.length} tomo(s) #${n}-${n + picked.length - 1} (concurrency ${WRITE_CONCURRENCY}, molds: ${molds.map((m) => m.key).join(", ")})`
  );
  const numbered = picked.map((c, i) => ({ c, n: n + i, mold: molds[i] }));
  const results = await mapWithConcurrency(numbered, WRITE_CONCURRENCY, ({ c, n: tomoN, mold }) =>
    writeOne(c, tomoN, mold, allContext, currentState, args.dry)
  );

  const written: WrittenTomo[] = [];
  const failed: { id: number; n: number; error: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") written.push(r.value);
    else failed.push({ id: numbered[i].c.id, n: numbered[i].n, error: errorMessage(r.reason) });
  });

  if (!args.dry) {
    // History append is read-modify-write — serialize it after the parallel pass.
    for (const w of written.sort((a, b) => a.n - b.n)) {
      await appendHistory({
        n: w.n,
        title: w.candidate.title,
        format: "essay",
        domain: w.candidate.domain,
        topic: w.candidate.topic,
        source_uuids: w.candidate.source_refs,
        date: new Date().toISOString().slice(0, 10),
        word_count: w.words,
        structure: w.structure,
        bilingual: true,
        leg: w.candidate.leg,
        provider: w.candidate.provider,
        model: w.candidate.model,
      });
    }
    const afterHistory = await readHistory();
    await updatePlanAfterBatch(
      written.map((w) => w.candidate.id),
      nextTomoNumber(afterHistory)
    );
  }

  console.log("\n=== batch summary ===");
  for (const w of written.sort((a, b) => a.n - b.n)) {
    console.log(`  ✓ tomo ${paddedTomo(w.n)} — "${w.candidate.title}" (${w.words}w, ${w.structure})`);
  }
  for (const f of failed) {
    console.log(`  ✗ tomo ${paddedTomo(f.n)} (candidate #${f.id}) — ${f.error}`);
  }
  if (!args.dry && written.length > 0) {
    console.log(
      `\nReview books/tomos/NNNN.md + NNNN.verify.md + NNNN-bilingual.md, fix in place, then deliver with:\n  pnpm publish-tomo ${written.map((w) => w.n).join(",")}`
    );
  }
  console.log("=====================\n");

  if (failed.length > 0 && written.length === 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
