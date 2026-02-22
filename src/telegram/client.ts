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
  text: string
): Promise<void> {
  const chunks = chunkText(text);

  for (const chunk of chunks) {
    await sendSingleMessage(chatId, chunk);
  }
}

async function sendSingleMessage(
  chatId: string,
  text: string
): Promise<void> {
  // Try with HTML parse mode first
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await telegramPost("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      });

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
