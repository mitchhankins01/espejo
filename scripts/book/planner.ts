import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { ContextItem } from "./context.js";
import type { TomoSummary } from "./state.js";
import type { MythEntry } from "./myths.js";
import { formatMythCorpusForPlanner, findMyth } from "./myths.js";

const SYSTEM = `You are the editor of a personalized Spanish-language mini-book series for one reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

Each issue is a "tomo" — a standalone ~2000-word piece. Each tomo is one of two formats:

- "essay" (non-fiction) — direct second-person, anchored on a long-running pattern illuminated by a domain concept (neuroscience, cognition, psychology, philosophy, hermeticism, physics, psychedelics, ai).
- "myth" — a Greek (or other) mythological story retold in literary third-person past, paired with an explicit bridge section ("El espejo") naming how the myth maps to recent lived material.

Your job, in order:

1. Score the mythology corpus below against this week's context (long-arc insights + recent material). For each myth, judge fit on: motif resonance, shape match with the current arc, freshness (myths in the recent_myth_names exclusion list MUST score 0 with reason "recently fired"). Pick the top 3 with concrete one-line reasoning.
2. Decide format:
   - If the top myth has GENUINELY strong fit — the kind where the bridge section would write itself — pick format="myth" with that myth_name.
   - Otherwise pick format="essay".
   - "Strong fit" means the myth's shape illuminates the week's actual texture, not just shares a vague keyword. Sísifo is right for "tried again and again and fell back." It's wrong for "had a frustrating Tuesday."
   - If editorial direction includes "format=myth" or "myth-mode forced", pick format="myth" with the strongest-scoring myth (still output myth_top3 honestly).
   - If editorial direction includes "format=essay" or "no-myth", pick format="essay" regardless of corpus fit.
3. Pick topic, angle, sources as before. For myth-mode, sources feed the bridge section (~500 words of personal material), so 2-4 source UUIDs are enough. For essay-mode, 2-5 source UUIDs.
4. For myth-mode, additionally produce bridge_thesis: ONE sentence stating what the bridge will assert about the connection between the myth and the recent material. This is what the user reviews in Phase 1 — make it specific, not generic.

Hard rules:
- Pick ONE focused topic.
- The intersection between life pattern and domain (or myth shape) must be real — illuminate, don't decorate.
- Do NOT retread topics or domains covered in the last 30 tomos. Variety matters.
- Pick source UUIDs from the provided pools only. Quote UUIDs exactly as shown in brackets.
- Title: Spanish, 3-8 words, evocative not literal.
- Don't pick a topic that needs >B1 technical Spanish to be accurate — simplify the angle or pick a different topic.
- For myth-mode: domain MUST be "mythology"; myth_name MUST be in the corpus; bridge_thesis MUST be present.
- For essay-mode: myth_name and bridge_thesis MUST be null.
- ALWAYS output myth_top3 (even when picking essay) so the user can see the rejected alternatives.

Output STRICT JSON only — no prose, no markdown, no code fences:
{
  "format": "essay" | "myth",
  "domain": "neuroscience" | "cognition" | "psychology" | "philosophy" | "hermeticism" | "physics" | "psychedelics" | "ai" | "mythology",
  "myth_name": "Sísifo" | null,
  "bridge_thesis": "..." | null,
  "topic": "short phrase describing what this tomo is about",
  "angle": "1-2 sentences: the specific take — what makes this tomo worth reading",
  "title": "título en español",
  "source_refs": ["uuid1", "uuid2", ...],
  "myth_top3": [
    {"name": "Sísifo", "score": 9.2, "reason": "racha rota in source 3afb...; descent register matches the relief Mitch named on 4-29"},
    {"name": "Ícaro", "score": 6.4, "reason": "..."},
    {"name": "Narciso", "score": 4.1, "reason": "..."}
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
  | "mythology";

const VALID_DOMAINS: Domain[] = [
  "neuroscience",
  "cognition",
  "psychology",
  "philosophy",
  "hermeticism",
  "physics",
  "psychedelics",
  "ai",
  "mythology",
];

export type TomoFormat = "essay" | "myth";

export interface MythScore {
  name: string;
  score: number;
  reason: string;
}

export interface Plan {
  format: TomoFormat;
  domain: Domain;
  myth_name: string | null;
  bridge_thesis: string | null;
  topic: string;
  angle: string;
  title: string;
  source_refs: string[];
  myth_top3: MythScore[];
}

const SOURCE_PREVIEW_CHARS = 700;

export async function plan(
  style: string,
  recentTomos: TomoSummary[],
  longArc: ContextItem[],
  recent: ContextItem[],
  myths: MythEntry[],
  recentMyths: Set<string>,
  steer?: string
): Promise<Plan> {
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
          .map((c) => {
            const mythTag = c.myth_name ? ` [myth: ${c.myth_name}]` : "";
            return `#${c.n} [${c.format}/${c.domain}] ${c.title} — ${c.topic}${mythTag}`;
          })
          .join("\n");

  const corpusBlock =
    myths.length === 0
      ? "(corpus is empty — myth-format unavailable; pick format=essay)"
      : formatMythCorpusForPlanner(myths);

  const excludedBlock =
    recentMyths.size === 0 ? "(none)" : Array.from(recentMyths).join(", ");

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
    "# Mythology corpus",
    corpusBlock,
    "",
    "# recent_myth_names (myths fired in the last 8 tomos — score 0 for these)",
    excludedBlock,
    "",
    "# Standing themes — anchor on these",
    "(Older approved insights, distilled over months. The chosen tomo should anchor on a pattern from this block.)",
    "",
    longArcBlock,
    "",
    "# Recent material — last 14 days (use as fresh substrate)",
    "(Recent journal entries and approved insights. Use these for live texture, voice, and sensory specifics.)",
    "",
    recentBlock,
    "",
    "Pick the next tomo. Output JSON only.",
  ].join("\n");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
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

  const parsed = JSON.parse(match[0]) as Plan;
  parsed.source_refs = parsed.source_refs.map(normalizeUuid);
  const allUuids = new Set<string>([
    ...longArc.map((c) => c.uuid),
    ...recent.map((c) => c.uuid),
  ]);
  validatePlan(parsed, allUuids, myths);
  return parsed;
}

function normalizeUuid(ref: string): string {
  return ref.replace(/^(entry|insight):/, "").trim();
}

function validatePlan(p: Plan, allUuids: Set<string>, myths: MythEntry[]): void {
  const unknown = p.source_refs.filter((u) => !allUuids.has(u));
  if (unknown.length > 0) {
    throw new Error(
      `Planner picked source UUIDs not in the context pool: ${unknown.join(", ")}`
    );
  }
  if (p.source_refs.length < 1) {
    throw new Error("Planner must pick at least 1 source UUID");
  }
  if (!VALID_DOMAINS.includes(p.domain)) {
    throw new Error(
      `Planner returned invalid domain: ${p.domain}. Must be one of ${VALID_DOMAINS.join(", ")}`
    );
  }
  if (p.format !== "essay" && p.format !== "myth") {
    throw new Error(`Planner returned invalid format: ${p.format}`);
  }
  if (p.format === "myth") {
    if (!p.myth_name) {
      throw new Error("Planner format=myth requires myth_name");
    }
    if (!findMyth(myths, p.myth_name)) {
      throw new Error(
        `Planner picked myth "${p.myth_name}" not in corpus. Corpus names: ${myths.map((m) => m.name).join(", ")}`
      );
    }
    if (!p.bridge_thesis || p.bridge_thesis.length === 0) {
      throw new Error("Planner format=myth requires bridge_thesis");
    }
    if (p.domain !== "mythology") {
      throw new Error(`Planner format=myth requires domain="mythology", got ${p.domain}`);
    }
  } else {
    if (p.myth_name !== null) {
      throw new Error("Planner format=essay must have myth_name=null");
    }
    if (p.bridge_thesis !== null) {
      throw new Error("Planner format=essay must have bridge_thesis=null");
    }
    if (p.domain === "mythology") {
      throw new Error("Planner format=essay cannot use domain=mythology");
    }
  }
  if (!Array.isArray(p.myth_top3)) {
    throw new Error("Planner must output myth_top3 array");
  }
}
