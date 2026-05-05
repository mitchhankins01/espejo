import { randomUUID } from "crypto";
import type pg from "pg";
import type { ModelMessage } from "ai";
import { insertChatMessage } from "../../db/queries/chat.js";
import { logUsage } from "../../db/queries/usage.js";
import {
  sendTelegramMessage,
  sendTelegramMessageReturningId,
  createStreamEditor,
  editTelegramMessageText,
} from "../client.js";
import { chat } from "../../llm/index.js";
import { buildSpanishPracticeSystemPrompt } from "../../prompts/spanish-practice.js";
import {
  setFlow,
  clearFlow,
  type PracticeFlowState,
} from "../flow-state.js";
import {
  runPracticeExtraction,
  type ExtractionResult,
} from "../practice-session.js";

const FLOW_NAME = "practice";
const PRACTICE_MODEL = "claude-haiku-4-5-20251001";
const PRACTICE_MAX_TOKENS = 1024;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function startPracticeFlow(params: {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
  rawText: string;
}): Promise<void> {
  const { pool, chatId, externalMessageId, rawText } = params;

  await insertChatMessage(pool, {
    chatId,
    externalMessageId,
    role: "user",
    content: rawText,
    flow: FLOW_NAME,
  });

  const state: PracticeFlowState = {
    flow: "practice",
    sessionId: randomUUID().slice(0, 8),
    startedAt: Date.now(),
  };
  setFlow(chatId, state);

  const greeting =
    "🇪🇸 <b>Sesión de práctica iniciada.</b>\n" +
    "Hablamos en español. Corrijo al vuelo. Tú llevas el ritmo — yo te mantengo en movimiento.\n\n" +
    "¿Cómo va el día? Cuéntame lo que tengas encima ahora mismo.\n\n" +
    "<i>Cuando quieras cerrar, manda /done.</i>";
  await sendTelegramMessage(chatId, greeting);
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: greeting,
    flow: FLOW_NAME,
  });
}

export async function continuePracticeFlow(params: {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
  text: string;
}): Promise<void> {
  const { pool, chatId, externalMessageId, text } = params;
  const startedAt = Date.now();

  await insertChatMessage(pool, {
    chatId,
    externalMessageId,
    role: "user",
    content: text,
    flow: FLOW_NAME,
  });

  const system = await buildSpanishPracticeSystemPrompt(pool);

  const seedMessageId = await sendTelegramMessageReturningId(chatId, "…");
  const editor = seedMessageId != null ? createStreamEditor(chatId, seedMessageId) : null;

  const messages: ModelMessage[] = [{ role: "user", content: text }];

  let response: { text: string } | null = null;
  try {
    response = await chat({
      provider: "anthropic",
      model: PRACTICE_MODEL,
      system,
      messages,
      maxTokens: PRACTICE_MAX_TOKENS,
      onTextDelta: editor ? (snapshot) => editor.update(snapshot) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (editor) await editor.flush().catch(() => undefined);
    const fallback = `Error: ${message}`;
    if (seedMessageId != null) {
      await editTelegramMessageText(chatId, seedMessageId, fallback, "HTML");
    } else {
      await sendTelegramMessage(chatId, fallback);
    }
    await logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "practice",
      actor: chatId,
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  if (editor) await editor.flush().catch(() => undefined);
  const finalText = response.text.trim();
  if (finalText.length === 0) return;
  if (seedMessageId != null) {
    await editTelegramMessageText(chatId, seedMessageId, finalText, "HTML");
  } else {
    await sendTelegramMessage(chatId, finalText);
  }
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: finalText,
    flow: FLOW_NAME,
  });

  await logUsage(pool, {
    source: "telegram",
    surface: "flow",
    action: "practice",
    actor: chatId,
    ok: true,
    durationMs: Date.now() - startedAt,
  });
}

export async function endPracticeFlow(params: {
  pool: pg.Pool;
  chatId: string;
}): Promise<{ ended: boolean }> {
  const { pool, chatId } = params;
  const state = clearFlow(chatId);
  if (state?.flow !== "practice") {
    return { ended: false };
  }

  await sendTelegramMessage(chatId, "<i>Procesando sesión…</i>");
  try {
    const result: ExtractionResult = await runPracticeExtraction(chatId, {
      sessionId: state.sessionId,
      startedAt: new Date(state.startedAt),
    });
    const prefix = result.wrotePersisted
      ? `✅ Estado actualizado (${result.messageCount} mensajes).\n\n`
      : `⚠️ ${result.messageCount} mensajes — estado no guardado.\n\n`;
    const summary = `${prefix}${escapeHtml(result.diffSummary)}`;
    await sendTelegramMessage(chatId, summary);
    await insertChatMessage(pool, {
      chatId,
      externalMessageId: null,
      role: "assistant",
      content: summary,
      flow: FLOW_NAME,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await sendTelegramMessage(chatId, `Extraction failed: ${escapeHtml(errMsg)}`);
  }
  return { ended: true };
}
