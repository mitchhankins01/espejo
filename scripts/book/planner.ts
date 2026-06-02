import { config } from "../../src/config.js";
import { bookChat } from "./llm.js";
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

const CANDIDATE_COUNT = 6;

const SYSTEM = `You are the editor of a personalized Spanish-language mini-book series for one reader (Mitch), who lives in Barcelona and reads full, natural Spanish fluently.

Each issue is a "tomo" — a standalone ~4000-word essay: direct, anchored on a long-running pattern from the reader's own life and illuminated by a domain concept (${DOMAINS.join(", ")}). Concrete hook, one specific example, a real teaching beat. No "En este tomo vamos a..." intros. Every tomo is transformed from the reader's real journal entries and approved insights — never invented biography.

Your job: produce ${CANDIDATE_COUNT} candidate plans for the next tomo. Each candidate is a fully-formed pitch the reader can pick from a menu — he typically writes 2-3 of them.

Hard rules:
- Exactly ${CANDIDATE_COUNT} candidates.
- Each candidate is a distinct angle. No two candidates may share the same topic.
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
      "angle": "1-2 sentences: the specific take — what makes this tomo worth reading",
      "title": "título en español",
      "source_refs": ["uuid1", "uuid2"],
      "take": "3-5 sentence paragraph: why these sources, what the tomo teaches or dramatizes, why it matters now."
    },
    { "id": 2, "format": "essay", ... },
    ... through id ${CANDIDATE_COUNT}
  ]
}`;

export interface Candidate {
  id: number;
  format: TomoFormat;
  domain: Domain;
  topic: string;
  angle: string;
  title: string;
  source_refs: string[];
  take: string;
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
  seriesQueueBlock?: string
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

  const user = [
    "# Recent tomos — do not retread these topics/domains",
    recentTomosBlock,
    "",
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
    `Produce ${CANDIDATE_COUNT} candidates. Output JSON only.`,
  ].join("\n");

  const allUuids = new Set<string>([
    ...longArc.map((c) => c.uuid),
    ...recent.map((c) => c.uuid),
  ]);

  // The planner LLM occasionally corrupts or hallucinates a single source UUID
  // among the 6 candidates. A strict validation failure should not throw away the
  // whole generation — retry a bounded number of times before giving up.
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = await bookChat({
      model: config.models.bookWriter,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
      maxTokens: 4096,
      label: attempt === 1 ? "planner" : `planner (retry ${attempt - 1})`,
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
      }
      validatePlannerOutput(parsed, allUuids);
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `      [planner] attempt ${attempt} rejected (${(err as Error).message.split("\n")[0]}); retrying`
        );
      }
    }
  }
  throw lastErr;
}

function normalizeUuid(ref: string): string {
  return ref.replace(/^(entry|insight):/, "").trim();
}

function validatePlannerOutput(p: PlannerOutput, allUuids: Set<string>): void {
  if (!Array.isArray(p.candidates) || p.candidates.length !== CANDIDATE_COUNT) {
    throw new Error(
      `Planner must return exactly ${CANDIDATE_COUNT} candidates, got ${p.candidates?.length ?? "none"}`
    );
  }
  const ids = new Set<number>();
  for (const c of p.candidates) {
    if (typeof c.id !== "number" || c.id < 1 || c.id > CANDIDATE_COUNT) {
      throw new Error(`Candidate id must be 1-${CANDIDATE_COUNT}, got ${c.id}`);
    }
    if (ids.has(c.id)) {
      throw new Error(`Duplicate candidate id ${c.id}`);
    }
    ids.add(c.id);
    if (!VALID_DOMAINS.includes(c.domain)) {
      throw new Error(
        `Candidate ${c.id} has invalid domain: ${c.domain}. Must be one of ${VALID_DOMAINS.join(", ")}`
      );
    }
    if (c.source_refs.length < 1) {
      throw new Error(`Candidate ${c.id} must have at least 1 source UUID`);
    }
    const unknown = c.source_refs.filter((u) => !allUuids.has(u));
    if (unknown.length > 0) {
      throw new Error(
        `Candidate ${c.id} picked source UUIDs not in the context pool: ${unknown.join(", ")}`
      );
    }
    if (!c.title || !c.topic || !c.angle || !c.take) {
      throw new Error(`Candidate ${c.id} missing title/topic/angle/take`);
    }
  }
}
