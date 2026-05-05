import type { Express, Request, Response } from "express";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { sendChatAction } from "./client.js";
import { setMessageHandler, processUpdate } from "./updates.js";
import type { AssembledMessage, TelegramUpdate } from "./updates.js";
import { routeMessage } from "./router.js";

async function handleMessage(msg: AssembledMessage): Promise<void> {
  const chatId = String(msg.chatId);
  if (msg.reactionEmoji) return;

  await sendChatAction(chatId, "typing").catch(() => undefined);
  await routeMessage({ pool }, msg);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerTelegramRoutes(app: Express): void {
  setMessageHandler(handleMessage);

  const secretToken = config.telegram.secretToken;
  const allowedChatId = config.telegram.allowedChatId;

  app.post("/api/telegram", (req: Request, res: Response) => {
    if (secretToken) {
      const headerToken = req.headers["x-telegram-bot-api-secret-token"];
      if (headerToken !== secretToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const update = req.body as TelegramUpdate;

    if (allowedChatId) {
      const chatId =
        update.message?.chat.id ??
        update.callback_query?.message?.chat.id ??
        update.message_reaction?.chat.id;
      if (chatId !== undefined && String(chatId) !== allowedChatId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    }

    res.status(200).json({ ok: true });
    processUpdate(update);
  });
}
