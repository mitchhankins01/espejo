import type pg from "pg";
import type { AssembledMessage } from "./updates.js";
import { processScreenTimePhotos } from "./screen-time.js";
import { sendTelegramMessage } from "./client.js";
import { transcribeVoiceMessage } from "./voice.js";
import { extractTextFromDocument, extractTextFromImage } from "./media.js";
import { categorizeError, buildErrorMarkerMessage } from "./error-handling.js";
import { insertChatMessage, resetChatSession } from "../db/queries/chat.js";
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
  startSrsFlow,
  endSrsFlow,
  handleSrsCallback,
  handleSrsProse,
} from "./flows/srs.js";
import {
  startConjFlow,
  continueConjFlow,
  endConjFlow,
  handleConjCallback,
} from "./flows/conj.js";
import { parseSrsCallback } from "./srs-callbacks.js";
import { parseConjCallback } from "./conj-callbacks.js";
import { runChatFlow } from "./flows/chat.js";
import { resolveButtonLabel } from "./keyboard.js";

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
  "c",
  "weight",
  "srs",
  "conj",
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

  // Intercept structured callback payloads before they hit slash parsing.
  // SRS uses `srs:show:<id>` and `srs:rate:<id>:<grade>`; the router parses
  // any other callback text as a regular message below.
  if (msg.callbackData) {
    const srsCb = parseSrsCallback(msg.callbackData);
    if (srsCb) {
      await handleSrsCallback({
        pool: ctx.pool,
        chatId,
        externalMessageId,
        messageId: msg.messageId,
        callback: srsCb,
      });
      return;
    }
    const conjCb = parseConjCallback(msg.callbackData);
    if (conjCb) {
      await handleConjCallback({
        pool: ctx.pool,
        chatId,
        externalMessageId,
        messageId: msg.messageId,
        callback: conjCb,
      });
      return;
    }
  }

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
      const caption = (msg.text ?? "").trim();
      const transcription = (
        await transcribeVoiceMessage(
          msg.voice.fileId,
          msg.voice.durationSeconds,
          msg.voice.fileName
        )
      ).trim();
      if (!transcription && !caption) {
        await sendTelegramMessage(
          chatId,
          "I couldn't transcribe that audio — try again or type it."
        );
        return;
      }
      text = [caption, transcription].filter(Boolean).join("\n\n");
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
  const { chatId, externalMessageId } = args;
  // A persistent-keyboard tap arrives as the exact button label. Rewrite it
  // to the synthetic slash it stands for so it reuses the normal command
  // dispatch below (soft-block for srs/conj, flow-clear for checkpoint, etc).
  const buttonCommand = resolveButtonLabel(args.text);
  const text = buttonCommand ? `/${buttonCommand}` : args.text;
  const command = parseSlashCommand(text);
  const active = getFlow(chatId);

  // Registered slashes always reset state and dispatch.
  if (command && REGISTERED_SLASHES.has(command.name)) {
    if (END_FLOW_ALIASES.has(command.name)) {
      // /done /end /fin /cancel etc. Peek the active flow first — each
      // close handler clears state, so dispatching to the wrong one would
      // wipe the flow before its real close handler runs.
      const peek = getFlow(chatId);
      if (peek?.flow === "srs") {
        await endSrsFlow({ pool: ctx.pool, chatId, externalMessageId });
        return;
      }
      if (peek?.flow === "conj") {
        await endConjFlow({ pool: ctx.pool, chatId, externalMessageId });
        return;
      }
      if (peek) {
        clearFlow(chatId);
        await sendTelegramMessage(chatId, "Sesión cerrada.");
        return;
      }
      // Nothing structured active → /done clears the free-chat thread by
      // writing a session boundary; the next message starts with empty context.
      const closed = await resetChatSession(ctx.pool, chatId, "chat");
      await sendTelegramMessage(
        chatId,
        closed > 0 ? "Listo, empezamos de cero. 🌊" : "Ya estábamos de cero."
      );
      return;
    }
    // /srs soft-blocks if any flow is active — handle BEFORE the swap-clear
    // below so the active flow is visible to startSrsFlow.
    if (command.name === "srs") {
      await startSrsFlow({
        pool: ctx.pool,
        chatId,
        externalMessageId,
        argText: command.argText,
      });
      return;
    }
    // /conj behaves the same way: soft-block on active flow, so dispatch
    // BEFORE the swap-clear below.
    if (command.name === "conj") {
      await startConjFlow({
        pool: ctx.pool,
        chatId,
        externalMessageId,
        argText: command.argText,
      });
      return;
    }
    // Other registered slashes — clear any active flow.
    if (active) clearFlow(chatId);
    if (command.name === "checkpoint" || command.name === "c") {
      await startCheckpointFlow(
        { pool: ctx.pool, chatId, externalMessageId },
        command.argText
      );
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
    return;
  }

  if (command && !REGISTERED_SLASHES.has(command.name) && !active) {
    await sendTelegramMessage(
      chatId,
      "Unknown command — try /c (or /checkpoint) /weight /srs /conj."
    );
    return;
  }

  // Conj: typed answers, /hint, /easy, and unknown slashes are all routed
  // to the flow's continue handler before SRS's prose nudge fires.
  if (active?.flow === "conj") {
    await continueConjFlow({
      pool: ctx.pool,
      chatId,
      externalMessageId,
      text,
    });
    return;
  }

  // SRS only accepts button taps + /done; prose gets nudged back.
  if (active?.flow === "srs") {
    await handleSrsProse({ pool: ctx.pool, chatId, externalMessageId });
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
