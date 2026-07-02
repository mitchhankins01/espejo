/**
 * Phase 1 — plan the next tomo menu.
 *
 *   pnpm plan-tomo                       # 4-leg fan-out → up to 8 candidates
 *   pnpm plan-tomo --steer "..."         # nudge the planner with editorial direction
 *   pnpm plan-tomo --fresh-plan          # delete books/next-plan.json first
 *
 * Each live author leg (DeepSeek / Claude / GPT / GLM) drafts CANDIDATES_PER_LEG
 * candidates; a `--pick`'d candidate is later WRITTEN by its originating leg so
 * finished tomos can be compared per model. The menu is saved to
 * books/next-plan.json for `pnpm write-tomo --pick=<ids>`.
 *
 * Anti-repetition (plan-time, the only gate): the planner prompt receives the
 * last 30 tomos plus computed repetition stats (overused title formulas, domain
 * concentration), and every merged candidate is embedding-scored against the
 * recent tomos — the menu prints the max cosine overlap and flags ⚠ re-tread at
 * ≥0.80. Candidates engaging an active series-queue vein are exempt (a vein
 * deliberately repeats).
 */
import { pool } from "../../src/db/client.js";
import {
  bookChat,
  preflightLegs,
  extractJsonObject,
  errorMessage,
  cosineSimilarity,
  embedManyTexts,
  readHistory,
  nextTomoNumber,
  recentTomoSummaries,
  savePlan,
  clearSavedPlan,
  gatherContext,
  gatherLongArcContext,
  deriveCurrentState,
  formatCurrentStateBlock,
  renderContextItems,
  readSeriesQueue,
  PLANNER_LEGS,
  CANDIDATES_PER_LEG,
  PLAN_PATH,
  DOMAINS,
  type BookLeg,
  type Candidate,
  type ContextItem,
  type Domain,
  type TomoSummary,
} from "./lib.js";

const SOURCE_PREVIEW_CHARS = 700;
const OVERLAP_RETREAD = 0.8;

// ---------------------------------------------------------------------------
// Planner prompt
// ---------------------------------------------------------------------------

// The planner runs as a multi-leg fan-out, each leg producing `count`
// candidates of the menu. The prompt is parametrized on the per-leg count, not
// the menu total.
function buildSystem(count: number): string {
  return `You are the editor of a personalized Spanish-language mini-book series for one reader (Mitch), who lives in Barcelona and reads full, natural Spanish fluently.

Each issue is a "tomo" — a standalone ~1400-word essay: direct, anchored on a long-running pattern from the reader's own life AND teaching a real domain concept (${DOMAINS.join(", ")}) in genuine depth. The reader's complaint about recent tomos: they elaborated his own life back to him but taught him no new science. Fix that. Every tomo must do BOTH jobs — the life pattern is the anchor, the domain mechanism is the lesson. Concrete hook, one specific example, a real teaching beat. No "En este tomo vamos a..." intros. Every tomo is transformed from the reader's real journal entries and Reviews (his evening/weekly/monthly/therapy syntheses) — never invented biography.

Your job: produce ${count} candidate plan(s) for the next tomo. Each candidate is a fully-formed pitch — your ${count} will be merged with other editors' into a single menu the reader picks from.

Hard rules:
- Exactly ${count} candidate(s).
- Each candidate is a distinct angle. Your candidates must not share a topic OR a domain with each other.
- Each candidate MUST name a "mechanism_to_teach": ONE specific, teachable domain mechanism — not a domain label, not a vague theme. Name it the way the writer will: "predictive coding and interoceptive prediction error", "the default mode network's role in self-referential rumination", "the HPA axis and cortisol's effect on hippocampal consolidation", "Heidegger's Geworfenheit (thrownness)", "polyvagal theory's dorsal-vagal shutdown". "psychology" or "how the mind handles gifts" is NOT acceptable — that is what produced the reader's complaint. The mechanism must be real, established knowledge the writer can teach in depth, and it must genuinely illuminate the life pattern.
- ANTI-REPETITION IS A FIRST-CLASS CONSTRAINT. The user message lists the last 30 tomos AND a "Repetition report" of what the series has been overdoing (title formulas, saturated domains, re-trodden mechanisms). Do NOT retread a listed topic or mechanism. Prefer under-used domains from the allowed list unless the source material genuinely compels otherwise — the series has drifted monothematic and the reader has noticed.
- Titles: Spanish, 3-8 words, evocative not literal. Do NOT use any title formula the Repetition report marks as overused (e.g. "El/La <sustantivo> que <verbo>..."). Vary the syntax: a question, an image, a two-word noun phrase, an imperative — anything that doesn't scan like the last ten spines.
- Pick source UUIDs from the provided pools only. Quote UUIDs exactly as shown in brackets.
- 2-5 source UUIDs per candidate.
- Domain MUST be one of the listed domains.
- Each candidate's "take" is one paragraph (3-5 sentences) explaining: why this angle is worth reading right now given what Mitch has been journaling about, and what the tomo will dramatize or teach.
- Honor any editorial direction in the user message ("Editorial direction" block) when present — it overrides your default judgement on topic/domain mix.
- If a "Series queue" block is present in the user message, it lists active veins the reader wants multiple tomos to draw from. For each active vein, produce at least one candidate that engages it directly, name the vein explicitly in that candidate's "take", AND set that candidate's "series_vein" field to the vein's name. Series-vein candidates are exempt from the anti-repetition constraint (a vein deliberately continues a thread). The remaining candidate slots are free — and stay bound by anti-repetition.

Output STRICT JSON only — no prose, no markdown, no code fences:
{
  "candidates": [
    {
      "id": 1,
      "format": "essay",
      "domain": "psychology",
      "topic": "short phrase describing what this tomo is about",
      "mechanism_to_teach": "ONE specific domain mechanism the tomo will teach in depth — not a domain label",
      "angle": "1-2 sentences: the specific take — what makes this tomo worth reading",
      "title": "título en español",
      "source_refs": ["uuid1", "uuid2"],
      "take": "3-5 sentence paragraph: why these sources, what the tomo teaches or dramatizes, why it matters now. State explicitly how the mechanism_to_teach maps onto the life pattern.",
      "series_vein": "OMIT unless this candidate engages an active series-queue vein; then the vein's name"
    }
    // ... through id ${count}
  ]
}`;
}

// ---------------------------------------------------------------------------
// Repetition report (computed stats injected into the planner prompt)
// ---------------------------------------------------------------------------

const TITLE_FORMULA = /^(El|La|Los|Las) .+ que /;

function buildRepetitionReport(recent: TomoSummary[]): string {
  const lastTen = recent.slice(-10);
  const formulaCount = lastTen.filter((t) => TITLE_FORMULA.test(t.title)).length;

  const domainCounts = new Map<string, number>();
  for (const t of recent.slice(-15)) {
    domainCounts.set(t.domain, (domainCounts.get(t.domain) ?? 0) + 1);
  }
  const saturated = [...domainCounts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1]);
  const unused = DOMAINS.filter((d) => !domainCounts.has(d));

  const lines = ["# Repetition report — what the series has been overdoing"];
  if (formulaCount >= 2) {
    lines.push(
      `- Title formula "El/La <sustantivo> que <verbo>..." used ${formulaCount}× in the last 10 tomos — BANNED for this menu. Use different title syntax.`
    );
  }
  if (saturated.length > 0) {
    lines.push(
      `- Saturated domains (last 15 tomos): ${saturated.map(([d, n]) => `${d} (${n}×)`).join(", ")} — avoid unless the source material compels it.`
    );
  }
  if (unused.length > 0) {
    lines.push(`- Untouched domains worth considering: ${unused.join(", ")}.`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// ---------------------------------------------------------------------------
// Per-leg generation + validation
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 4;

async function generateLeg(
  leg: BookLeg,
  user: string,
  allUuids: Set<string>
): Promise<Candidate[]> {
  const system = buildSystem(CANDIDATES_PER_LEG);
  // A single corrupt/hallucinated source UUID should not throw away the leg's
  // whole generation — retry a bounded number of times before giving up.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = await bookChat({
      provider: leg.provider,
      model: leg.model,
      system,
      messages: [{ role: "user", content: user }],
      // Reasoning legs (GLM 5.2 on Fireworks especially) bill CoT against this
      // cap; at 8192 GLM burned the whole budget reasoning and truncated its
      // JSON on every attempt (2026-07-02 run). 16384 leaves answer headroom.
      maxTokens: 16384,
      label:
        attempt === 1
          ? `planner:${leg.label}`
          : `planner:${leg.label} (retry ${attempt - 1})`,
      progress: true,
    });

    try {
      const parsed = extractJsonObject<{ candidates: Candidate[] }>(text);
      for (const c of parsed.candidates) {
        c.format = "essay";
        c.source_refs = c.source_refs.map((r) =>
          r.replace(/^(entry|review|insight):/, "").trim()
        );
        // Models sometimes echo the schema hint's literal "OMIT" instead of
        // omitting the field — treat that (and empty/non-string) as absent.
        if (
          typeof c.series_vein !== "string" ||
          !c.series_vein.trim() ||
          /^omit\b/i.test(c.series_vein.trim())
        ) {
          delete c.series_vein;
        }
        c.provider = leg.provider;
        c.model = leg.model;
        c.leg = leg.label;
      }
      validateCandidates(parsed.candidates, allUuids, CANDIDATES_PER_LEG, leg.label);
      return parsed.candidates;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `      [planner:${leg.label}] attempt ${attempt} rejected (${errorMessage(err)}); retrying`
        );
      }
    }
  }
  throw new Error(
    `planner leg ${leg.label} failed after ${MAX_ATTEMPTS} attempts: ${errorMessage(lastErr)}`
  );
}

function validateCandidates(
  candidates: Candidate[],
  allUuids: Set<string>,
  expected: number,
  legLabel: string
): void {
  const validDomains: readonly string[] = DOMAINS;
  if (!Array.isArray(candidates) || candidates.length !== expected) {
    throw new Error(
      `Leg ${legLabel} must return exactly ${expected} candidate(s), got ${candidates?.length ?? "none"}`
    );
  }
  for (const c of candidates) {
    if (!validDomains.includes(c.domain)) {
      throw new Error(
        `Leg ${legLabel}: invalid domain "${c.domain}". Must be one of ${DOMAINS.join(", ")}`
      );
    }
    if (c.source_refs.length < 1) {
      throw new Error(`Leg ${legLabel}: a candidate must have at least 1 source UUID`);
    }
    const unknown = c.source_refs.filter((u) => !allUuids.has(u));
    if (unknown.length > 0) {
      throw new Error(
        `Leg ${legLabel}: candidate picked source UUIDs not in the context pool: ${unknown.join(", ")}`
      );
    }
    if (!c.title || !c.topic || !c.angle || !c.take) {
      throw new Error(`Leg ${legLabel}: candidate missing title/topic/angle/take`);
    }
    if (!c.mechanism_to_teach || c.mechanism_to_teach.trim().length === 0) {
      throw new Error(`Leg ${legLabel}: candidate missing mechanism_to_teach`);
    }
    // Reject a mechanism that's just the bare domain label — that's the failure
    // mode the field exists to prevent (a labelled topic with no real science).
    if (validDomains.includes(c.mechanism_to_teach.trim().toLowerCase() as Domain)) {
      throw new Error(
        `Leg ${legLabel}: mechanism_to_teach "${c.mechanism_to_teach}" is just a domain label — name a specific mechanism`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Overlap scoring — cosine vs. the last 30 tomos
// ---------------------------------------------------------------------------

async function scoreOverlap(candidates: Candidate[], recent: TomoSummary[]): Promise<void> {
  if (recent.length === 0 || candidates.length === 0) return;
  const [recentVecs, candVecs] = await Promise.all([
    embedManyTexts(recent.map((r) => `${r.title}. ${r.topic}`)),
    embedManyTexts(candidates.map((c) => `${c.topic}. ${c.mechanism_to_teach}`)),
  ]);
  candidates.forEach((c, i) => {
    let best = -1;
    let bestIdx = -1;
    recentVecs.forEach((rv, j) => {
      const sim = cosineSimilarity(candVecs[i], rv);
      if (sim > best) {
        best = sim;
        bestIdx = j;
      }
    });
    if (bestIdx >= 0) {
      const r = recent[bestIdx];
      c.overlap = { score: Math.round(best * 100) / 100, against: `#${r.n} "${r.title}"` };
    }
  });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/**
 * Print the candidate menu by DOMAIN + SOURCE MATERIAL — the source Reviews/
 * entries each candidate draws from, resolved to title+date. The angle/take
 * "sell" is intentionally dropped: candidates are presented by what they teach
 * (domain + mechanism) and what they're anchored to (source material), so the
 * reader picks on substance rather than on an editor's pitch.
 */
function printCandidates(candidates: Candidate[], byUuid: Map<string, ContextItem>): void {
  const sorted = [...candidates].sort((a, b) => a.id - b.id);
  console.log(`\n${sorted.length} candidate(s):`);
  for (const c of sorted) {
    const byline = c.leg ? ` — ✍ ${c.leg}` : "";
    console.log(`\n  [${c.id}] ${c.domain} — "${c.title}"${byline}`);
    console.log(`      topic: ${c.topic}`);
    console.log(`      teaches: ${c.mechanism_to_teach}`);
    if (c.overlap) {
      const retread = c.overlap.score >= OVERLAP_RETREAD && !c.series_vein;
      const veinNote = c.series_vein ? ` (series vein: ${c.series_vein} — overlap expected)` : "";
      console.log(
        `      overlap: ${c.overlap.score.toFixed(2)} vs ${c.overlap.against}${retread ? " ⚠ RE-TREAD" : ""}${veinNote}`
      );
    }
    console.log(`      source material (${c.source_refs.length}):`);
    for (const u of c.source_refs) {
      const item = byUuid.get(u);
      if (item) {
        console.log(
          `        - [${item.kind}] ${item.date} — ${item.title ?? `journal entry (${item.text.slice(0, 60).replace(/\s+/g, " ")}…)`}`
        );
      } else {
        console.log(`        - ${u} (not in current pool)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(): { steer?: string; freshPlan: boolean } {
  const argv = process.argv;
  const steerIdx = argv.indexOf("--steer");
  return {
    steer: steerIdx >= 0 ? argv[steerIdx + 1] : process.env.STEER,
    freshPlan: argv.includes("--fresh-plan"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.freshPlan) {
    await clearSavedPlan();
    console.log(`[fresh-plan] cleared ${PLAN_PATH}`);
  }

  const liveLegs = await preflightLegs(PLANNER_LEGS);

  console.log("[1/3] reading history");
  const history = await readHistory();
  const n = nextTomoNumber(history);
  const recent = recentTomoSummaries(history, 30);
  console.log(`      tomo #${n}, ${history.length} prior`);

  console.log("[2/3] gathering context (recent 14d + long-arc 365d)");
  const context = await gatherContext(14);
  const recentUuids = new Set(context.map((c) => c.uuid));
  const longArc = await gatherLongArcContext(recentUuids, 365);
  console.log(
    `      recent: ${context.length} items (${context.filter((c) => c.kind === "entry").length} entries, ${context.filter((c) => c.kind === "review").length} reviews)`
  );
  console.log(`      long-arc: ${longArc.length} reviews from last 365d`);
  if (context.length < 3) {
    throw new Error(
      `Only ${context.length} usable context items in the last 14 days. ` +
        `Either journal more or widen the window.`
    );
  }

  const currentState = await deriveCurrentState();
  console.log(
    currentState
      ? `      current-state: derived from recent entries (${currentState.length} chars)`
      : "      current-state: insufficient recent signal — staleness guard relies on verifier only"
  );

  console.log(
    `[3/3] planning ${liveLegs.length * CANDIDATES_PER_LEG} candidates (${liveLegs.length} legs × ${CANDIDATES_PER_LEG})`
  );
  if (args.steer) {
    const preview = args.steer.slice(0, 120);
    console.log(`      steering planner with: ${preview}${args.steer.length > 120 ? "..." : ""}`);
  }
  const seriesQueue = await readSeriesQueue();
  if (seriesQueue.length > 0) {
    const veinCount = seriesQueue.split("\n").filter((l) => /^\s*-\s+/.test(l)).length;
    console.log(`      injecting series queue (${veinCount} active vein${veinCount === 1 ? "" : "s"})`);
  }

  const recentTomosBlock =
    recent.length === 0
      ? "(none yet — this is tomo 1)"
      : recent.map((c) => `#${c.n} [${c.domain}] ${c.title} — ${c.topic}`).join("\n");
  const repetitionReport = buildRepetitionReport(recent);

  const user = [
    "# Recent tomos — do not retread these topics/domains",
    recentTomosBlock,
    "",
    ...(repetitionReport ? [repetitionReport, ""] : []),
    ...formatCurrentStateBlock(currentState),
    ...(args.steer
      ? [
          "# Editorial direction for this tomo (highest priority)",
          "The reader has given a specific redirect. Honor it unless it conflicts with the hard rules.",
          "",
          args.steer,
          "",
        ]
      : []),
    ...(seriesQueue
      ? [
          "# Series queue — active veins (highest priority after editorial direction)",
          "Each bullet below is a vein the reader wants several tomos to draw from. For each active vein, produce at least one candidate that engages it directly, name the vein explicitly in that candidate's `take`, and set its `series_vein` field. The other candidates remain free.",
          "",
          seriesQueue,
          "",
        ]
      : []),
    "# Standing themes — anchor on these",
    "(The reader's Reviews — evening/weekly/monthly/therapy syntheses over the last year. Candidates should anchor on patterns from this block.)",
    "",
    renderContextItems(longArc, SOURCE_PREVIEW_CHARS),
    "",
    "# Recent material — last 14 days (use as fresh substrate)",
    "(Recent journal entries and Reviews. Use these for live texture, voice, and sensory specifics.)",
    "",
    renderContextItems(context, SOURCE_PREVIEW_CHARS),
    "",
    // Per-leg count — each author leg drafts CANDIDATES_PER_LEG of the menu, not
    // the full total. (A mismatch here vs. the system prompt makes a model
    // produce the wrong count — Claude followed a stale "6" and over-produced.)
    `Produce ${CANDIDATES_PER_LEG} candidates. Output JSON only.`,
  ].join("\n");

  const allUuids = new Set<string>([
    ...longArc.map((c) => c.uuid),
    ...context.map((c) => c.uuid),
  ]);

  // Fan out: each live author leg independently drafts its share of the menu.
  // Hard legs that exhaust retries throw and abort the run. Soft legs emit a
  // warning and are dropped — the same tolerance as a preflight failure.
  const settled = await Promise.allSettled(
    liveLegs.map((leg) => generateLeg(leg, user, allUuids))
  );
  const perLeg: Candidate[][] = [];
  for (let i = 0; i < liveLegs.length; i++) {
    const leg = liveLegs[i];
    const result = settled[i];
    if (result.status === "fulfilled") {
      perLeg.push(result.value);
    } else if (leg.soft) {
      console.warn(
        `      [planner:${leg.label}] soft leg failed during planning — skipping (${errorMessage(result.reason)})`
      );
    } else {
      throw result.reason;
    }
  }

  // Merge in leg order and re-id globally so the menu stays grouped by model.
  const candidates = perLeg.flat();
  candidates.forEach((c, i) => {
    c.id = i + 1;
  });
  if (candidates.length === 0) {
    throw new Error("no candidates produced — every leg failed");
  }

  console.log("      scoring overlap vs recent tomos (embeddings)");
  await scoreOverlap(candidates, recent);

  await savePlan(n, candidates);
  console.log(`      saved ${candidates.length} candidate(s) for tomo #${n} to ${PLAN_PATH}`);

  const byUuid = new Map<string, ContextItem>(
    [...longArc, ...context].map((c) => [c.uuid, c])
  );
  console.log("\n--- candidates ---");
  printCandidates(candidates, byUuid);
  console.log(`\nPick with: pnpm write-tomo --pick=<ids,comma,separated>`);
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
