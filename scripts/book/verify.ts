/**
 * Post-draft fact-check pass — the automatic half of the staleness/fabrication
 * guard (the hand-maintained current-state note is the other half).
 *
 * After the writer produces a draft, one Opus call cross-references it against:
 *   - the SOURCE MATERIAL the writer was given (the planner-picked source_refs)
 *   - the last ~21 days of raw journal entries (auto-derived current state)
 *   - the hand-maintained current-state note
 *
 * It flags concrete biographical specifics that are unsupported / contradicted /
 * stale, and domain-mechanism claims that are overclaimed or misattributed.
 * Flags are advisory — they surface at the existing review-before-send gate
 * (console + a `NNNN.verify.md` sidecar); they never block the write.
 *
 * Catches the three failure modes that motivated this pass:
 *   F2 — a fabricated specific (e.g. flowers the sources don't mention).
 *   F2-direction — a real fact with who-did-what-to-whom inverted.
 *   F3 — stale relationship state (e.g. an ended bond written as a live need).
 */
import { config } from "../../src/config.js";
import { bookChat } from "./llm.js";
import type { Candidate } from "./planner.js";
import type { ContextItem } from "./context.js";
import { fetchRecentEntries } from "./context.js";

export type VerifyIssue =
  | "unsupported"
  | "contradicted"
  | "stale"
  | "overclaimed"
  | "misattributed";

export interface VerifyFlag {
  type: "biographical" | "mechanism";
  severity: "high" | "medium" | "low";
  issue: VerifyIssue;
  /** Short verbatim quote from the draft that triggered the flag. */
  quote: string;
  /** What the sources / current state actually say, and why this is a problem. */
  detail: string;
}

export interface VerifyResult {
  flags: VerifyFlag[];
}

const SYSTEM = `You are a fact-checker for a personalized Spanish-language essay ("tomo") written for one reader (Mitch). The essay is anchored to real events from his life and teaches a domain concept. Your ONE job: catch specifics the essay gets WRONG, before he reads it.

You are given the finished draft plus three reference blocks: SOURCE MATERIAL (what the writer was told to draw from), RECENT JOURNAL (the last few weeks of raw entries — broader ground truth), and CURRENT STATE (a snapshot of who is current vs. past, derived from the recent entries).

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
- Prefer precision over volume. A short list of real problems beats a long list of nitpicks. An empty list is the correct and expected output for a clean draft.
- "quote" must be a SHORT verbatim span copied from the draft (Spanish is fine).
- Direction errors and stale-state errors are the highest-value catches — weight them "high".

Output STRICT JSON only — no prose, no markdown, no code fences:
{
  "flags": [
    { "type": "biographical", "severity": "high", "issue": "contradicted", "quote": "...", "detail": "The draft says X gave Y flowers, but the source insight says Mitch gave them to Miguel — direction inverted." }
  ]
}
If the draft is clean, return: { "flags": [] }`;

const SOURCE_CHARS = 2000;
const ENTRY_CHARS = 1500;
const VALID_ISSUES: VerifyIssue[] = [
  "unsupported",
  "contradicted",
  "stale",
  "overclaimed",
  "misattributed",
];

/**
 * Cross-reference a draft against its sources + recent journal + current state.
 * Returns flags (possibly empty). Never throws on a model hiccup — returns a
 * single low-severity "verifier-failed" flag so the caller surfaces it rather
 * than silently shipping unverified.
 */
export async function verifyTomo(
  plan: Candidate,
  markdown: string,
  sources: ContextItem[],
  currentStateBlock: string
): Promise<VerifyResult> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the verifier");
  }

  const recentEntries = await fetchRecentEntries(21);

  const sourcesBlock =
    sources.length === 0
      ? "(none)"
      : sources
          .map((c) => {
            const head = `[${c.kind}:${c.uuid}] ${c.date}${c.title ? " — " + c.title : ""}`;
            return `${head}\n${c.text.slice(0, SOURCE_CHARS)}`;
          })
          .join("\n\n---\n\n");

  const recentBlock =
    recentEntries.length === 0
      ? "(none)"
      : recentEntries
          .map((e) => `[${e.date}]\n${e.text.slice(0, ENTRY_CHARS)}`)
          .join("\n\n---\n\n");

  const user = [
    "# DRAFT (the tomo to check)",
    markdown,
    "",
    "# SOURCE MATERIAL (what the writer was told to draw from)",
    sourcesBlock,
    "",
    "# RECENT JOURNAL (last 21 days of raw entries — broader ground truth)",
    recentBlock,
    "",
    "# CURRENT STATE (authoritative — who is current vs. past)",
    currentStateBlock.trim() || "(none provided)",
    "",
    `The tomo's stated mechanism_to_teach is: ${plan.mechanism_to_teach}`,
    "",
    "Return the JSON flags object now.",
  ].join("\n");

  const text = await bookChat({
    model: config.models.bookWriter,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
    maxTokens: 2048,
    temperature: 0,
    label: "verify",
  });

  return parseVerifyOutput(text);
}

export function parseVerifyOutput(text: string): VerifyResult {
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
    const severity =
      o.severity === "high" || o.severity === "low" ? o.severity : "medium";
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

const SEVERITY_RANK: Record<VerifyFlag["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Render flags as a markdown sidecar / console block for the review gate. */
export function formatVerifyReport(n: number, result: VerifyResult): string {
  const padded = String(n).padStart(4, "0");
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
