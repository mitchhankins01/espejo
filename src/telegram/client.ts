import { config } from "../config.js";
import { isRecoverableNetworkError } from "./network-errors.js";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function botUrl(method: string): string {
  return `${TELEGRAM_API}/bot${config.telegram.botToken}/${method}`;
}

async function telegramPost(
  method: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(botUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function telegramPostForm(
  method: string,
  form: FormData
): Promise<Response> {
  return fetch(botUrl(method), {
    method: "POST",
    body: form,
  });
}

async function extractTelegramDescription(res: Response): Promise<string | undefined> {
  const body = await res.json().catch(/* v8 ignore next */ () => ({}));
  return (body as Record<string, unknown>).description as string | undefined;
}

/**
 * Split text into chunks at paragraph boundaries, respecting the max length.
 */
function chunkText(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
    if (splitIdx <= 0) {
      // Try line boundary
      splitIdx = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    }
    if (splitIdx <= 0) {
      // Hard break
      splitIdx = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, "");
  }

  return chunks;
}

/**
 * Send a message via Telegram Bot API with retry and chunking.
 * Retries on recoverable network errors with exponential backoff.
 * Falls back to plain text if HTML parsing fails.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  const chunks = chunkText(text);

  for (let i = 0; i < chunks.length; i++) {
    // Only attach reply_markup to the last chunk
    const markup = i === chunks.length - 1 ? replyMarkup : undefined;
    await sendSingleMessage(chatId, chunks[i], markup);
  }
}

async function sendSingleMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  // Try with HTML parse mode first
  for (let attempt = 0; ; attempt++) {
    try {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      };
      if (replyMarkup) body.reply_markup = replyMarkup;
      const res = await telegramPost("sendMessage", body);

      if (res.ok) return;

      const description = await extractTelegramDescription(res);

      // If it's a parse error, retry as plain text (no parse_mode)
      if (
        description &&
        description.toLowerCase().includes("can't parse entities")
      ) {
        await telegramPost("sendMessage", {
          chat_id: chatId,
          text,
        });
        return;
      }

      // Non-recoverable API error
      console.error(`Telegram API error [chat:${chatId}]: ${description ?? res.status}`);
      return;
    } catch (err) {
      if (!isRecoverableNetworkError(err) || attempt === MAX_RETRIES) {
        console.error(`Telegram send failed [chat:${chatId}]:`, err);
        return;
      }
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
    }
    /* v8 ignore next -- loop boundary is not naturally reachable */
  }
  /* v8 ignore next -- defensive: unreachable due explicit returns in loop */
  return;
  /* v8 ignore next -- defensive: function boundary */
}

/**
 * Send a voice reply via Telegram Bot API with retry.
 * Uses sendVoice endpoint so the reply appears as a voice note.
 */
export async function sendTelegramVoice(
  chatId: string,
  audio: Buffer,
  caption?: string
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      if (caption) {
        form.append("caption", caption);
      }
      const audioBytes = new Uint8Array(audio.byteLength);
      audio.copy(audioBytes, 0, 0, audio.byteLength);
      form.append(
        "voice",
        new Blob([audioBytes.buffer], { type: "audio/mpeg" }),
        "reply.mp3"
      );

      const res = await telegramPostForm("sendVoice", form);
      if (res.ok) return true;

      const description = await extractTelegramDescription(res);
      console.error(
        `Telegram voice API error [chat:${chatId}]: ${description ?? res.status}`
      );
      return false;
    } catch (err) {
      if (!isRecoverableNetworkError(err) || attempt === MAX_RETRIES) {
        console.error(`Telegram voice send failed [chat:${chatId}]:`, err);
        return false;
      }
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
    }
    /* v8 ignore next -- loop boundary is not naturally reachable */
  }
  /* v8 ignore next -- defensive: unreachable due explicit returns in loop */
  return false;
  /* v8 ignore next -- defensive: function boundary */
}

/**
 * Send a chat action (e.g. "typing") to show the user the bot is working.
 */
export async function sendChatAction(
  chatId: string,
  action: string
): Promise<void> {
  await telegramPost("sendChatAction", { chat_id: chatId, action });
}

/**
 * Send a single short message and return its message_id, or null on failure.
 * Used as the seed bubble for streaming edits — keep the text short and
 * plain (no parse_mode) so it never fails to render.
 */
export async function sendTelegramMessageReturningId(
  chatId: string,
  text: string
): Promise<number | null> {
  try {
    const res = await telegramPost("sendMessage", { chat_id: chatId, text });
    if (!res.ok) {
      const description = await extractTelegramDescription(res);
      console.error(
        `Telegram send-with-id error [chat:${chatId}]: ${description ?? res.status}`
      );
      return null;
    }
    const body = (await res.json().catch(/* v8 ignore next */ () => ({}))) as {
      result?: { message_id?: number };
    };
    return body.result?.message_id ?? null;
  } catch (err) {
    /* v8 ignore next 2 -- network failures non-deterministic */
    console.error(`Telegram send-with-id failed [chat:${chatId}]:`, err);
    return null;
  }
}

/**
 * Edit a previously sent message in place. Best-effort: errors are logged
 * but never thrown so they can't kill an in-flight stream. "Message is not
 * modified" errors (same text as before) are swallowed.
 */
export async function editTelegramMessageText(
  chatId: string,
  messageId: number,
  text: string,
  parseMode?: "HTML"
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (parseMode) body.parse_mode = parseMode;
    const res = await telegramPost("editMessageText", body);
    if (res.ok) return;
    const description = await extractTelegramDescription(res);
    if (description?.toLowerCase().includes("message is not modified")) return;
    if (
      parseMode === "HTML" &&
      description?.toLowerCase().includes("can't parse entities")
    ) {
      // Retry without parse_mode so the user still sees the final text.
      await telegramPost("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
      });
      return;
    }
    console.error(
      `Telegram edit error [chat:${chatId} msg:${messageId}]: ${description ?? res.status}`
    );
  } catch (err) {
    /* v8 ignore next 2 -- network failures non-deterministic */
    console.error(`Telegram edit failed [chat:${chatId} msg:${messageId}]:`, err);
  }
}

const STREAM_EDIT_INTERVAL_MS = 1200;
const STREAM_EDIT_MAX_CHARS = 4000;

/**
 * Sanitize a streaming snapshot for plain-text display. Mid-flight, the
 * model may have emitted half-formed HTML tags (`<b`, `</i`) or entities
 * (`&am`) that Telegram would render as literal junk since we deliberately
 * send streaming edits without `parse_mode` (final edit applies HTML).
 * Strip complete tags, decode common entities, and trim any trailing
 * partials so the user only ever sees clean text.
 */
export function normalizeStreamSnapshot(text: string): string {
  let out = text.replace(/<\/?[a-zA-Z][^<>]*>/g, "");
  // Strip trailing partial entity BEFORE decoding so a literal "&" produced
  // by an earlier decode (e.g. "R&D" from "R&amp;D") isn't re-eaten.
  out = out.replace(/&[a-zA-Z#0-9]{0,6}$/, "");
  out = out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  out = out.replace(/<\/?[a-zA-Z][^<>]*$/, "");
  out = out.replace(/<\/?$/, "");
  return out;
}

/**
 * Build a throttled editor for an in-flight Telegram message. Calls to the
 * returned `update(text)` are coalesced — at most one edit per
 * STREAM_EDIT_INTERVAL_MS, with the latest snapshot. `flush()` forces the
 * pending edit out immediately and waits for it.
 */
export function createStreamEditor(
  chatId: string,
  messageId: number,
  intervalMs: number = STREAM_EDIT_INTERVAL_MS
): {
  update: (text: string) => void;
  flush: () => Promise<void>;
} {
  let pendingText: string | null = null;
  let lastSent = "";
  let lastEditAt = 0;
  let inflight: Promise<void> | null = null;
  let scheduled: NodeJS.Timeout | null = null;

  async function send(text: string): Promise<void> {
    lastSent = text;
    lastEditAt = Date.now();
    await editTelegramMessageText(chatId, messageId, text);
  }

  function scheduleSend(): void {
    if (scheduled || inflight) return;
    const wait = Math.max(0, lastEditAt + intervalMs - Date.now());
    scheduled = setTimeout(() => {
      scheduled = null;
      const next = pendingText;
      if (next == null || next === lastSent) return;
      pendingText = null;
      inflight = send(next).finally(() => {
        inflight = null;
        if (pendingText != null) scheduleSend();
      });
    }, wait);
  }

  function update(text: string): void {
    // Sanitize partial HTML/entities first — the streaming preview goes
    // out without parse_mode, so half-tags must not be visible.
    const cleaned = normalizeStreamSnapshot(text);
    // Telegram caps message text at 4096 chars; clip preview so partial
    // streams never blow the limit. Final flush from caller passes the
    // full text (still subject to clip — practice replies are short).
    const clipped =
      cleaned.length > STREAM_EDIT_MAX_CHARS
        ? cleaned.slice(0, STREAM_EDIT_MAX_CHARS) + "…"
        : cleaned;
    if (clipped === lastSent) return;
    pendingText = clipped;
    scheduleSend();
  }

  async function flush(): Promise<void> {
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    if (inflight) await inflight;
    if (pendingText != null && pendingText !== lastSent) {
      const next = pendingText;
      pendingText = null;
      await send(next);
    }
  }

  return { update, flush };
}

/**
 * Acknowledge a callback query to dismiss the loading spinner.
 */
export async function answerCallbackQuery(
  callbackQueryId: string
): Promise<void> {
  await telegramPost("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
