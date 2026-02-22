import type { Express, Request, Response } from "express";
import { config } from "../config.js";
import { runAgent, forceCompact } from "./agent.js";
import {
  sendTelegramMessage,
  sendChatAction,
  sendTelegramVoice,
} from "./client.js";
import {
  transcribeVoiceMessage,
  normalizeVoiceText,
  synthesizeVoiceReply,
} from "./voice.js";
import { extractTextFromDocument, extractTextFromImage } from "./media.js";
import { setMessageHandler, processUpdate } from "./updates.js";
import type { AssembledMessage, TelegramUpdate } from "./updates.js";
import {
  buildEveningKickoffMessage,
  type AgentMode,
} from "./evening-review.js";

// ---------------------------------------------------------------------------
// Message handler — wires updates → agent → client
// ---------------------------------------------------------------------------

const MAX_TEXT_MESSAGE_VOICE_CHARS = 260;
const chatModes = new Map<string, AgentMode>();
const EVENING_DISABLE_TOKENS = new Set(["off", "stop", "end", "done", "exit"]);

function parseSlashCommand(
  text: string
): { name: string; argText: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const commandPart = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const argText = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const name = commandPart.slice(1).split("@")[0].toLowerCase();
  if (!name) return null;

  return { name, argText };
}

function getChatMode(chatId: string): AgentMode {
  return chatModes.get(chatId) ?? "default";
}

/** Visible for testing only. */
export function clearWebhookChatModes(): void {
  chatModes.clear();
}

function isVoiceFriendlyResponse(response: string): boolean {
  const plainText = normalizeVoiceText(response);
  if (!plainText) return false;

  if (plainText.length < config.telegram.voiceReplyMinChars) return false;
  if (plainText.length > config.telegram.voiceReplyMaxChars) return false;

  if (/https?:\/\/|www\./i.test(plainText)) return false;
  if (/`/.test(response)) return false;
  if (response.split("\n").length > 5) return false;
  if (/^\s*[-*•]\s/m.test(response)) return false;
  if (/^\s*\d+\.\s/m.test(response)) return false;

  return true;
}

function shouldReplyWithVoice(
  response: string,
  incomingWasVoice: boolean,
  messageId: number
): boolean {
  if (config.telegram.voiceReplyMode === "off") return false;
  if (!isVoiceFriendlyResponse(response)) return false;
  if (config.telegram.voiceReplyMode === "always") return true;

  if (incomingWasVoice) return true;

  const plainText = normalizeVoiceText(response);
  const maxTextChars = Math.min(
    MAX_TEXT_MESSAGE_VOICE_CHARS,
    config.telegram.voiceReplyMaxChars
  );
  if (plainText.length > maxTextChars) return false;

  const replyEvery = Math.max(1, config.telegram.voiceReplyEvery);
  return replyEvery === 1 || messageId % replyEvery === 0;
}

async function handleMessage(msg: AssembledMessage): Promise<void> {
  const chatId = String(msg.chatId);

  // Show typing indicator immediately
  await sendChatAction(chatId, "typing");

  let text = msg.text;

  try {
    // OCR photo messages
    if (msg.photo) {
      text = await extractTextFromImage(msg.photo.fileId, msg.photo.caption);
      if (!text) {
        await sendTelegramMessage(
          chatId,
          "I couldn't extract any text from that image. Try a clearer image or add a caption."
        );
        return;
      }
    }

    // Extract text from supported documents
    if (msg.document) {
      text = await extractTextFromDocument({
        fileId: msg.document.fileId,
        fileName: msg.document.fileName,
        mimeType: msg.document.mimeType,
        caption: msg.document.caption,
      });
      if (!text) {
        await sendTelegramMessage(
          chatId,
          "I couldn't extract any text from that document."
        );
        return;
      }
    }

    // Transcribe voice messages
    if (msg.voice && !msg.photo && !msg.document) {
      text = await transcribeVoiceMessage(
        msg.voice.fileId,
        msg.voice.durationSeconds
      );
    }

    if (!text) return;

    const command = parseSlashCommand(text);

    // Handle /compact command
    if (command?.name === "compact") {
      await forceCompact(chatId, async (summary) => {
        await sendTelegramMessage(chatId, `<i>Memory note: ${summary}</i>`);
      });
      return;
    }

    // Handle /compose command
    let prefill: string | undefined;
    if (command?.name === "compose") {
      text = "Write the entry now.";
      prefill = "# ";
    }

    // Handle /evening command
    if (command?.name === "evening") {
      const firstArg = command.argText.split(/\s+/)[0].toLowerCase();
      if (EVENING_DISABLE_TOKENS.has(firstArg)) {
        chatModes.delete(chatId);
        await sendTelegramMessage(chatId, "<i>Evening review mode off.</i>");
        return;
      }

      chatModes.set(chatId, "evening_review");
      text = buildEveningKickoffMessage(command.argText || null);
    }

    const { response, activity } = await runAgent({
      chatId,
      message: text,
      externalMessageId: String(msg.messageId),
      messageDate: msg.date,
      mode: getChatMode(chatId),
      prefill,
      /* v8 ignore next 3 -- async callback tested via agent compaction tests */
      onCompacted: async (summary) => {
        await sendTelegramMessage(chatId, `<i>Memory note: ${summary}</i>`);
      },
    });

    if (response) {
      const fullResponse = activity
        ? `${response}\n\n<i>${activity}</i>`
        : response;

      const useVoice = shouldReplyWithVoice(
        response,
        Boolean(msg.voice),
        msg.messageId
      );
      if (useVoice) {
        try {
          await sendChatAction(chatId, "record_voice");
          const voiceAudio = await synthesizeVoiceReply(response);
          await sendChatAction(chatId, "upload_voice");
          const voiceSent = await sendTelegramVoice(chatId, voiceAudio);
          if (voiceSent) {
            if (activity) {
              await sendTelegramMessage(chatId, `<i>${activity}</i>`);
            }
            return;
          }
        } catch (voiceErr) {
          console.error(`Telegram voice reply failed [chat:${chatId}]:`, voiceErr);
        }
      }

      await sendTelegramMessage(chatId, fullResponse);
    }
  } catch (err) {
    console.error(`Telegram error [chat:${chatId}]:`, err);
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      await sendTelegramMessage(chatId, `Error: ${errMsg}`);
    } catch {
      /* v8 ignore next -- notification failed; original already logged */
    }
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerTelegramRoutes(app: Express): void {
  // Wire the message handler on init
  setMessageHandler(handleMessage);

  const secretToken = config.telegram.secretToken;
  const allowedChatId = config.telegram.allowedChatId;

  app.post("/api/telegram", (req: Request, res: Response) => {
    // Validate secret token header
    if (secretToken) {
      const headerToken = req.headers["x-telegram-bot-api-secret-token"];
      if (headerToken !== secretToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const update = req.body as TelegramUpdate;

    // Check chat_id allowlist
    if (allowedChatId) {
      const chatId =
        update.message?.chat.id ??
        update.callback_query?.message?.chat.id;
      if (chatId !== undefined && String(chatId) !== allowedChatId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    }

    // Ack immediately
    res.status(200).json({ ok: true });

    // Dispatch async
    processUpdate(update);
  });
}
