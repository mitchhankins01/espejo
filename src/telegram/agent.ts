import crypto from "crypto";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import {
  getRecentMessages,
  getSoulState,
  upsertSoulState,
  insertChatMessage,
  logMemoryRetrieval,
  insertActivityLog,
  insertSoulQualitySignal,
  getSoulQualityStats,
  type PatternSearchRow,
} from "../db/queries.js";
import { buildOuraContextPrompt } from "../oura/context.js";
import { buildTodoContextPrompt } from "../todos/context.js";
import { evolveSoulState } from "./soul.js";
import type { AgentMode } from "./evening-review.js";

import { RECENT_MESSAGES_LIMIT, normalizeContent } from "./agent/constants.js";
import { buildSystemPrompt, toSoulSnapshot, buildSpanishContextPrompt } from "./agent/context.js";
import { maybeBuildCostActivityNote } from "./agent/costs.js";
import {
  shouldRetrievePatterns,
  retrievePatterns,
  retrieveLanguagePreferenceAnchors,
  mergePromptPatterns,
  shouldRewriteForLanguagePreference,
  rewriteWithLanguagePreference,
  autoLogSpanishVocabulary,
} from "./agent/language.js";
import { reconstructMessages, runToolLoop } from "./agent/tools.js";
import { compactIfNeeded } from "./agent/compaction.js";

// Re-export public API from submodules
export { truncateToolResult } from "./agent/truncation.js";
export { compactIfNeeded, forceCompact } from "./agent/compaction.js";

// ---------------------------------------------------------------------------
// Main agent entry point
// ---------------------------------------------------------------------------

export interface AgentResult {
  response: string | null;
  activity: string;
  activityLogId: number | null;
  soulVersion: number;
  patternCount: number;
}

export async function runAgent(params: {
  chatId: string;
  message: string;
  storedUserMessage?: string;
  messageDate: number;
  mode?: AgentMode;
  prefill?: string;
  onCompacted?: (summary: string) => Promise<void>;
}): Promise<AgentResult> {
  const {
    chatId,
    message,
    storedUserMessage,
    mode = "default",
    prefill,
    onCompacted,
  } = params;

  // User message is now stored by handleMessage() in webhook.ts before calling runAgent().

  let autoLoggedVocabulary = 0;
  try {
    autoLoggedVocabulary = await autoLogSpanishVocabulary(chatId, message);
  } catch (err) {
    console.error(`Telegram spanish auto-log error [chat:${chatId}]:`, err);
  }

  // 2. Retrieve patterns (skip for trivial messages)
  let retrievedPatterns: PatternSearchRow[] = [];
  let degraded = false;
  if (shouldRetrievePatterns(message)) {
    ({ patterns: retrievedPatterns, degraded } = await retrievePatterns(message));
  }
  const languageAnchors = await retrieveLanguagePreferenceAnchors();
  const patterns = mergePromptPatterns(retrievedPatterns, languageAnchors);

  if (shouldRetrievePatterns(message)) {
    await logMemoryRetrieval(pool, {
      chatId,
      queryText: message,
      queryHash: crypto.createHash("sha256").update(normalizeContent(message)).digest("hex"),
      degraded,
      patternIds: retrievedPatterns.map((p) => p.id),
      patternKinds: retrievedPatterns.map((p) => p.kind),
      topScore: retrievedPatterns[0]?.score ?? null,
    });
  }

  // 3. Build context
  const persistedSoulState = config.telegram.soulEnabled
    ? await getSoulState(pool, chatId)
    : null;
  const baseSystemPrompt = buildSystemPrompt(
    patterns,
    degraded,
    toSoulSnapshot(persistedSoulState),
    mode
  );
  const spanishContextPrompt = await buildSpanishContextPrompt(chatId);
  const ouraContextPrompt = await buildOuraContextPrompt(pool);
  const todoContextPrompt = await buildTodoContextPrompt(pool);
  const contextSections = [spanishContextPrompt, ouraContextPrompt, todoContextPrompt].filter((v) => v.length > 0);
  const systemPrompt = contextSections.length > 0
    ? `${baseSystemPrompt}\n\n${contextSections.join("\n\n")}`
    : baseSystemPrompt;
  const recentMessages = await getRecentMessages(pool, chatId, RECENT_MESSAGES_LIMIT);
  const messages = reconstructMessages(recentMessages);
  // Allow command handlers to persist the raw user command while still
  // steering the current model turn with a transformed prompt message.
  if (storedUserMessage && storedUserMessage !== message) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content === storedUserMessage) {
        messages[i].content = message;
        break;
      }
    }
  }

  // 4. Run tool loop
  const { text, toolCallCount, toolNames, toolCalls } = await runToolLoop(systemPrompt, messages, chatId, prefill);
  const finalText =
    text && shouldRewriteForLanguagePreference(mode, message, text, patterns, !!spanishContextPrompt)
      ? await rewriteWithLanguagePreference(message, text)
      : text;

  // 5. Build activity summary
  const soulVersion = persistedSoulState?.version ?? 0;
  const activityParts: string[] = [];
  if (patterns.length > 0) {
    const topKinds = [...new Set(patterns.map((p) => p.kind))].slice(0, 3).join(", ");
    activityParts.push(`used ${patterns.length} memories${topKinds ? ` (${topKinds})` : ""}`);
  }
  const costNote = await maybeBuildCostActivityNote(chatId);
  if (costNote) activityParts.push(costNote);
  if (degraded) activityParts.push("memory degraded");
  if (toolCallCount > 0) activityParts.push(`${toolCallCount} tools (${toolNames.join(", ")})`);
  if (autoLoggedVocabulary > 0) {
    activityParts.push(`logged ${autoLoggedVocabulary} spanish terms`);
  }

  // Include soul quality ratio when enough signals exist
  if (config.telegram.soulEnabled) {
    try {
      const stats = await getSoulQualityStats(pool, chatId);
      if (stats.total >= 5) {
        const pct = Math.round(stats.personal_ratio * 100);
        activityParts.push(`soul v${soulVersion} (${pct}% personal)`);
      }
    } catch {
      /* v8 ignore next -- non-critical: quality stats are best-effort */
    }
  }

  // 5b. Store activity log
  let activityLogId: number | null = null;
  if (patterns.length > 0 || toolCalls.length > 0) {
    try {
      const activityLog = await insertActivityLog(pool, {
        chatId,
        memories: patterns.map((p) => ({
          id: p.id,
          content: p.content,
          kind: p.kind,
          confidence: p.confidence,
          score: p.score,
        })),
        toolCalls,
        /* v8 ignore next -- best-effort cost parsing from activity note */
        costUsd: costNote ? parseFloat(costNote.match(/\$([0-9.]+)/)?.[1] ?? "0") : null,
      });
      activityLogId = activityLog.id;
      /* v8 ignore next 3 -- non-critical: activity logging is best-effort */
    } catch (err) {
      console.error(`Telegram activity log error [chat:${chatId}]:`, err);
    }
  }

  if (activityLogId && config.server.appUrl) {
    const detailUrl = config.server.mcpSecret
      ? `${config.server.appUrl}/api/activity/${activityLogId}?token=${config.server.mcpSecret}`
      : `${config.server.appUrl}/api/activity/${activityLogId}`;
    activityParts.push(`<a href="${detailUrl}">details</a>`);
  }

  const activity = activityParts.join(" | ");

  if (!finalText) return { response: null, activity, activityLogId, soulVersion, patternCount: patterns.length };

  // 6. Store assistant response
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: finalText,
  });

  // 7. Persist evolving soul state + log correction signal
  if (config.telegram.soulEnabled) {
    try {
      const nextSoulState = evolveSoulState(
        toSoulSnapshot(persistedSoulState),
        message
      );
      if (nextSoulState) {
        const updatedSoul = await upsertSoulState(pool, {
          chatId,
          identitySummary: nextSoulState.identitySummary,
          relationalCommitments: nextSoulState.relationalCommitments,
          toneSignature: nextSoulState.toneSignature,
          growthNotes: nextSoulState.growthNotes,
        });
        // Log implicit correction signal — user message triggered soul evolution
        await insertSoulQualitySignal(pool, {
          chatId,
          assistantMessageId: null,
          signalType: "correction",
          soulVersion: updatedSoul.version,
          patternCount: patterns.length,
          metadata: { source: "implicit_correction" },
        });
      }
    } catch (err) {
      console.error(`Telegram soul persistence error [chat:${chatId}]:`, err);
    }
  }

  // 8. Trigger compaction asynchronously
  /* v8 ignore next 3 -- async compaction error: tested via compactIfNeeded unit tests */
  void compactIfNeeded(chatId, onCompacted).catch((err) => {
    console.error(`Telegram compaction error [chat:${chatId}]:`, err);
  });

  return { response: finalText, activity, activityLogId, soulVersion, patternCount: patterns.length };
}
