import type { Express, Request, Response } from "express";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import {
  getSoulState,
  getSoulQualityStats,
  getLastAssistantMessageId,
  insertSoulQualitySignal,
  getLastPulseCheck,
  getRetentionByInterval,
  getVocabularyFunnel,
  getGradeTrend,
  getLapseRateTrend,
  getSpanishQuizStats,
  getSpanishAdaptiveContext,
  getLatestSpanishAssessment,
} from "../db/queries.js";
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
  buildMorningKickoffMessage,
  type AgentMode,
} from "./evening-review.js";
import {
  buildRetentionSummary,
  buildFunnelSummary,
  buildTrendSummary,
  buildAssessmentSummary,
  formatDigestText,
  type SpanishDigest,
} from "../spanish/analytics.js";
import {
  assessSpanishQuality,
  createOpenAIAssessmentClient,
} from "../spanish/assessment.js";

// ---------------------------------------------------------------------------
// Message handler — wires updates → agent → client
// ---------------------------------------------------------------------------

const MAX_TEXT_MESSAGE_VOICE_CHARS = 260;
const chatModes = new Map<string, AgentMode>();
const MODE_DISABLE_TOKENS = new Set(["off", "stop", "end", "done", "exit"]);
const chatMessageCounters = new Map<string, number>();

const SOUL_FEEDBACK_BUTTONS = {
  inline_keyboard: [
    [
      { text: "\u2728 Feels like you", callback_data: "soul:personal" },
      { text: "\uD83D\uDE10 Felt generic", callback_data: "soul:generic" },
    ],
  ],
};

function shouldAttachFeedbackButtons(chatId: string): boolean {
  if (!config.telegram.soulEnabled) return false;
  const count = (chatMessageCounters.get(chatId) ?? 0) + 1;
  chatMessageCounters.set(chatId, count);
  const every = Math.max(1, config.telegram.soulFeedbackEvery);
  return count % every === 0;
}

/** Visible for testing only. */
export function clearFeedbackCounters(): void {
  chatMessageCounters.clear();
}

function parseSlashCommand(
  text: string
): { name: string; argText: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const commandPart = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const argText = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const rawName = commandPart.slice(1).split("@")[0].toLowerCase();
  const name = rawName === "evenning" ? "evening" : rawName;
  if (!name) return null;

  return { name, argText };
}

type EveningIntent =
  | { type: "enable"; seed: string | null }
  | { type: "disable" };

function parseNaturalEveningIntent(text: string): EveningIntent | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;

  const normalized = trimmed.toLowerCase();
  const eveningPhrase =
    /evening\s+(review|check[-\s]?in)/i;

  if (
    /\b(?:stop|end|disable|exit|turn off)\s+(?:the\s+)?evening\s+(?:review|check[-\s]?in)\b/i.test(
      normalized
    ) ||
    /\bevening\s+(?:review|check[-\s]?in)\s+(?:off|stop|end|done|exit)\b/i.test(
      normalized
    )
  ) {
    return { type: "disable" };
  }

  const phraseMatch = eveningPhrase.exec(trimmed);
  if (!phraseMatch) return null;

  const isExact = /^(?:evening review|evening check[-\s]?in)$/i.test(trimmed);
  const hasActivationHint =
    /\b(?:let'?s|lets|start|begin|do|run|can we|time for|switch to|activate|now|ahora|por favor|please)\b/i.test(
      normalized
    );

  if (!isExact && !hasActivationHint) return null;

  let seed = trimmed
    .slice(phraseMatch.index + phraseMatch[0].length)
    .replace(/^[\s:,\-–—]+/, "")
    .trim();

  if (/^(now|ahora|please|pls)$/i.test(seed)) {
    seed = "";
  }

  return {
    type: "enable",
    seed: seed || null,
  };
}

type MorningIntent =
  | { type: "enable"; seed: string | null }
  | { type: "disable" };

function parseNaturalMorningIntent(text: string): MorningIntent | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;

  const normalized = trimmed.toLowerCase();
  const morningPhrase =
    /morning\s+(flow|check[-\s]?in)/i;

  if (
    /\b(?:stop|end|disable|exit|turn off)\s+(?:the\s+)?morning\s+(?:flow|check[-\s]?in)\b/i.test(
      normalized
    ) ||
    /\bmorning\s+(?:flow|check[-\s]?in)\s+(?:off|stop|end|done|exit)\b/i.test(
      normalized
    )
  ) {
    return { type: "disable" };
  }

  const phraseMatch = morningPhrase.exec(trimmed);
  if (!phraseMatch) return null;

  const isExact = /^(?:morning flow|morning check[-\s]?in)$/i.test(trimmed);
  const hasActivationHint =
    /\b(?:let'?s|lets|start|begin|do|run|can we|time for|switch to|activate|now|ahora|por favor|please)\b/i.test(
      normalized
    );

  if (!isExact && !hasActivationHint) return null;

  let seed = trimmed
    .slice(phraseMatch.index + phraseMatch[0].length)
    .replace(/^[\s:,\-–—]+/, "")
    .trim();

  if (/^(now|ahora|please|pls)$/i.test(seed)) {
    seed = "";
  }

  return {
    type: "enable",
    seed: seed || null,
  };
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

const POSITIVE_REACTION_EMOJIS = new Set(["👍", "❤️", "🔥", "👏", "🎉", "💯", "⚡", "🫡"]);
const NEGATIVE_REACTION_EMOJIS = new Set(["👎", "💩"]);

async function handleMessage(msg: AssembledMessage): Promise<void> {
  const chatId = String(msg.chatId);

  // Handle message reactions — log as soul quality signal, no typing indicator
  if (msg.reactionEmoji) {
    const emoji = msg.reactionEmoji;
    const isPositive = POSITIVE_REACTION_EMOJIS.has(emoji);
    const isNegative = NEGATIVE_REACTION_EMOJIS.has(emoji);
    if ((isPositive || isNegative) && config.telegram.soulEnabled) {
      try {
        const soulState = await getSoulState(pool, chatId);
        await insertSoulQualitySignal(pool, {
          chatId,
          assistantMessageId: null,
          signalType: isPositive ? "positive_reaction" : "felt_generic",
          soulVersion: soulState?.version ?? 0,
          patternCount: 0,
          metadata: { source: "reaction", emoji },
        });
      } catch (err) {
        console.error(`Telegram reaction signal error [chat:${chatId}]:`, err);
      }
    }
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
    const originalUserText = text;

    const command = parseSlashCommand(text);
    const naturalEveningIntent = parseNaturalEveningIntent(text);
    const naturalMorningIntent = parseNaturalMorningIntent(text);

    // Handle soul feedback callbacks (soul:personal, soul:generic)
    if (msg.callbackData?.startsWith("soul:")) {
      const signalType = msg.callbackData === "soul:personal" ? "felt_personal" : "felt_generic";
      try {
        const assistantMsgId = await getLastAssistantMessageId(pool, chatId);
        const soulState = await getSoulState(pool, chatId);
        await insertSoulQualitySignal(pool, {
          chatId,
          assistantMessageId: assistantMsgId,
          signalType,
          soulVersion: soulState?.version ?? 0,
          patternCount: 0,
          metadata: { source: "inline_button" },
        });
        const ack = signalType === "felt_personal" ? "\u2728 Noted \u2014 thanks!" : "\uD83D\uDE10 Noted \u2014 I\u2019ll work on that.";
        await sendTelegramMessage(chatId, `<i>${ack}</i>`);
      } catch (err) {
        console.error(`Telegram soul feedback error [chat:${chatId}]:`, err);
      }
      return;
    }

    // Handle /compact command
    if (command?.name === "compact") {
      await forceCompact(chatId, async (summary) => {
        await sendTelegramMessage(chatId, `<i>Memory note: ${summary}</i>`);
      });
      return;
    }

    // Handle /soul command — show soul state + quality stats + pulse
    if (command?.name === "soul") {
      try {
        const soulState = await getSoulState(pool, chatId);
        const stats = await getSoulQualityStats(pool, chatId);
        const lastPulse = await getLastPulseCheck(pool, chatId);
        const lines: string[] = [];
        if (soulState) {
          lines.push(`\uD83E\uDE9E <b>Soul State</b> (v${soulState.version})\n`);
          if (soulState.identity_summary) {
            lines.push(`<b>Identity:</b> ${soulState.identity_summary}`);
          }
          if (soulState.relational_commitments.length > 0) {
            lines.push(`<b>Commitments:</b> ${soulState.relational_commitments.join(", ")}`);
          }
          if (soulState.tone_signature.length > 0) {
            lines.push(`<b>Tone:</b> ${soulState.tone_signature.join(", ")}`);
          }
          if (soulState.growth_notes.length > 0) {
            lines.push(`<b>Growth:</b> ${soulState.growth_notes.join("; ")}`);
          }
        } else {
          lines.push("\uD83E\uDE9E <b>Soul State</b>\n");
          lines.push("No soul state yet. Keep chatting \u2014 it evolves over time.");
        }
        if (stats.total > 0) {
          lines.push("");
          lines.push("<b>Quality (last 30 days):</b>");
          lines.push(`  \u2728 Felt personal: ${stats.felt_personal}`);
          lines.push(`  \uD83D\uDE10 Felt generic: ${stats.felt_generic}`);
          lines.push(`  \uD83D\uDD27 Corrections: ${stats.correction}`);
          lines.push(`  \uD83D\uDC4D Reactions: ${stats.positive_reaction}`);
          const pct = Math.round(stats.personal_ratio * 100);
          lines.push(`  Personal ratio: ${pct}%`);
        }
        if (lastPulse) {
          const statusEmoji = {
            healthy: "\uD83D\uDFE2",
            drifting: "\uD83D\uDFE1",
            stale: "\u26AA",
            overcorrecting: "\uD83D\uDFE0",
          }[lastPulse.status] ?? "\u2753";
          const ago = Math.round(
            (Date.now() - lastPulse.created_at.getTime()) / (1000 * 60 * 60)
          );
          lines.push("");
          lines.push(`<b>Pulse:</b> ${statusEmoji} ${lastPulse.status} (${ago}h ago)`);
          if (lastPulse.repairs_applied.length > 0) {
            lines.push(`  Repairs: ${lastPulse.repairs_applied.length} applied`);
          }
        }
        await sendTelegramMessage(chatId, lines.join("\n"));
      } catch (err) {
        console.error(`Telegram /soul error [chat:${chatId}]:`, err);
        await sendTelegramMessage(chatId, "Error loading soul state.");
      }
      return;
    }

    // Handle /digest command — Spanish learning progress summary
    if (command?.name === "digest") {
      try {
        const days = 30;
        const [stats, adaptive, retention, funnel, grades, lapses, latestAssessment] =
          await Promise.all([
            getSpanishQuizStats(pool, chatId),
            getSpanishAdaptiveContext(pool, chatId),
            getRetentionByInterval(pool, chatId),
            getVocabularyFunnel(pool, chatId),
            getGradeTrend(pool, chatId, days),
            getLapseRateTrend(pool, chatId, days),
            getLatestSpanishAssessment(pool, chatId),
          ]);

        const digest: SpanishDigest = {
          period_label: `last ${days} days`,
          stats,
          adaptive,
          retention_summary: buildRetentionSummary(retention),
          funnel_summary: buildFunnelSummary(funnel),
          trend_summary: buildTrendSummary(grades, lapses),
          assessment_summary: buildAssessmentSummary(latestAssessment),
        };

        await sendTelegramMessage(chatId, formatDigestText(digest));
      } catch (err) {
        console.error(`Telegram /digest error [chat:${chatId}]:`, err);
        await sendTelegramMessage(chatId, "Error generating digest.");
      }
      return;
    }

    // Handle /assess command — LLM-as-judge Spanish quality assessment
    if (command?.name === "assess") {
      try {
        await sendChatAction(chatId, "typing");
        const OpenAI = (await import("openai")).default;
        const openai = new OpenAI({ apiKey: config.openai.apiKey });
        const client = createOpenAIAssessmentClient(openai);
        const { summary } = await assessSpanishQuality(pool, chatId, client);
        await sendTelegramMessage(chatId, summary);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Telegram /assess error [chat:${chatId}]:`, errMsg);
        await sendTelegramMessage(chatId, `Assessment error: ${errMsg}`);
      }
      return;
    }

    // Handle /compose command
    let prefill: string | undefined;
    if (command?.name === "compose") {
      text = "Write the entry now.";
      prefill = "#";
    }

    // Handle /evening command
    if (command?.name === "evening") {
      const firstArg = command.argText.split(/\s+/)[0].toLowerCase();
      if (MODE_DISABLE_TOKENS.has(firstArg)) {
        chatModes.delete(chatId);
        await sendTelegramMessage(chatId, "<i>Evening review mode off.</i>");
        return;
      }

      chatModes.set(chatId, "evening_review");
      text = buildEveningKickoffMessage(command.argText || null);
    } else if (naturalEveningIntent?.type === "disable") {
      chatModes.delete(chatId);
      await sendTelegramMessage(chatId, "<i>Evening review mode off.</i>");
      return;
    } else if (naturalEveningIntent?.type === "enable") {
      chatModes.set(chatId, "evening_review");
      text = buildEveningKickoffMessage(naturalEveningIntent.seed);
    }

    // Handle /morning command
    if (command?.name === "morning") {
      const firstArg = command.argText.split(/\s+/)[0].toLowerCase();
      if (MODE_DISABLE_TOKENS.has(firstArg)) {
        chatModes.delete(chatId);
        await sendTelegramMessage(chatId, "<i>Morning flow mode off.</i>");
        return;
      }

      chatModes.set(chatId, "morning_flow");
      text = buildMorningKickoffMessage(command.argText || null);
    } else if (naturalMorningIntent?.type === "disable") {
      chatModes.delete(chatId);
      await sendTelegramMessage(chatId, "<i>Morning flow mode off.</i>");
      return;
    } else if (naturalMorningIntent?.type === "enable") {
      chatModes.set(chatId, "morning_flow");
      text = buildMorningKickoffMessage(naturalMorningIntent.seed);
    }

    const { response, activity } = await runAgent({
      chatId,
      message: text,
      storedUserMessage: originalUserText,
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

      // Determine if we should attach soul feedback buttons
      const attachButtons = shouldAttachFeedbackButtons(chatId);
      const replyMarkup = attachButtons ? SOUL_FEEDBACK_BUTTONS : undefined;

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

      if (replyMarkup) {
        await sendTelegramMessage(chatId, fullResponse, replyMarkup);
      } else {
        await sendTelegramMessage(chatId, fullResponse);
      }
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
