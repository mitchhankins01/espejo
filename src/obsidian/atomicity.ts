import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { config } from "../config.js";
import { sendTelegramMessage } from "../telegram/client.js";

// ============================================================================
// LLM-based atomicity assessment for Obsidian notes
// ============================================================================

const ASSESSMENT_MODEL = "claude-haiku-4-5-20251001";
const ASSESSMENT_CONCURRENCY = 5;

const atomicityResponseSchema = z.object({
  atomic: z.boolean(),
  reason: z.string(),
  suggestedSplits: z.array(z.string()).optional(),
});

export interface AtomicityResult {
  atomic: boolean;
  reason: string;
  suggestedSplits?: string[];
}

interface NoteToAssess {
  title: string;
  body: string;
  kind: string;
}

/** Assess a single note's atomicity via LLM */
async function assessSingleNote(
  client: Anthropic,
  note: NoteToAssess
): Promise<AtomicityResult | null> {
  try {
    const response = await client.messages.create({
      model: ASSESSMENT_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Analyze if this note is atomic (covers ONE topic/idea). Respond ONLY with JSON: {"atomic": boolean, "reason": "brief explanation", "suggestedSplits": ["split suggestion 1", ...]}

Title: ${note.title}
Body: ${note.body.slice(0, 2000)}`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = atomicityResponseSchema.safeParse(JSON.parse(jsonMatch[0]));
    return parsed.success ? parsed.data : null;
    /* v8 ignore next 3 */
  } catch {
    return null;
  }
}

/** Escape HTML entities for Telegram HTML mode */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Assess atomicity of changed notes and send Telegram notification
 * for any non-atomic ones. Fire-and-forget — failures are swallowed.
 */
export async function assessAndNotifyAtomicity(
  notes: NoteToAssess[]
): Promise<void> {
  if (notes.length === 0) return;
  if (!config.anthropic.apiKey || !config.telegram.botToken || !config.telegram.allowedChatId) return;

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const nonAtomic: Array<{ title: string; result: AtomicityResult }> = [];

  // Process in batches with concurrency limit
  for (let i = 0; i < notes.length; i += ASSESSMENT_CONCURRENCY) {
    const batch = notes.slice(i, i + ASSESSMENT_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (note) => {
        const result = await assessSingleNote(client, note);
        return { title: note.title, kind: note.kind, result };
      })
    );

    for (const { title, kind, result } of results) {
      if (result && !result.atomic) {
        // Insights are already meant to be atomic — only warn if >1 distinct idea
        if (kind === "insight" && (!result.suggestedSplits || result.suggestedSplits.length <= 1)) {
          continue;
        }
        nonAtomic.push({ title, result });
      }
    }
  }

  if (nonAtomic.length === 0) return;

  // Send batched Telegram notification
  const lines = nonAtomic.map((item) => {
    let msg = `• <b>${escapeHtml(item.title)}</b>\n  ${escapeHtml(item.result.reason)}`;
    if (item.result.suggestedSplits && item.result.suggestedSplits.length > 0) {
      msg += "\n  Suggested splits: " + item.result.suggestedSplits.map((s) => escapeHtml(s)).join(", ");
    }
    return msg;
  });

  const message = `📝 <b>Atomicity check</b> — ${nonAtomic.length} note(s) may cover multiple topics:\n\n${lines.join("\n\n")}`;

  await sendTelegramMessage(config.telegram.allowedChatId, message);
}
