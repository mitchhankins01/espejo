import { config } from "../../src/config.js";
import type { LlmProvider } from "../../src/llm/index.js";
import { bookChat } from "./llm.js";
import { PLANNER_LEGS, CANDIDATES_PER_LEG, type BookLeg } from "./models.js";
import type { ContextItem } from "./context.js";
import type { TomoSummary } from "./state.js";

export const DOMAINS = [
  "neuroscience",
  "cognition",
  "cognitive science",
  "psychology",
  "philosophy",
  "hermeticism",
  "physics",
  "psychedelics",
  "ai",
] as const;

export type Domain = (typeof DOMAINS)[number];

const VALID_DOMAINS: Domain[] = [...DOMAINS];

// Single format since the "flow" format was retired — every tomo is an anchored
// essay. Kept as a field for downstream history/epub compatibility.
export type TomoFormat = "essay";

// The planner runs as a multi-leg fan-out (DeepSeek / Claude / GPT / GLM), each
// leg producing `count` candidates of the menu so the reader can compare models.
// The prompt is therefore parametrized on the per-leg count, not the menu total.
function buildSystem(count: number): string {
  return `You are the editor of a personalized Spanish-language mini-book series for one reader (Mitch), who lives in Barcelona and reads full, natural Spanish fluently.

Each issue is a "tomo" — a standalone ~1400-word essay: direct, anchored on a long-running pattern from the reader's own life AND teaching a real domain concept (${DOMAINS.join(", ")}) in genuine depth. The reader's complaint about recent tomos: they elaborated his own life back to him but taught him no new science. Fix that. Every tomo must do BOTH jobs — the life pattern is the anchor, the domain mechanism is the lesson. Concrete hook, one specific example, a real teaching beat. No "En este tomo vamos a..." intros. Every tomo is transformed from the reader's real journal entries and approved insights — never invented biography.

Your job: produce ${count} candidate plan(s) for the next tomo. Each candidate is a fully-formed pitch — your ${count} will be merged with other editors' into a single menu the reader picks from.

Hard rules:
- Exactly ${count} candidate(s).
- Each candidate is a distinct angle. No two of your candidates may share the same topic.
- Each candidate MUST name a "mechanism_to_teach": ONE specific, teachable domain mechanism — not a domain label, not a vague theme. Name it the way the writer will: "predictive coding and interoceptive prediction error", "the default mode network's role in self-referential rumination", "the HPA axis and cortisol's effect on hippocampal consolidation", "Heidegger's Geworfenheit (thrownness)", "polyvagal theory's dorsal-vagal shutdown". "psychology" or "how the mind handles gifts" is NOT acceptable — that is what produced the reader's complaint. The mechanism must be real, established knowledge the writer can teach in depth, and it must genuinely illuminate the life pattern.
- Do NOT retread topics or domains covered in the last 30 tomos shown below. Variety matters.
- Pick source UUIDs from the provided pools only. Quote UUIDs exactly as shown in brackets.
- 2-5 source UUIDs per candidate.
- Title: Spanish, 3-8 words, evocative not literal.
- Domain MUST be one of the listed domains.
- Each candidate's "take" is one paragraph (3-5 sentences) explaining: why this angle is worth reading right now given what Mitch has been journaling about, and what the tomo will dramatize or teach.
- Honor any editorial direction in the user message ("Editorial direction" block) when present — it overrides your default judgement on topic/domain mix.
- If a "Series queue" block is present in the user message, it lists active veins the reader wants multiple tomos to draw from. For each active vein, produce at least one candidate that engages it directly, and name the vein explicitly in that candidate's "take". The remaining candidate slots are free.

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
      "take": "3-5 sentence paragraph: why these sources, what the tomo teaches or dramatizes, why it matters now. State explicitly how the mechanism_to_teach maps onto the life pattern."
    }
    // ... through id ${count}
  ]
}`;
}

export interface Candidate {
  id: number;
  format: TomoFormat;
  domain: Domain;
  topic: string;
  /** ONE specific domain mechanism the tomo teaches in depth (not a domain label). */
  mechanism_to_teach: string;
  angle: string;
  title: string;
  source_refs: string[];
  take: string;
  /** Author leg that produced (and will write) this candidate. */
  provider?: LlmProvider;
  model?: string;
  /** Human label for the author leg, e.g. "DeepSeek" — shown on the menu + first page. */
  leg?: string;
}

export interface PlannerOutput {
  candidates: Candidate[];
}

const SOURCE_PREVIEW_CHARS = 700;

export async function plan(
  recentTomos: TomoSummary[],
  longArc: ContextItem[],
  recent: ContextItem[],
  steer?: string,
  seriesQueueBlock?: string,
  currentStateBlock?: string,
  legs: BookLeg[] = PLANNER_LEGS
): Promise<PlannerOutput> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the planner");
  }

  const formatItem = (c: ContextItem): string => {
    const head = `[${c.kind}:${c.uuid}] ${c.date}${c.title ? " — " + c.title : ""}`;
    const body = c.text.slice(0, SOURCE_PREVIEW_CHARS);
    return `${head}\n${body}`;
  };

  const longArcBlock =
    longArc.length === 0
      ? "(none yet)"
      : longArc.map(formatItem).join("\n\n---\n\n");

  const recentBlock =
    recent.length === 0
      ? "(none)"
      : recent.map(formatItem).join("\n\n---\n\n");

  const recentTomosBlock =
    recentTomos.length === 0
      ? "(none yet — this is tomo 1)"
      : recentTomos
          .map((c) => `#${c.n} [${c.domain}] ${c.title} — ${c.topic}`)
          .join("\n");

  const steerBlock = steer
    ? [
        "# Editorial direction for this tomo (highest priority)",
        "The reader has given a specific redirect. Honor it unless it conflicts with the hard rules.",
        "",
        steer,
        "",
      ]
    : [];

  const queueBlock =
    seriesQueueBlock && seriesQueueBlock.length > 0
      ? [seriesQueueBlock, ""]
      : [];

  const stateBlock =
    currentStateBlock && currentStateBlock.trim().length > 0
      ? [
          "# Current state — ground truth (derived from the reader's most recent journal entries; overrides stale framing below)",
          "Who is current vs. past, and the live status of each thread, distilled from the reader's latest entries. The standing themes and source insights below are snapshots from when they were written and may describe relationships or situations that have since changed. Because this block is built from newer data, it wins when the material conflicts with it.",
          "",
          currentStateBlock.trim(),
          "",
        ]
      : [];

  const user = [
    "# Recent tomos — do not retread these topics/domains",
    recentTomosBlock,
    "",
    ...stateBlock,
    ...steerBlock,
    ...queueBlock,
    "# Standing themes — anchor on these",
    "(Older approved insights, distilled over months. Candidates should anchor on patterns from this block.)",
    "",
    longArcBlock,
    "",
    "# Recent material — last 14 days (use as fresh substrate)",
    "(Recent journal entries and approved insights. Use these for live texture, voice, and sensory specifics.)",
    "",
    recentBlock,
    "",
    // Per-leg count — each author leg drafts CANDIDATES_PER_LEG of the menu, not
    // the full total. (A mismatch here vs. the system prompt makes a model
    // produce the wrong count — Claude followed a stale "6" and over-produced.)
    `Produce ${CANDIDATES_PER_LEG} candidates. Output JSON only.`,
  ].join("\n");

  const allUuids = new Set<string>([
    ...longArc.map((c) => c.uuid),
    ...recent.map((c) => c.uuid),
  ]);

  // Fan out: each author leg (DeepSeek / Claude / GPT) independently drafts its
  // share of the menu so the reader can compare models. Legs run in parallel;
  // per the "abort if any leg is down" policy the run is gated by an all-legs
  // preflight upstream, so a leg that still fails here (after its bounded
  // JSON-repair retries) throws and aborts rather than silently shrinking the menu.
  const perLeg = await Promise.all(
    legs.map((leg) => generateLeg(leg, user, allUuids))
  );

  // Merge in leg order (DeepSeek first, then Claude, then GPT) and re-id globally
  // so the menu stays grouped by model.
  const candidates = perLeg.flat();
  candidates.forEach((c, i) => {
    c.id = i + 1;
  });
  return { candidates };
}

/** Generate one leg's share of the menu, tagging each candidate with its author. */
async function generateLeg(
  leg: BookLeg,
  user: string,
  allUuids: Set<string>
): Promise<Candidate[]> {
  const system = buildSystem(CANDIDATES_PER_LEG);
  // A single corrupt/hallucinated source UUID should not throw away the leg's
  // whole generation — retry a bounded number of times before giving up.
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = await bookChat({
      provider: leg.provider,
      model: leg.model,
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 8192,
      label:
        attempt === 1
          ? `planner:${leg.label}`
          : `planner:${leg.label} (retry ${attempt - 1})`,
      progress: true,
    });

    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error("Planner returned no JSON object. Raw output:\n" + text);
      }
      const parsed = JSON.parse(match[0]) as PlannerOutput;
      for (const c of parsed.candidates) {
        c.format = "essay";
        c.source_refs = c.source_refs.map(normalizeUuid);
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
          `      [planner:${leg.label}] attempt ${attempt} rejected (${(err as Error).message.split("\n")[0]}); retrying`
        );
      }
    }
  }
  throw new Error(
    `planner leg ${leg.label} failed after ${MAX_ATTEMPTS} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`
  );
}

function normalizeUuid(ref: string): string {
  return ref.replace(/^(entry|insight):/, "").trim();
}

function validateCandidates(
  candidates: Candidate[],
  allUuids: Set<string>,
  expected: number,
  legLabel: string
): void {
  if (!Array.isArray(candidates) || candidates.length !== expected) {
    throw new Error(
      `Leg ${legLabel} must return exactly ${expected} candidate(s), got ${candidates?.length ?? "none"}`
    );
  }
  for (const c of candidates) {
    if (!VALID_DOMAINS.includes(c.domain)) {
      throw new Error(
        `Leg ${legLabel}: invalid domain "${c.domain}". Must be one of ${VALID_DOMAINS.join(", ")}`
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
    if (
      VALID_DOMAINS.includes(c.mechanism_to_teach.trim().toLowerCase() as Domain)
    ) {
      throw new Error(
        `Leg ${legLabel}: mechanism_to_teach "${c.mechanism_to_teach}" is just a domain label — name a specific mechanism`
      );
    }
  }
}
