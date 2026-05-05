import type pg from "pg";
import { handleDistillHnThread } from "../../tools/distill-hn-thread.js";
import { insertChatMessage } from "../../db/queries/chat.js";
import { logUsage } from "../../db/queries/usage.js";
import { sendTelegramMessage } from "../client.js";

const FLOW_NAME = "distill-hn";
const HN_URL_REGEX =
  /^\s*https?:\/\/(?:[\w.-]+\.)?news\.ycombinator\.com\/item\?id=\d+(?:&[^\s]+)*\s*$/i;

export function isSoloHnUrl(text: string): boolean {
  return HN_URL_REGEX.test(text);
}

export async function runDistillHnFlow(params: {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
  url: string;
}): Promise<void> {
  const { pool, chatId, externalMessageId, url } = params;
  const startedAt = Date.now();

  await insertChatMessage(pool, {
    chatId,
    externalMessageId,
    role: "user",
    content: url,
    flow: FLOW_NAME,
  });

  let reply: string;
  try {
    const result = await handleDistillHnThread(pool, { url });
    reply = typeof result === "string" ? result : "Starting distillation…";
    await logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "distill_hn_thread",
      actor: chatId,
      args: { url },
      ok: true,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply = `Failed to start distillation: ${message}`;
    await logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "distill_hn_thread",
      actor: chatId,
      args: { url },
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
  }

  await sendTelegramMessage(chatId, reply);
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: reply,
    flow: FLOW_NAME,
  });
}
