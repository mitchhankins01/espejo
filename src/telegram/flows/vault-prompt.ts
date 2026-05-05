import type pg from "pg";
import type { ModelMessage } from "ai";
import { config } from "../../config.js";
import { insertChatMessage } from "../../db/queries/chat.js";
import {
  insertActivityLog,
  type ActivityLogToolCall,
} from "../../db/queries/observability.js";
import { logUsage } from "../../db/queries/usage.js";
import {
  sendTelegramMessageReturningId,
  createStreamEditor,
  editTelegramMessageText,
  sendTelegramMessage,
} from "../client.js";
import { chat } from "../../llm/index.js";
import { buildFlowTools } from "./tool-catalog.js";
import { truncateToolResult } from "../truncation.js";
import {
  setFlow,
  clearFlow,
  type VaultPromptFlowState,
} from "../flow-state.js";
import { createClient, getObjectContent } from "../../storage/r2.js";

const FLOW_NAME = "vault-prompt";
const VAULT_BUCKET = "artifacts";
const MAX_STEPS = 15;
const MAX_TOKENS = 4096;

export interface VaultPromptDef {
  sourcePath: string;
  model: string;
}

export const VAULT_PROMPTS: Record<string, VaultPromptDef> = {
  hilo: {
    sourcePath: "Prompt/Spanish/Hilo.md",
    model: "claude-sonnet-4-6",
  },
  evening: {
    sourcePath: "Prompt/Review/Evening.md",
    model: "claude-sonnet-4-6",
  },
};

export function isVaultPromptCommand(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(VAULT_PROMPTS, name);
}

const PROMPT_PREAMBLE =
  "You are running this prompt via Telegram. Your output renders as Telegram HTML.\n" +
  "Formatting rules — these OVERRIDE anything the prompt body says about markdown:\n" +
  "- Emphasis: only <i>text</i> for italic and <b>text</b> for bold. NEVER use *text*, _text_, **text**, __text__, or backtick code spans for emphasis — Telegram shows them as literal asterisks/underscores/backticks.\n" +
  "- Section breaks: use a blank line. NEVER use --- or *** or === as horizontal rules — they render as literal three-dashes/asterisks/equals in the chat.\n" +
  "- Headings: NEVER use #, ##, ### markdown headings. Use a short <b>label</b> on its own line for section labels.\n" +
  "- Lists: use plain line breaks with leading 'em dash + space' or 'bullet + space' if you really need a list. NEVER use markdown - or * or 1. list syntax.\n" +
  "- Code: only use a fenced code block when the content really is code; never wrap prose in backticks.\n" +
  "- Write the response in Spanish unless the prompt body specifies otherwise; do not preface in English (no 'Good, I have everything I need' or similar).\n" +
  "- Use the read tools for context and `write_vault_artifact` for vault writes; if a write fails, fall back to printing the file content in chat with a note to paste manually.";

function stripFrontmatter(body: string): string {
  if (!body.startsWith("---")) return body;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return body;
  const after = body.slice(end + 4);
  return after.replace(/^\s*\n/, "");
}

async function loadPromptBody(
  pool: pg.Pool,
  sourcePath: string
): Promise<string | null> {
  const result = await pool.query<{ body: string }>(
    `SELECT body FROM knowledge_artifacts
     WHERE source_path = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [sourcePath]
  );
  if (result.rows[0]) return result.rows[0].body;
  try {
    const content = await getObjectContent(createClient(), VAULT_BUCKET, sourcePath);
    return stripFrontmatter(content);
  } catch {
    return null;
  }
}

function dateLine(): string {
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
  return `Today is ${today}. Timezone: ${config.timezone}.`;
}

export async function startVaultPromptFlow(params: {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
  name: string;
  rawText: string;
}): Promise<void> {
  const { pool, chatId, externalMessageId, name, rawText } = params;
  const def = VAULT_PROMPTS[name];
  if (!def) {
    await sendTelegramMessage(chatId, `Unknown vault prompt: /${name}`);
    return;
  }

  await insertChatMessage(pool, {
    chatId,
    externalMessageId,
    role: "user",
    content: rawText,
    flow: FLOW_NAME,
  });

  const body = await loadPromptBody(pool, def.sourcePath);
  if (!body) {
    const reply = `Couldn't load ${def.sourcePath} from vault. Run /sync_obsidian and retry.`;
    await sendTelegramMessage(chatId, reply);
    await insertChatMessage(pool, {
      chatId,
      externalMessageId: null,
      role: "assistant",
      content: reply,
      flow: FLOW_NAME,
    });
    return;
  }

  const state: VaultPromptFlowState = {
    flow: "vault-prompt",
    name,
    conversation: [],
    startedAt: Date.now(),
  };
  setFlow(chatId, state);

  await runVaultPromptTurn({
    pool,
    chatId,
    state,
    promptBody: body,
    model: def.model,
    userText: "",
  });
}

export async function continueVaultPromptFlow(params: {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
  state: VaultPromptFlowState;
  text: string;
}): Promise<void> {
  const { pool, chatId, externalMessageId, state, text } = params;
  const def = VAULT_PROMPTS[state.name];
  if (!def) {
    clearFlow(chatId);
    return;
  }

  await insertChatMessage(pool, {
    chatId,
    externalMessageId,
    role: "user",
    content: text,
    flow: FLOW_NAME,
  });

  const body = await loadPromptBody(pool, def.sourcePath);
  if (!body) {
    clearFlow(chatId);
    await sendTelegramMessage(chatId, "Vault prompt body unavailable; ending session.");
    return;
  }

  state.conversation.push({ role: "user", content: text });
  setFlow(chatId, state);

  await runVaultPromptTurn({
    pool,
    chatId,
    state,
    promptBody: body,
    model: def.model,
    userText: text,
  });
}

async function runVaultPromptTurn(params: {
  pool: pg.Pool;
  chatId: string;
  state: VaultPromptFlowState;
  promptBody: string;
  model: string;
  userText: string;
}): Promise<void> {
  const { pool, chatId, state, promptBody, model, userText } = params;
  const startedAt = Date.now();
  const system = `${dateLine()}\n\n${PROMPT_PREAMBLE}\n\n${promptBody}`;

  const messages: ModelMessage[] = state.conversation.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  if (userText.length === 0 && messages.length === 0) {
    // First turn — kick off with explicit "Begin." marker
    messages.push({ role: "user", content: "Begin." });
  }

  const seedMessageId = await sendTelegramMessageReturningId(chatId, "…");
  const editor = seedMessageId != null ? createStreamEditor(chatId, seedMessageId) : null;

  const toolRecords: ActivityLogToolCall[] = [];
  let response: { text: string } | null = null;
  try {
    response = await chat({
      provider: "anthropic",
      model,
      system,
      messages,
      tools: buildFlowTools(pool),
      maxTokens: MAX_TOKENS,
      maxSteps: MAX_STEPS,
      cacheSystem: true,
      onTextDelta: editor ? (snapshot) => editor.update(snapshot) : undefined,
      onToolResult: async ({ toolName, args, result }) => {
        const resultText = typeof result === "string" ? result : JSON.stringify(result);
        const truncated = truncateToolResult(toolName, resultText);
        await insertChatMessage(pool, {
          chatId,
          externalMessageId: null,
          role: "tool_result",
          content: truncated,
          flow: FLOW_NAME,
        });
        toolRecords.push({
          name: toolName,
          args: (args ?? {}) as Record<string, unknown>,
          result: resultText,
          truncated_result: truncated,
        });
        await logUsage(pool, {
          source: "telegram",
          surface: "flow",
          action: toolName,
          actor: chatId,
          args: (args ?? {}) as Record<string, unknown>,
          ok: true,
        });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (editor) await editor.flush().catch(() => undefined);
    const fallback = `Vault-prompt error: ${message}`;
    if (seedMessageId != null) {
      await editTelegramMessageText(chatId, seedMessageId, fallback, "HTML");
    } else {
      await sendTelegramMessage(chatId, fallback);
    }
    await insertChatMessage(pool, {
      chatId,
      externalMessageId: null,
      role: "assistant",
      content: fallback,
      flow: FLOW_NAME,
    });
    await logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: `vault-prompt.${state.name}`,
      actor: chatId,
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    clearFlow(chatId);
    return;
  }

  if (editor) await editor.flush().catch(() => undefined);
  const finalText = response.text.trim();
  if (finalText.length > 0) {
    if (seedMessageId != null) {
      await editTelegramMessageText(chatId, seedMessageId, finalText, "HTML");
    } else {
      await sendTelegramMessage(chatId, finalText);
    }
    await insertChatMessage(pool, {
      chatId,
      externalMessageId: null,
      role: "assistant",
      content: finalText,
      flow: FLOW_NAME,
    });
    state.conversation.push({ role: "assistant", content: finalText });
    setFlow(chatId, state);
  }

  if (toolRecords.length > 0) {
    try {
      await insertActivityLog(pool, {
        chatId,
        memories: [],
        toolCalls: toolRecords,
        costUsd: null,
      });
    } catch (err) {
      console.error(`[vault-prompt] activity log error [chat:${chatId}]:`, err);
    }
  }

  await logUsage(pool, {
    source: "telegram",
    surface: "flow",
    action: `vault-prompt.${state.name}`,
    actor: chatId,
    ok: true,
    durationMs: Date.now() - startedAt,
    meta: { tool_calls: toolRecords.length },
  });
}

export function endVaultPromptFlow(chatId: string): boolean {
  const existing = clearFlow(chatId);
  return existing?.flow === "vault-prompt";
}
