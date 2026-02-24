import { config } from "../config.js";
import { sendTelegramMessage } from "./client.js";

const MAX_MESSAGE_LENGTH = 4096;
const DEDUP_WINDOW_MS = 60_000;
const DEDUP_MAX_ENTRIES = 5;

const recentErrors: { message: string; timestamp: number }[] = [];

function isDuplicate(message: string): boolean {
  const now = Date.now();
  while (recentErrors.length > 0 && now - recentErrors[0].timestamp > DEDUP_WINDOW_MS) {
    recentErrors.shift();
  }
  if (recentErrors.some((e) => e.message === message)) return true;
  recentErrors.push({ message, timestamp: now });
  if (recentErrors.length > DEDUP_MAX_ENTRIES) recentErrors.shift();
  return false;
}

function formatError(context: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const header = `<b>Error:</b> ${context}`;
  const body = `<pre>${message}</pre>`;
  const full = `${header}\n${body}`;
  if (full.length <= MAX_MESSAGE_LENGTH) return full;
  const overhead = header.length + "\n<pre></pre>".length;
  return `${header}\n<pre>${message.slice(0, MAX_MESSAGE_LENGTH - overhead)}</pre>`;
}

export function notifyError(context: string, err: unknown): void {
  const chatId = config.telegram.allowedChatId;
  const token = config.telegram.botToken;
  if (!token || !chatId) return;

  const message = err instanceof Error ? err.message : String(err);
  if (isDuplicate(message)) return;

  const text = formatError(context, err);
  /* v8 ignore next 3 -- fire-and-forget: sendTelegramMessage never rejects visibly */
  void sendTelegramMessage(chatId, text).catch((sendErr) => {
    console.error("Failed to send error notification:", sendErr);
  });
}

export function _resetDedupState(): void {
  recentErrors.length = 0;
}
