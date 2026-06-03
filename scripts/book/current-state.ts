/**
 * Auto-derived "current state" ground truth, injected into the planner and
 * writer so they can override stale framing in older journal entries and
 * insights (which are snapshots from when they were written).
 *
 * No hand-maintained file: the block is derived at write time from the reader's
 * recent raw journal entries via one cheap call. Recent entries are the freshest
 * signal for who is current vs. past, what ended, and what changed — exactly the
 * facts a months-old insight gets wrong. It's a soft prior for the writer; the
 * Opus verifier (which reads the raw entries directly) is the hard backstop.
 *
 * Degrades to "" when there's no API key or too little recent journaling — the
 * pipeline treats "" as "no ground-truth block" and leans on the verifier alone.
 */
import { config } from "../../src/config.js";
import { bookChat } from "./llm.js";
import { fetchRecentEntries } from "./context.js";

const DERIVE_DAYS = 30;
const MIN_ENTRIES = 3;
const ENTRY_CHARS = 1500;

const SYSTEM = `You read a few weeks of one person's (Mitch's) raw journal entries and produce a SHORT "current state" snapshot — the ground truth a months-old insight would get wrong. Downstream this overrides stale framing, so accuracy and recency matter more than completeness.

Output compact markdown, this shape:

## People
- **<name>** — <current | ended <date if stated> | unclear>. <one clause of status: dating, broke up, friend, etc.>

## Threads
- <live situation — work, health, location, a recurring craving/struggle — with status>

Hard rules:
- ONLY state what the entries support. If the entries don't establish a person's current status, either omit them or mark "unclear" — never guess.
- A relationship the entries show as ENDED must be marked ended (with the date if given), NOT carried forward as live. This is the single most important job: catch breakups, moves, job changes, resolved cravings.
- Most-recent signal wins when entries conflict.
- Be terse — facts, not prose. No preamble, no "based on the entries". 12 lines max.
- If there genuinely isn't enough to say, output exactly: (insufficient recent signal)`;

/**
 * Derive the current-state block from recent journal entries. Returns "" on no
 * API key, too few entries, or an empty/"insufficient" model result.
 */
export async function deriveCurrentState(
  daysBack = DERIVE_DAYS
): Promise<string> {
  if (!config.anthropic.apiKey) return "";

  const entries = await fetchRecentEntries(daysBack);
  if (entries.length < MIN_ENTRIES) return "";

  const corpus = entries
    .map((e) => `[${e.date}]\n${e.text.slice(0, ENTRY_CHARS)}`)
    .join("\n\n---\n\n");

  const text = await bookChat({
    model: config.models.anthropicFast,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Recent journal entries (last ${daysBack} days, newest first). Produce the current-state snapshot.\n\n${corpus}`,
      },
    ],
    maxTokens: 700,
    temperature: 0,
    label: "current-state",
  });

  const trimmed = text.trim();
  if (!trimmed || /^\(insufficient recent signal\)$/i.test(trimmed)) return "";
  return trimmed;
}
