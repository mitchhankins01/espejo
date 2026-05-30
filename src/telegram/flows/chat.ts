import type pg from "pg";
import type { ModelMessage } from "ai";
import { config } from "../../config.js";
import {
  insertChatMessage,
  getSessionMessages,
  type ChatMessageRow,
} from "../../db/queries/chat.js";
import {
  insertActivityLog,
  type ActivityLogToolCall,
} from "../../db/queries/observability.js";
import { logUsage } from "../../db/queries/usage.js";
import { sendTelegramMessage } from "../client.js";
import { chat } from "../../llm/index.js";
import { buildFlowTools } from "./tool-catalog.js";
import { truncateToolResult } from "../truncation.js";
import { ACTIVE_THREAD_KEYBOARD } from "../keyboard.js";

const FLOW_NAME = "chat";
// Context is a session (everything since the last /done), not a fixed message
// count — so a screenshot pasted early in a thread stays in view the whole
// thread. Bound by a char budget (~4 chars/token) rather than a turn count,
// and a hard row cap as a backstop. /done writes the session boundary.
const CHAT_CONTEXT_CHAR_BUDGET = 96_000; // ~24k tokens of recent turns
const CHAT_CONTEXT_MAX_ROWS = 400;
const CHAT_MAX_TOKENS = 2048;
const CHAT_MAX_STEPS = 15;

function buildSystemPrompt(): string {
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
  return `Today is ${today}. Timezone: ${config.timezone}.

You are Mitch's personal Telegram bot — confidant, translator, sounding board,
and Spanish sparring partner in one.

LANGUAGE (highest priority — overrides the conversation's prior language)
- Reply in the language of Mitch's MOST RECENT message, even when earlier turns
  were in another language. English in → English out; Spanish in → Spanish out.
  A Spanish backlog must NOT pull you back into Spanish once he writes English
  (and vice versa). Re-check every single turn.
- Mitch is a native English speaker. Ambiguous or one-word openers ("hi", "ok",
  "hello", "yes") → English, unless the immediately surrounding thread is
  clearly Spanish.
- Honor explicit overrides ("respond in English", "en español").
- When he pastes content in another language (e.g. a WhatsApp message) but
  writes his request to you in English, answer in English — unless he asks you
  to reply in that language.
- Write naturally at full fluency. No CEFR ceiling, no simplifying, no
  glossing. When he's writing Spanish himself — especially drafting a message
  to send — weave corrections in lightly inline (natural phrasing, a slipped
  gender, a better idiom). Don't lecture or grade.

WHAT HE USES YOU FOR
- Thinking out loud through relationships, dating, and emotional/somatic states
  in the moment.
- Translating and interpreting Spanish messages, and drafting his replies in
  his own voice (warm, direct, a little playful).
- Pulling his own context: when he names a person, theme, or past event, use
  the search tools and his journal/vault/Oura/checkpoint data rather than
  guessing.
- Quick practical questions (a place to go, a track to play, is-this-fine).

HOW TO SHOW UP
- When he's already decided or just needs to be heard, land with him — reflect
  it back, don't relitigate or pile on options. Problem-solve only when he's
  actually asking you to. Over-fixing reads as not listening.
- Tone: Dutch directness + sassy gay edge + calm masculine presence + safe
  feminine warmth. No platitudes, no therapy-speak, no "that must be hard."
- He's gay Dutch-American, 30s, on a Barcelona sabbatical, ADHD + C-PTSD, doing
  his own IFS/EMDR work with his own frameworks — don't introduce generic
  therapy language. Two dogs. Building Espejo (this system).
- If you lack context for something he references, ask one short clarifying
  question or pull it. Never manufacture facts about his life or relationships,
  and don't infer present-tense state from past-tense notes.

SESSION
- The thread runs until Mitch types /done, which clears it. If his new message
  clearly belongs to a different topic than the conversation so far, help with
  it but add a one-line nudge that he can /done to start a clean thread — never
  switch topics silently or withhold an answer. A quick aside needs no nudge.

FORMAT
- Telegram HTML only: <b>, <i>. No markdown.`;
}

function reconstructMessages(rows: ChatMessageRow[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const row of rows) {
    if (row.role === "user") messages.push({ role: "user", content: row.content });
    else if (row.role === "assistant") messages.push({ role: "assistant", content: row.content });
  }
  return messages;
}

/**
 * Session rows arrive newest-first. Keep the most recent within the char budget
 * (always at least the latest turn, even if it alone exceeds it), then flip to
 * oldest-first for replay.
 */
function selectWithinBudget(newestFirst: ChatMessageRow[]): ChatMessageRow[] {
  const kept: ChatMessageRow[] = [];
  let chars = 0;
  for (const row of newestFirst) {
    chars += row.content.length;
    if (kept.length > 0 && chars > CHAT_CONTEXT_CHAR_BUDGET) break;
    kept.push(row);
  }
  return kept.reverse();
}

export async function runChatFlow(params: {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
  text: string;
}): Promise<void> {
  const { pool, chatId, externalMessageId, text } = params;
  const startedAt = Date.now();

  const userInsert = await insertChatMessage(pool, {
    chatId,
    externalMessageId,
    role: "user",
    content: text,
    flow: FLOW_NAME,
  });
  if (externalMessageId && !userInsert.inserted) {
    return;
  }

  const session = await getSessionMessages(pool, chatId, FLOW_NAME, CHAT_CONTEXT_MAX_ROWS);
  const messages = reconstructMessages(selectWithinBudget(session));

  // No streaming seed bubble: a message carrying a ReplyKeyboardMarkup is
  // non-editable (Telegram rejects editMessageText with "message can't be
  // edited"), so we can't stream-edit a keyboard-bearing seed. The webhook
  // already fired a native "typing…" indicator; we send the final reply as a
  // fresh message with the keyboard attached (it persists client-side once
  // sent, so this keeps it pinned and is restart-safe).
  const toolRecords: ActivityLogToolCall[] = [];
  let response: { text: string; finishReason: string } | null = null;
  try {
    response = await chat({
      provider: "anthropic",
      model: config.anthropic.model,
      system: buildSystemPrompt(),
      messages,
      tools: buildFlowTools(pool),
      maxTokens: CHAT_MAX_TOKENS,
      maxSteps: CHAT_MAX_STEPS,
      cacheSystem: true,
      onToolResult: async ({ toolName, args, result }) => {
        const resultText = typeof result === "string" ? result : JSON.stringify(result);
        const truncated = truncateToolResult(toolName, resultText);
        await insertChatMessage(pool, {
          chatId,
          externalMessageId: null,
          role: "tool_result",
          content: truncated,
          flow: FLOW_NAME,
        });
        toolRecords.push({
          name: toolName,
          args: (args ?? {}) as Record<string, unknown>,
          result: resultText,
          truncated_result: truncated,
        });
        await logUsage(pool, {
          source: "telegram",
          surface: "flow",
          action: toolName,
          actor: chatId,
          args: (args ?? {}) as Record<string, unknown>,
          ok: true,
        });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback = `Error: ${message}`;
    await sendTelegramMessage(chatId, fallback, ACTIVE_THREAD_KEYBOARD);
    await insertChatMessage(pool, {
      chatId,
      externalMessageId: null,
      role: "assistant",
      content: fallback,
      flow: FLOW_NAME,
    });
    await logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "chat",
      actor: chatId,
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const finalText = response.text.trim();
  if (finalText.length === 0) {
    return;
  }
  await sendTelegramMessage(chatId, finalText, ACTIVE_THREAD_KEYBOARD);

  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: finalText,
    flow: FLOW_NAME,
  });

  if (toolRecords.length > 0) {
    try {
      await insertActivityLog(pool, {
        chatId,
        memories: [],
        toolCalls: toolRecords,
        costUsd: null,
      });
    } catch (err) {
      console.error(`[chat-flow] activity log error [chat:${chatId}]:`, err);
    }
  }

  await logUsage(pool, {
    source: "telegram",
    surface: "flow",
    action: "chat",
    actor: chatId,
    ok: true,
    durationMs: Date.now() - startedAt,
    meta: { tool_calls: toolRecords.length },
  });
}
