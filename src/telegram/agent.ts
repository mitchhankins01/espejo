import { pool } from "../db/client.js";
import {
  getRecentMessages,
  insertChatMessage,
  insertActivityLog,
} from "../db/queries.js";
import { buildOuraContextPrompt } from "../oura/context.js";

import { RECENT_MESSAGES_LIMIT } from "./agent/constants.js";
import { buildSystemPrompt } from "./agent/context.js";
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
}

export async function runAgent(params: {
  chatId: string;
  message: string;
  storedUserMessage?: string;
  messageDate: number;
  prefill?: string;
  systemPromptOverride?: string;
  onCompacted?: (summary: string) => Promise<void>;
}): Promise<AgentResult> {
  const {
    chatId,
    message,
    storedUserMessage,
    prefill,
    systemPromptOverride,
    onCompacted,
  } = params;

  // User message is now stored by handleMessage() in webhook.ts before calling runAgent().

  // 2. Build context
  let systemPrompt: string;
  if (systemPromptOverride) {
    systemPrompt = systemPromptOverride;
  } else {
    const baseSystemPrompt = buildSystemPrompt();
    const ouraContextPrompt = await buildOuraContextPrompt(pool);
    const contextSections = [ouraContextPrompt].filter((v) => v.length > 0);
    systemPrompt = contextSections.length > 0
      ? `${baseSystemPrompt}\n\n${contextSections.join("\n\n")}`
      : baseSystemPrompt;
  }
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

  // 3. Run tool loop
  const { text, toolCallCount, toolNames, toolCalls } = await runToolLoop(systemPrompt, messages, chatId, prefill);

  // 4. Build activity summary
  const activityParts: string[] = [];
  if (toolCallCount > 0) activityParts.push(`${toolCallCount} tools (${toolNames.join(", ")})`);

  // 4b. Store activity log
  let activityLogId: number | null = null;
  if (toolCalls.length > 0) {
    try {
      const activityLog = await insertActivityLog(pool, {
        chatId,
        memories: [],
        toolCalls,
        costUsd: null,
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

  if (!text) return { response: null, activity, activityLogId };

  // 5. Store assistant response
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: text,
  });

  // 6. Trigger compaction asynchronously
  /* v8 ignore next 3 -- async compaction error: tested via compactIfNeeded unit tests */
  void compactIfNeeded(chatId, onCompacted).catch((err) => {
    console.error(`Telegram compaction error [chat:${chatId}]:`, err);
  });

  return { response: text, activity, activityLogId };
}

// Need config for activity detail URL building
import { config } from "../config.js";
