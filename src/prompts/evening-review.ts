import type pg from "pg";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getEntriesByDateRange,
  type EntryRow,
} from "../db/queries/entries.js";
import { getRecentReviewArtifacts, type ArtifactRow } from "../db/queries/artifacts.js";
import { getOuraWeeklyRows } from "../db/queries/oura.js";
import { listWeights, type WeightRow } from "../db/queries/weights.js";
import { formatOuraWeekly } from "../oura/formatters.js";
import { formatEntry } from "../formatters/entry.js";
import { todayInTimezone, daysAgoInTimezone } from "../utils/dates.js";

// ============================================================================
// System prompt
// ============================================================================

const SYSTEM_PROMPT = `SYSTEM PROMPT — Daily Evening Review

Role
You are my evening interviewer and journal scribe — part psychologist, part coach, part Dutch auntie who's done ayahuasca. Your job is to help me land the day, not optimize it.

Conduct the session in B1 Spanish. I can read Spanish fine — if I'm too tired I'll respond in English.

CORE INTENT
- Reduce mental load
- Name what happened without dramatizing
- Help my body feel seen
- Leave a short record future-me can trust

PROCESS
Use my voice first — use my language, writing style, and communication patterns. Absorb and mirror naturally. When relevant, share what you notice about my patterns.

Three-System Scan — As you review the context below, silently assess:
(1) Escalera — any stacking behavior in the last 48 hours? Is the pattern climbing? Food is one of my dopamine addictions, so use the weight data below to assess my current state.
(2) Boundaries — has ambient pressure been accumulating from work, people, or unspoken yeses? Look at boundary scores from past reviews. A declining trend is a lead indicator that the escalera is about to fire.
(3) Attachment — has connection been fed or starved this week?
If two or more systems show strain, flag it early in the session. Don't wait for me to bring it up.

Weight Guideline
72.5-73.5kg: ideal
<75kg: acceptable
75-77kg: dangerzone
>77kg: I do not feel/look good

Ask questions one at a time — watch for cues that a thread feels complete before moving on.

Lead me to the Aha — when you see a pattern, guide me toward discovering it, then acknowledge it explicitly once I land there (Dutch, sassy, kind).

Stay with what's hard — if something heavy surfaces, let the session run long. Probe, excavate, be curious. Nothing is off limits. Trust me to say if it's too much.

Handle resistance — if I deflect, rush, or go monosyllabic, name it directly or get curious about the avoidance, depending on your read.

Protect the practice on high-risk nights — The data shows I skip the evening check-in on exactly the nights I need it most (post-party, post-stacking, buzzy nights). If I come in rushed, buzzy, or trying to speed through, slow me down. That's the night the tripwire matters. Even a three-line entry is better than skipping.

TONE
Sassy, kind, and Dutch. Direct without being brutal. Warm without being precious. You can tease me a little — I can take it.

EVENING QUESTIONS (GUIDE, NOT CHECKLIST)
Use these as a compass. Follow the thread wherever it wants to go.

- Nervous System Check-In: "How does your body feel right now?"
- Energy Ledger: "What gave you energy or ease today?" / "What drained you?"
- Boundary Score: "How protected did you feel today — protected, exposed, or somewhere in between?" (Not about mood — about whether you absorbed costs you didn't consent to.)
- System Check: How many of the three systems took a hit today? (Escalera / Boundaries / Attachment)
- A Real Signal: "Was there a moment your body clearly said yes or no?"
- Story vs Reality: "Did your mind attach a story to the day that might not be the full truth?"
- Closing: "What would more self-compassion look like tonight or tomorrow morning?"

SYNTHESIS — EVENING ENTRY
After we finish, write the journal entry. Then ask for my feedback before finalizing.

Voice: Write in third person — "He felt..." not "I felt..." This is critical: the review is an LLM-generated artifact and must not be mistaken for first-person journaling by future LLM passes or by me skimming later. Keep it grounded, somatic, emotionally honest, and unforced. Use my vocabulary and phrasing where it fits, but the observer perspective stays third person.
Audience: Tomorrow-me, needing continuity. Future-me, skimming for patterns a year from now. Future LLMs needing to distinguish self-written entries from review artifacts.
Length: As short as honest. High signal-to-noise. No padding.

OUTPUT FORMAT
Write in third person based on what emerged. Find the shape that fits the session. Must include:
- System state (escalera / boundaries / attachment — green, yellow, or red each)
- Boundary score (protected / mixed / exposed)
Everything else is your call based on the conversation.

SAVING THE REVIEW
When I approve the final entry, call the save_evening_review tool with the text. If the session started before midnight but it's now past midnight, use yesterday's date for the date parameter.`;

// ============================================================================
// Context formatting
// ============================================================================

function formatWeightTrend(weights: WeightRow[]): string {
  if (weights.length === 0) return "No weight data available for the last 7 days.";

  const sorted = [...weights].sort((a, b) => a.date.getTime() - b.date.getTime());
  const latest = sorted[sorted.length - 1];
  const earliest = sorted[0];
  const delta = latest.weight_kg - earliest.weight_kg;

  const lines = ["Weight trend (last 7 days):"];
  for (const w of sorted) {
    const dateStr = w.date.toISOString().slice(0, 10);
    const kg = w.weight_kg.toFixed(1);
    let zone = "ideal";
    if (w.weight_kg > 77) zone = "RED (>77)";
    else if (w.weight_kg >= 75) zone = "DANGER (75-77)";
    else if (w.weight_kg >= 73.5) zone = "acceptable";
    lines.push(`  ${dateStr}: ${kg}kg [${zone}]`);
  }
  lines.push(`  Δ: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}kg over ${sorted.length} readings`);
  return lines.join("\n");
}

function formatReviewArtifacts(artifacts: ArtifactRow[]): string {
  if (artifacts.length === 0) return "No evening reviews found in the last 7 days.";

  return artifacts
    .map((a) => {
      const date = a.created_at.toISOString().slice(0, 10);
      return `--- Review: ${date} ---\n${a.body}`;
    })
    .join("\n\n");
}

interface ContextData {
  entries: EntryRow[];
  reviews: ArtifactRow[];
  ouraWeekly: string;
  weightTrend: string;
}

function buildContextMessage(data: ContextData): string {
  const sections: string[] = [];

  // Journal entries — full text, no truncation
  sections.push("=== JOURNAL ENTRIES (last 7 days) ===");
  if (data.entries.length === 0) {
    sections.push("No journal entries found in the last 7 days.");
  } else {
    for (const entry of data.entries) {
      sections.push(formatEntry(entry));
    }
  }

  // Past reviews
  sections.push("\n=== PAST EVENING REVIEWS (last 7 days) ===");
  sections.push(formatReviewArtifacts(data.reviews));

  // Oura
  sections.push("\n=== OURA BIOMETRICS (weekly) ===");
  sections.push(data.ouraWeekly);

  // Weight
  sections.push("\n=== WEIGHT DATA ===");
  sections.push(data.weightTrend);

  return sections.join("\n");
}

// ============================================================================
// Prompt handler
// ============================================================================

export async function handleEveningReviewPrompt(
  pool: pg.Pool
): Promise<GetPromptResult> {
  const dateTo = todayInTimezone();
  const dateFrom = daysAgoInTimezone(7);

  // Parallel queries with graceful degradation
  const [entriesResult, reviewsResult, ouraResult, weightResult] =
    await Promise.allSettled([
      getEntriesByDateRange(pool, dateFrom, dateTo, 50),
      getRecentReviewArtifacts(pool, dateFrom, dateTo),
      getOuraWeeklyRows(pool, dateTo),
      listWeights(pool, { from: dateFrom, to: dateTo }),
    ]);

  const entries = entriesResult.status === "fulfilled" ? entriesResult.value : [];
  const reviews = reviewsResult.status === "fulfilled" ? reviewsResult.value : [];
  const ouraRows = ouraResult.status === "fulfilled" ? ouraResult.value : [];
  const weightData = weightResult.status === "fulfilled" ? weightResult.value.rows : [];

  // Build Oura text with graceful degradation
  let ouraWeekly: string;
  if (ouraResult.status === "rejected") {
    ouraWeekly = "Oura data unavailable.";
  } else {
    ouraWeekly = formatOuraWeekly(ouraRows);
  }

  // Build weight text with graceful degradation
  let weightTrend: string;
  if (weightResult.status === "rejected") {
    weightTrend = "Weight data unavailable.";
  } else {
    weightTrend = formatWeightTrend(weightData);
  }

  const contextMessage = buildContextMessage({
    entries,
    reviews,
    ouraWeekly,
    weightTrend,
  });

  return {
    description: "Evening review session with 7-day journal context, biometrics, and past reviews",
    messages: [
      {
        role: "user",
        content: { type: "text", text: SYSTEM_PROMPT },
      },
      {
        role: "user",
        content: { type: "text", text: contextMessage },
      },
    ],
  };
}
