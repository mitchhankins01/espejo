import type { Express, Request, Response } from "express";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import {
  insertChatMessage,
  getOuraSyncRun,
  getActivityLog,
  type ActivityLogRow,
} from "../db/queries.js";
import { runAgent, forceCompact } from "./agent.js";
import {
  sendTelegramMessage,
  sendTelegramVoice,
  sendChatAction,
} from "./client.js";
import {
  transcribeVoiceMessage,
  synthesizeVoiceReply,
} from "./voice.js";
import { extractTextFromDocument, extractTextFromImage } from "./media.js";
import { setMessageHandler, processUpdate } from "./updates.js";
import type { AssembledMessage, TelegramUpdate } from "./updates.js";
import {
  startPracticeSession,
  endPracticeSession,
  isPracticeSessionActive,
  runPracticeExtraction,
} from "./practice-session.js";
import { buildSpanishPracticeSystemPrompt } from "../prompts/spanish-practice.js";

// ---------------------------------------------------------------------------
// Message handler — wires updates → agent → client
// ---------------------------------------------------------------------------

const TYPING_HEARTBEAT_MS = 4500;
const ACTIVITY_DETAIL_CALLBACK_PREFIX = "activity_detail:";

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface InlineKeyboardMarkup extends Record<string, unknown> {
  inline_keyboard: InlineKeyboardButton[][];
}

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripActivityDetailLink(activity: string): string {
  return activity
    .replace(/\s*\|\s*<a\s+href="[^"]+">details<\/a>\s*$/i, "")
    .trim();
}

function parseActivityMetric(activity: string, pattern: RegExp): number {
  const match = pattern.exec(activity);
  if (!match) return 0;
  const parsed = Number(match[1]);
  /* v8 ignore next -- defensive: regex capture is expected to be numeric */
  return Number.isFinite(parsed) ? parsed : 0;
}

function getActivitySummaryCounts(activity: string): {
  memoryCount: number;
} {
  return {
    memoryCount: parseActivityMetric(activity, /used (\d+)\s+memories/i),
  };
}

function buildActivityDetailMarkup(
  activity: string,
  activityLogId: number | null
): InlineKeyboardMarkup | undefined {
  if (!activityLogId) return undefined;
  const { memoryCount } = getActivitySummaryCounts(activity);
  if (memoryCount === 0) return undefined;

  return {
    inline_keyboard: [
      [
        {
          text: "Details",
          callback_data: `${ACTIVITY_DETAIL_CALLBACK_PREFIX}${activityLogId}:${memoryCount}:0`,
        },
      ],
    ],
  };
}

function formatActivityDetailMessage(params: {
  log: ActivityLogRow;
  hintedMemoryCount: number;
}): string {
  const memoryCount =
    params.hintedMemoryCount > 0
      ? params.hintedMemoryCount
      : params.log.memories.length;
  const createdLabel = params.log.created_at.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: config.timezone,
  });

  const lines = [
    `Activity detail #${params.log.id}`,
    `When: ${createdLabel}`,
    "",
    "Summary:",
    `  memories used: ${memoryCount}`,
    `  tool calls: ${params.log.tool_calls.length}`,
  ];

  if (params.log.cost_usd != null) {
    lines.push(`  cost: $${params.log.cost_usd.toFixed(3)}`);
  }

  if (params.log.tool_calls.length > 0) {
    const toolCounts = new Map<string, number>();
    for (const toolCall of params.log.tool_calls) {
      toolCounts.set(toolCall.name, (toolCounts.get(toolCall.name) ?? 0) + 1);
    }
    lines.push("", "Tools:");
    for (const [name, count] of [...toolCounts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${name}: ${count}`);
    }
  }

  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

function startProgressUpdates(chatId: string): () => void {
  const typingInterval = setInterval(() => {
    void sendChatAction(chatId, "typing").catch(
      /* v8 ignore next 3 -- defensive: transient network failures are non-deterministic */
      (err: unknown) => {
        console.error(`Telegram typing heartbeat error [chat:${chatId}]:`, err);
      }
    );
  }, TYPING_HEARTBEAT_MS);

  return () => {
    clearInterval(typingInterval);
  };
}

async function sendAndStoreResponse(
  chatId: string,
  text: string
): Promise<void> {
  await sendTelegramMessage(chatId, text);
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: text,
  });
}

async function handleMessage(msg: AssembledMessage): Promise<void> {
  const chatId = String(msg.chatId);

  // Ignore reactions — no longer used for soul signals
  if (msg.reactionEmoji) {
    return;
  }

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

    // Store user message. Dedup: if already stored (webhook retry after restart), skip.
    const { inserted } = await insertChatMessage(pool, {
      chatId,
      externalMessageId: String(msg.messageId),
      role: "user",
      content: text,
    });
    if (!inserted) return;

    const originalUserText = text;

    const command = parseSlashCommand(text);

    // Handle activity detail callback
    if (msg.callbackData?.startsWith(ACTIVITY_DETAIL_CALLBACK_PREFIX)) {
      try {
        const parts = msg.callbackData.split(":");
        const activityLogId = Number(parts[1]);
        const hintedMemoryCount = Number(parts[2]) || 0;

        if (!Number.isInteger(activityLogId) || activityLogId <= 0) {
          await sendTelegramMessage(chatId, "Activity detail not found.");
          return;
        }

        const log = await getActivityLog(pool, activityLogId);
        if (!log || log.chat_id !== chatId) {
          await sendTelegramMessage(chatId, `Activity run #${activityLogId} not found.`);
          return;
        }

        const detail = formatActivityDetailMessage({
          log,
          hintedMemoryCount,
        });
        await sendTelegramMessage(chatId, detail);
      } catch (err) {
        console.error(`Telegram activity_detail callback error [chat:${chatId}]:`, err);
      }
      return;
    }

    // Handle Oura sync detail callback
    if (msg.callbackData?.startsWith("oura_sync:")) {
      try {
        const parts = msg.callbackData.split(":");
        const runId = Number(parts[1]);
        /* v8 ignore next -- defensive: callback_data always has counts segment */
        const countsCsv = (parts[2] ?? "").split(",");
        const run = await getOuraSyncRun(pool, runId);
        if (!run) {
          await sendTelegramMessage(chatId, `Oura sync run #${runId} not found.`);
          return;
        }
        /* v8 ignore next 9 -- defensive: counts always present in callback_data */
        const sleep = Number(countsCsv[0]) || 0;
        const sessions = Number(countsCsv[1]) || 0;
        const readiness = Number(countsCsv[2]) || 0;
        const activity = Number(countsCsv[3]) || 0;
        const stress = Number(countsCsv[4]) || 0;
        const workouts = Number(countsCsv[5]) || 0;
        const total = sleep + sessions + readiness + activity + stress + workouts;
        const started = new Date(run.started_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: config.timezone });
        /* v8 ignore next -- defensive: finished_at may be null if run is still in progress */
        const finished = run.finished_at ? new Date(run.finished_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: config.timezone }) : "in progress";
        const errorLine = run.error ? `\nError: ${run.error}` : "";
        const detail = [
          `Oura sync #${runId}`,
          `Status: ${run.status}`,
          `Started: ${started} \u2192 finished ${finished}`,
          "",
          "Records synced:",
          `  sleep: ${sleep}`,
          `  sessions: ${sessions}`,
          `  readiness: ${readiness}`,
          `  activity: ${activity}`,
          `  stress: ${stress}`,
          `  workouts: ${workouts}`,
          `  total: ${total}`,
          errorLine,
        ].filter(Boolean).join("\n");
        await sendTelegramMessage(chatId, `<pre>${detail}</pre>`);
      } catch (err) {
        console.error(`Telegram oura_sync callback error [chat:${chatId}]:`, err);
      }
      return;
    }

    // Handle /compact command
    if (command?.name === "compact") {
      await forceCompact(chatId, async (summary) => {
        await sendAndStoreResponse(chatId, `<i>Memory note: ${summary}</i>`);
      });
      return;
    }

    // Handle /practice command — start a Spanish practice session
    if (command?.name === "practice") {
      if (isPracticeSessionActive(chatId)) {
        await sendAndStoreResponse(
          chatId,
          "Ya estamos en sesión. Envía /done para terminar primero."
        );
        return;
      }
      startPracticeSession(chatId);
      await sendAndStoreResponse(
        chatId,
        "🇪🇸 <b>Sesión de práctica iniciada.</b>\nHablamos en español. Corrijo al vuelo. Tú llevas el ritmo — yo te mantengo en movimiento.\n\n¿Cómo va el día? Cuéntame lo que tengas encima ahora mismo.\n\n<i>Cuando quieras cerrar, manda /done.</i>"
      );
      return;
    }

    // Handle /done command — end active Spanish practice session and run extraction
    if (command?.name === "done") {
      const session = endPracticeSession(chatId);
      if (!session) {
        await sendAndStoreResponse(
          chatId,
          "No hay sesión activa. /practice para empezar una."
        );
        return;
      }
      await sendAndStoreResponse(chatId, "<i>Procesando sesión…</i>");
      try {
        const result = await runPracticeExtraction(chatId, session);
        const prefix = result.wrotePersisted
          ? `✅ Estado actualizado (${result.messageCount} mensajes).\n\n`
          : `⚠️ ${result.messageCount} mensajes — estado no guardado.\n\n`;
        await sendAndStoreResponse(chatId, `${prefix}${escapeHtml(result.diffSummary)}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[practice] extraction failed [chat:${chatId}]:`, err);
        await sendAndStoreResponse(chatId, `Extraction failed: ${escapeHtml(errMsg)}`);
      }
      return;
    }

    const practiceActive = isPracticeSessionActive(chatId);
    const inputWasVoice = Boolean(msg.voice);

    const stopProgress = startProgressUpdates(chatId);
    try {
      const systemPromptOverride = practiceActive
        ? await buildSpanishPracticeSystemPrompt(pool)
        : undefined;

      const { response, activity, activityLogId } = await runAgent({
        chatId,
        message: text,
        storedUserMessage: originalUserText,
        messageDate: msg.date,
        prefill: undefined,
        systemPromptOverride,
        /* v8 ignore next 3 -- async callback tested via agent compaction tests */
        onCompacted: async (summary) => {
          await sendTelegramMessage(chatId, `<i>Memory note: ${summary}</i>`);
        },
      });

      if (!response) return;

      if (practiceActive) {
        // In practice mode: skip the activity line noise. If user spoke,
        // reply with both a voice note and the text transcript.
        if (inputWasVoice) {
          try {
            const audio = await synthesizeVoiceReply(response);
            await sendTelegramVoice(chatId, audio);
          } catch (err) {
            console.error(`[practice] voice synth failed [chat:${chatId}]:`, err);
          }
        }
        await sendTelegramMessage(chatId, response);
        return;
      }

      const cleanActivity = stripActivityDetailLink(activity);
      const activityDetailMarkup = buildActivityDetailMarkup(
        cleanActivity,
        activityLogId
      );
      const fullResponse = cleanActivity
        ? `${response}\n\n<i>${cleanActivity}</i>`
        : response;

      if (activityDetailMarkup) {
        await sendTelegramMessage(chatId, fullResponse, activityDetailMarkup);
      } else {
        await sendTelegramMessage(chatId, fullResponse);
      }
    } finally {
      stopProgress();
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
        update.callback_query?.message?.chat.id ??
        update.message_reaction?.chat.id;
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
