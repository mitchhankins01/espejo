import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { ContextItem } from "./context.js";
import type { TomoSummary } from "./state.js";

const SYSTEM = `You are the editor of a personalized Spanish-language mini-book series for one reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

Each issue is a "tomo" — a standalone ~2000-word piece. There are two formats:

- "essay" — direct second-person, anchored on a long-running pattern illuminated by a domain concept (neuroscience, cognition, psychology, philosophy, hermeticism, physics, psychedelics, ai). Concrete hook, one specific example, a real teaching beat. No "En este tomo vamos a..." intros.
- "flow" — wider creative latitude. Can be a narrative scene, a prose poem, a stream-of-consciousness reflection, a fragment-collage, a dialogue, or a hybrid. Still anchored on real recent material from the reader's life — transformed, never quoted. The shape is the writer's call; the only invariants are A2/B1 register, ~2000 words of body, and a final "## Para llevarte" with 5-8 bullets.

Your job: produce SIX candidate plans for the next tomo — three "essay" candidates and three "flow" candidates. Each candidate is a fully-formed pitch the reader can pick from a menu.

Hard rules:
- Exactly 6 candidates: ids 1-3 are essay, ids 4-6 are flow.
- Each candidate is a distinct angle. No two candidates may share the same topic, even across formats.
- Do NOT retread topics or domains covered in the last 30 tomos shown below. Variety matters.
- Pick source UUIDs from the provided pools only. Quote UUIDs exactly as shown in brackets.
- 2-5 source UUIDs per candidate.
- Title: Spanish, 3-8 words, evocative not literal.
- B1-friendly — don't pick a topic that would force >B1 technical Spanish.
- For essay: domain MUST be one of the listed domains.
- For flow: domain MAY be one of the listed domains OR "none". The flow latitude is in the form, not the subject — pick a domain when there is one, "none" only when the piece is purely interior with no domain anchor.
- Each candidate's "take" is one paragraph (3-5 sentences) explaining: why this angle is worth reading right now given what Mitch has been journaling about, and what the tomo will dramatize or teach.
- Honor any editorial direction in the user message ("Editorial direction" block) when present — it overrides your default judgement on topic/domain/format mix.

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
    { "id": 3, "format": "essay", ... },
    { "id": 4, "format": "flow", ... },
    { "id": 5, "format": "flow", ... },
    { "id": 6, "format": "flow", ... }
  ]
}`;

export type Domain =
  | "neuroscience"
  | "cognition"
  | "psychology"
  | "philosophy"
  | "hermeticism"
  | "physics"
  | "psychedelics"
  | "ai"
  | "none";

const VALID_DOMAINS: Domain[] = [
  "neuroscience",
  "cognition",
  "psychology",
  "philosophy",
  "hermeticism",
  "physics",
  "psychedelics",
  "ai",
  "none",
];

export type TomoFormat = "essay" | "flow";

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
  style: string,
  recentTomos: TomoSummary[],
  longArc: ContextItem[],
  recent: ContextItem[],
  steer?: string
): Promise<PlannerOutput> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the planner");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

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
          .map(
            (c) => `#${c.n} [${c.format}/${c.domain}] ${c.title} — ${c.topic}`
          )
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

  const user = [
    "# Style guide",
    style,
    "",
    "# Recent tomos — do not retread these topics/domains",
    recentTomosBlock,
    "",
    ...steerBlock,
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
    "Produce 6 candidates (3 essay, 3 flow). Output JSON only.",
  ].join("\n");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Planner returned no text block");
  }

  const match = textBlock.text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(
      "Planner returned no JSON object. Raw output:\n" + textBlock.text
    );
  }

  const parsed = JSON.parse(match[0]) as PlannerOutput;
  for (const c of parsed.candidates) {
    c.source_refs = c.source_refs.map(normalizeUuid);
  }
  const allUuids = new Set<string>([
    ...longArc.map((c) => c.uuid),
    ...recent.map((c) => c.uuid),
  ]);
  validatePlannerOutput(parsed, allUuids);
  return parsed;
}

function normalizeUuid(ref: string): string {
  return ref.replace(/^(entry|insight):/, "").trim();
}

function validatePlannerOutput(p: PlannerOutput, allUuids: Set<string>): void {
  if (!Array.isArray(p.candidates) || p.candidates.length !== 6) {
    throw new Error(
      `Planner must return exactly 6 candidates, got ${p.candidates?.length ?? "none"}`
    );
  }
  const ids = new Set<number>();
  let essayCount = 0;
  let flowCount = 0;
  for (const c of p.candidates) {
    if (typeof c.id !== "number" || c.id < 1 || c.id > 6) {
      throw new Error(`Candidate id must be 1-6, got ${c.id}`);
    }
    if (ids.has(c.id)) {
      throw new Error(`Duplicate candidate id ${c.id}`);
    }
    ids.add(c.id);
    if (c.format !== "essay" && c.format !== "flow") {
      throw new Error(`Candidate ${c.id} has invalid format: ${c.format}`);
    }
    if (c.format === "essay") essayCount++;
    else flowCount++;
    if (!VALID_DOMAINS.includes(c.domain)) {
      throw new Error(
        `Candidate ${c.id} has invalid domain: ${c.domain}. Must be one of ${VALID_DOMAINS.join(", ")}`
      );
    }
    if (c.format === "essay" && c.domain === "none") {
      throw new Error(
        `Candidate ${c.id}: essay format requires a real domain (not "none")`
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
  if (essayCount !== 3 || flowCount !== 3) {
    throw new Error(
      `Planner must return 3 essay + 3 flow candidates, got ${essayCount} essay + ${flowCount} flow`
    );
  }
}
