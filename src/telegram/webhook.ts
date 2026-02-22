import type { Express, Request, Response } from "express";
import { config } from "../config.js";
import { runAgent, forceCompact } from "./agent.js";
import { sendTelegramMessage, sendChatAction } from "./client.js";
import { transcribeVoiceMessage } from "./voice.js";
import { extractTextFromDocument, extractTextFromImage } from "./media.js";
import { setMessageHandler, processUpdate } from "./updates.js";
import type { AssembledMessage, TelegramUpdate } from "./updates.js";

// ---------------------------------------------------------------------------
// Message handler — wires updates → agent → client
// ---------------------------------------------------------------------------

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

    // Handle /compact command
    if (text === "/compact") {
      await forceCompact(chatId, async (summary) => {
        await sendTelegramMessage(chatId, `<i>${summary}</i>`);
      });
      return;
    }

    const { response, activity } = await runAgent({
      chatId,
      message: text,
      externalMessageId: String(msg.messageId),
      messageDate: msg.date,
      /* v8 ignore next 3 -- async callback tested via agent compaction tests */
      onCompacted: async (summary) => {
        await sendTelegramMessage(chatId, `<i>Compacted: ${summary}</i>`);
      },
    });

    if (response) {
      const fullResponse = activity
        ? `${response}\n\n<i>${activity}</i>`
        : response;
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
