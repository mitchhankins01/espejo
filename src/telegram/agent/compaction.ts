import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { pool } from "../../db/client.js";
import {
  getRecentMessages,
  insertChatMessage,
  markMessagesCompacted,
  type ChatMessageRow,
} from "../../db/queries.js";
import {
  CHARS_PER_TOKEN,
  COMPACTION_TOKEN_BUDGET,
  MIN_MESSAGES_FOR_FORCE_COMPACT,
  RECENT_MESSAGES_LIMIT,
  getAnthropic,
  getOpenAI,
  getLlmProvider,
  getLlmModel,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

async function tryAcquireLock(p: pg.Pool): Promise<boolean> {
  const res = await p.query<{ pg_try_advisory_lock: boolean }>(
    "SELECT pg_try_advisory_lock(1337)"
  );
  return res.rows[0].pg_try_advisory_lock;
}

async function releaseLock(p: pg.Pool): Promise<void> {
  await p.query("SELECT pg_advisory_unlock(1337)");
}

async function summarizeCompactedMessages(messages: ChatMessageRow[]): Promise<string> {
  const summaryInput = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  if (summaryInput.trim().length === 0) {
    return "No user/assistant content in compacted window.";
  }

  const prompt = `Summarize the conversation below in 3-5 short bullet points for continuity.\nFocus on open loops, commitments, and unresolved questions.\nDo not extract memory patterns.\n\nConversation:\n<untrusted>\n${summaryInput}\n</untrusted>`;
  const provider = getLlmProvider();
  const model = getLlmModel(provider);
  let text: string | null = null;

  if (provider === "openai") {
    const openai = getOpenAI();
    const response = await openai.chat.completions.create({
      model,
      max_tokens: 512,
      messages: [
        { role: "system", content: "Return plain text only." },
        { role: "user", content: prompt },
      ],
    });
    text = response.choices[0]?.message?.content?.trim() ?? null;
  } else {
    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    text = textBlock?.text?.trim() ?? null;
  }

  if (text && text.length > 0) {
    return text.slice(0, 2000);
  }
  return "Compacted older messages and saved a short context summary.";
}

async function runCompaction(
  chatId: string,
  messages: ChatMessageRow[],
  onCompacted?: (summary: string) => Promise<void>
): Promise<void> {
  // Take oldest half for compaction
  const compactionCount = Math.floor(messages.length / 2);
  const toCompact = messages.slice(0, compactionCount);

  /* v8 ignore next -- defensive: messages.length > 0 guaranteed by caller */
  if (toCompact.length === 0) return;

  const summary = await summarizeCompactedMessages(toCompact);
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: `<i>Context summary:</i>\n${summary}`,
  });
  // Mark messages as compacted
  await markMessagesCompacted(pool, toCompact.map((m) => m.id));

  // Notify caller of compaction results
  if (onCompacted) {
    await onCompacted(`trimmed ${toCompact.length} messages and saved continuity summary`);
  }
}

export async function compactIfNeeded(
  chatId: string,
  onCompacted?: (summary: string) => Promise<void>
): Promise<void> {
  // Estimate current context size
  const recentMessages = await getRecentMessages(pool, chatId, RECENT_MESSAGES_LIMIT);
  const totalChars = recentMessages.reduce((sum, m) => sum + m.content.length, 0);

  const overBudget = totalChars / CHARS_PER_TOKEN >= COMPACTION_TOKEN_BUDGET;

  if (!overBudget) return;

  // Try to acquire lock
  const acquired = await tryAcquireLock(pool);
  if (!acquired) return;

  try {
    // Re-check after acquiring lock
    const messages = await getRecentMessages(pool, chatId, RECENT_MESSAGES_LIMIT);
    await runCompaction(chatId, messages, onCompacted);
  } finally {
    await releaseLock(pool);
  }
}

export async function forceCompact(
  chatId: string,
  onCompacted?: (summary: string) => Promise<void>
): Promise<void> {
  const messages = await getRecentMessages(pool, chatId, RECENT_MESSAGES_LIMIT);
  if (messages.length < MIN_MESSAGES_FOR_FORCE_COMPACT) {
    if (onCompacted) await onCompacted("nothing to compact");
    return;
  }

  const acquired = await tryAcquireLock(pool);
  if (!acquired) {
    if (onCompacted) await onCompacted("compaction already in progress");
    return;
  }

  try {
    await runCompaction(chatId, messages, onCompacted);
  } finally {
    await releaseLock(pool);
  }
}
