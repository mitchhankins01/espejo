import crypto from "crypto";
import { pool } from "../db/client.js";
import {
  getRecentMessages,
  insertChatMessage,
  logMemoryRetrieval,
  insertActivityLog,
  type PatternSearchRow,
} from "../db/queries.js";
import { buildOuraContextPrompt } from "../oura/context.js";
import { buildTodoContextPrompt } from "../todos/context.js";

import { RECENT_MESSAGES_LIMIT, normalizeContent } from "./agent/constants.js";
import { buildSystemPrompt } from "./agent/context.js";
import { maybeBuildCostActivityNote } from "./agent/costs.js";
import {
  shouldRetrievePatterns,
  retrievePatterns,
  budgetCapPatterns,
} from "./agent/language.js";
import { reconstructMessages, runToolLoop } from "./agent/tools.js";
import { compactIfNeeded } from "./agent/compaction.js";
import { PATTERN_TOKEN_BUDGET } from "./agent/constants.js";

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
  patternCount: number;
}

export async function runAgent(params: {
  chatId: string;
  message: string;
  storedUserMessage?: string;
  messageDate: number;
  prefill?: string;
  onCompacted?: (summary: string) => Promise<void>;
}): Promise<AgentResult> {
  const {
    chatId,
    message,
    storedUserMessage,
    prefill,
    onCompacted,
  } = params;

  // User message is now stored by handleMessage() in webhook.ts before calling runAgent().

  // 2. Retrieve patterns (skip for trivial messages)
  let retrievedPatterns: PatternSearchRow[] = [];
  let degraded = false;
  if (shouldRetrievePatterns(message)) {
    ({ patterns: retrievedPatterns, degraded } = await retrievePatterns(message));
  }
  const patterns = budgetCapPatterns(retrievedPatterns, PATTERN_TOKEN_BUDGET);

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
  const baseSystemPrompt = buildSystemPrompt(patterns, degraded);
  const ouraContextPrompt = await buildOuraContextPrompt(pool);
  const todoContextPrompt = await buildTodoContextPrompt(pool);
  const contextSections = [ouraContextPrompt, todoContextPrompt].filter((v) => v.length > 0);
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

  // 5. Build activity summary
  const activityParts: string[] = [];
  if (patterns.length > 0) {
    const topKinds = [...new Set(patterns.map((p) => p.kind))].slice(0, 3).join(", ");
    activityParts.push(`used ${patterns.length} memories${topKinds ? ` (${topKinds})` : ""}`);
  }
  const costNote = await maybeBuildCostActivityNote(chatId);
  if (costNote) activityParts.push(costNote);
  if (degraded) activityParts.push("memory degraded");
  if (toolCallCount > 0) activityParts.push(`${toolCallCount} tools (${toolNames.join(", ")})`);

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

  if (!text) return { response: null, activity, activityLogId, patternCount: patterns.length };

  // 6. Store assistant response
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: text,
  });

  // 7. Trigger compaction asynchronously
  /* v8 ignore next 3 -- async compaction error: tested via compactIfNeeded unit tests */
  void compactIfNeeded(chatId, onCompacted).catch((err) => {
    console.error(`Telegram compaction error [chat:${chatId}]:`, err);
  });

  return { response: text, activity, activityLogId, patternCount: patterns.length };
}

// Need config for activity detail URL building
import { config } from "../config.js";
