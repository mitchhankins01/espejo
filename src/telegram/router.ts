import type pg from "pg";
import type { AssembledMessage } from "./updates.js";
import { processScreenTimePhotos } from "./screen-time.js";
import { sendTelegramMessage } from "./client.js";
import { transcribeVoiceMessage } from "./voice.js";
import { extractTextFromDocument, extractTextFromImage } from "./media.js";
import { categorizeError, buildErrorMarkerMessage } from "./error-handling.js";
import { insertChatMessage } from "../db/queries/chat.js";
import { getFlow, clearFlow } from "./flow-state.js";
import {
  startCheckpointFlow,
  continueCheckpointFlow,
} from "./flows/checkpoint.js";
import {
  isSoloHnUrl,
  runDistillHnFlow,
} from "./flows/distill-hn.js";
import {
  runWeightSlashFlow,
} from "./flows/weight-slash.js";
import {
  isWeightCsvDocument,
  tryRunWeightCsvFlow,
} from "./flows/weight-csv.js";
import {
  startPracticeFlow,
  continuePracticeFlow,
  endPracticeFlow,
} from "./flows/practice.js";
import {
  isVaultPromptCommand,
  startVaultPromptFlow,
  continueVaultPromptFlow,
  endVaultPromptFlow,
} from "./flows/vault-prompt.js";
import { runChatFlow } from "./flows/chat.js";

const END_FLOW_ALIASES = new Set([
  "done",
  "end",
  "stop",
  "finish",
  "fin",
  "terminar",
  "listo",
  "cancel",
]);

interface RouterContext {
  pool: pg.Pool;
}

interface ParsedSlash {
  name: string;
  argText: string;
}

function parseSlashCommand(text: string): ParsedSlash | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  const commandPart = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const argText = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const name = commandPart.slice(1).split("@")[0].toLowerCase();
  if (!name) return null;
  return { name, argText };
}

const REGISTERED_SLASHES = new Set<string>([
  "checkpoint",
  "practice",
  "weight",
  "hilo",
  "evening",
  "done",
  "end",
  "stop",
  "finish",
  "fin",
  "terminar",
  "listo",
  "cancel",
]);

export async function routeMessage(
  ctx: RouterContext,
  msg: AssembledMessage
): Promise<void> {
  const chatId = String(msg.chatId);
  const externalMessageId = String(msg.messageId);

  // Reactions ignored (consistent with prior behavior).
  if (msg.reactionEmoji) return;

  // Tier 1 — media classifiers (deterministic, pre-extraction).
  if (msg.photos && msg.photos.length > 0) {
    const result = await processScreenTimePhotos({
      pool: ctx.pool,
      chatId,
      messageId: msg.messageId,
      photos: msg.photos,
      notify: async (toChatId, replyText) => {
        await sendTelegramMessage(toChatId, replyText);
      },
    });
    if (result.isScreenTime) return;
  }

  if (msg.document && isWeightCsvDocument(msg.document)) {
    const csv = await tryRunWeightCsvFlow({
      pool: ctx.pool,
      chatId,
      fileId: msg.document.fileId,
      fileName: msg.document.fileName,
    });
    if (csv.handled) return;
  }

  // Tier 2 — extract text from voice / image / document.
  let text = msg.text;
  try {
    if (msg.photos && msg.photos.length > 0) {
      const first = msg.photos[0];
      text = await extractTextFromImage(first.fileId, first.caption);
      if (!text) {
        await sendTelegramMessage(
          chatId,
          "I couldn't extract any text from that image. Try a clearer image or add a caption."
        );
        return;
      }
    } else if (msg.document) {
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
    } else if (msg.voice) {
      text = await transcribeVoiceMessage(
        msg.voice.fileId,
        msg.voice.durationSeconds
      );
    }
  } catch (err) {
    await handleRouterError(ctx, chatId, err);
    return;
  }

  if (!text) return;

  try {
    await routeText(ctx, {
      chatId,
      externalMessageId,
      text,
    });
  } catch (err) {
    await handleRouterError(ctx, chatId, err);
  }
}

async function routeText(
  ctx: RouterContext,
  args: { chatId: string; externalMessageId: string; text: string }
): Promise<void> {
  const { chatId, externalMessageId, text } = args;
  const command = parseSlashCommand(text);
  const active = getFlow(chatId);

  // Registered slashes always reset state and dispatch.
  if (command && REGISTERED_SLASHES.has(command.name)) {
    if (END_FLOW_ALIASES.has(command.name)) {
      // /done /end /fin /cancel etc. Try practice first, then vault-prompt,
      // then any other flow.
      const ended = await endPracticeFlow({ pool: ctx.pool, chatId });
      if (ended.ended) return;
      const endedVault = endVaultPromptFlow(chatId);
      if (endedVault) {
        await sendTelegramMessage(chatId, "Sesión cerrada.");
        return;
      }
      // Generic close — clear any flow.
      const cleared = clearFlow(chatId);
      const reply = cleared
        ? "Sesión cerrada."
        : "No hay sesión activa.";
      await sendTelegramMessage(chatId, reply);
      return;
    }
    // Other registered slashes — clear any flow that isn't matching.
    if (active && active.flow !== "vault-prompt") clearFlow(chatId);
    if (command.name === "checkpoint") {
      await startCheckpointFlow(
        { pool: ctx.pool, chatId, externalMessageId },
        command.argText
      );
      return;
    }
    if (command.name === "practice") {
      await startPracticeFlow({
        pool: ctx.pool,
        chatId,
        externalMessageId,
        rawText: text,
      });
      return;
    }
    if (command.name === "weight") {
      await runWeightSlashFlow({
        pool: ctx.pool,
        chatId,
        externalMessageId,
        argText: command.argText,
        rawText: text,
      });
      return;
    }
    if (isVaultPromptCommand(command.name)) {
      // If a vault-prompt of this name is already active, treat as continuation.
      if (active?.flow === "vault-prompt" && active.name === command.name) {
        await continueVaultPromptFlow({
          pool: ctx.pool,
          chatId,
          externalMessageId,
          state: active,
          text,
        });
        return;
      }
      // Otherwise, swap to the named vault prompt.
      if (active) clearFlow(chatId);
      await startVaultPromptFlow({
        pool: ctx.pool,
        chatId,
        externalMessageId,
        name: command.name,
        rawText: text,
      });
      return;
    }
    return;
  }

  // Unknown slash with active vault-prompt → forward as user message.
  if (command && active?.flow === "vault-prompt") {
    await continueVaultPromptFlow({
      pool: ctx.pool,
      chatId,
      externalMessageId,
      state: active,
      text,
    });
    return;
  }

  if (command && !REGISTERED_SLASHES.has(command.name) && !active) {
    await sendTelegramMessage(
      chatId,
      "Unknown command — try /checkpoint /practice /hilo /evening /weight."
    );
    return;
  }

  // Active flows take precedence over default chat for non-slash text.
  if (active?.flow === "checkpoint") {
    await continueCheckpointFlow(
      { pool: ctx.pool, chatId, externalMessageId },
      active,
      text
    );
    return;
  }
  if (active?.flow === "practice") {
    await continuePracticeFlow({
      pool: ctx.pool,
      chatId,
      externalMessageId,
      text,
    });
    return;
  }
  if (active?.flow === "vault-prompt") {
    await continueVaultPromptFlow({
      pool: ctx.pool,
      chatId,
      externalMessageId,
      state: active,
      text,
    });
    return;
  }

  // Solo HN URL → distill flow.
  if (isSoloHnUrl(text)) {
    await runDistillHnFlow({
      pool: ctx.pool,
      chatId,
      externalMessageId,
      url: text.trim(),
    });
    return;
  }

  // Default → chat flow.
  await runChatFlow({
    pool: ctx.pool,
    chatId,
    externalMessageId,
    text,
  });
}

async function handleRouterError(
  ctx: RouterContext,
  chatId: string,
  err: unknown
): Promise<void> {
  console.error(`Telegram router error [chat:${chatId}]:`, err);
  const categorized = categorizeError(err);
  try {
    await sendTelegramMessage(chatId, categorized.userMessage);
  } catch {
    /* swallow */
  }
  try {
    await insertChatMessage(ctx.pool, {
      chatId,
      externalMessageId: null,
      role: "assistant",
      content: buildErrorMarkerMessage(categorized),
      flow: null,
    });
  } catch (storeErr) {
    console.error(`Telegram error-marker store failed [chat:${chatId}]:`, storeErr);
  }
}
