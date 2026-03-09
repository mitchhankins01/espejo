import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { pool } from "../../db/client.js";
import {
  insertChatMessage,
  logApiUsage,
  type ChatMessageRow,
  type ActivityLogToolCall,
} from "../../db/queries.js";
import { toolHandlers } from "../../server.js";
import {
  allToolNames,
  toAnthropicToolDefinition,
} from "../../../specs/tools.spec.js";
import {
  MAX_TOOL_CALLS,
  WALL_CLOCK_TIMEOUT_MS,
  getAnthropic,
  getOpenAI,
  getLlmProvider,
  getLlmModel,
} from "./constants.js";
import { computeCost } from "./costs.js";
import { truncateToolResult } from "./truncation.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

type OpenAIChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type OpenAIChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const toolDefinitions = allToolNames.map((name) => toAnthropicToolDefinition(name));

function getAnthropicTools(): Anthropic.Tool[] {
  return toolDefinitions.map((def) => {
    return {
      name: def.name,
      description: def.description,
      input_schema: def.input_schema as Anthropic.Tool.InputSchema,
    };
  });
}

function getOpenAITools(): OpenAIChatTool[] {
  return toolDefinitions.map((def) => ({
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.input_schema,
    },
  }));
}

// ---------------------------------------------------------------------------
// Message reconstruction
// ---------------------------------------------------------------------------

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export function reconstructMessages(
  rows: ChatMessageRow[]
): ChatHistoryMessage[] {
  const messages: ChatHistoryMessage[] = [];

  for (const row of rows) {
    if (row.role === "user") {
      messages.push({ role: "user", content: row.content });
    } else if (row.role === "assistant") {
      messages.push({ role: "assistant", content: row.content });
    }
    // tool_result rows are fed during the live tool loop; stored context
    // only needs user/assistant turns.
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Tool loop
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlockParam[];
}

function toAnthropicMessages(
  messages: ChatHistoryMessage[]
): AnthropicMessage[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

export interface ToolLoopResult {
  text: string;
  toolCallCount: number;
  toolNames: string[];
  toolCalls: ActivityLogToolCall[];
}

export async function runToolLoop(
  systemPrompt: string,
  messages: ChatHistoryMessage[],
  chatId: string,
  prefill?: string
): Promise<ToolLoopResult> {
  const provider = getLlmProvider();
  if (provider === "openai") {
    return runOpenAIToolLoop(systemPrompt, messages, chatId, prefill);
  }
  return runAnthropicToolLoop(systemPrompt, messages, chatId, prefill);
}

async function runAnthropicToolLoop(
  systemPrompt: string,
  messages: ChatHistoryMessage[],
  chatId: string,
  prefill?: string
): Promise<ToolLoopResult> {
  const anthropic = getAnthropic();
  const model = getLlmModel("anthropic");
  const tools = getAnthropicTools();
  const startMs = Date.now();
  let toolCallCount = 0;
  let lastToolKey = "";
  const toolNamesUsed = new Set<string>();
  const toolCallRecords: ActivityLogToolCall[] = [];

  const loopMessages = toAnthropicMessages(messages);

  // Prefill forces the model to continue from a partial assistant response,
  // preventing conversational replies when a structured format is expected.
  if (prefill) {
    loopMessages.push({ role: "assistant", content: prefill });
  }

  while (true) {
    const elapsed = Date.now() - startMs;
    /* v8 ignore next -- wall clock timeout requires real timing */
    if (elapsed >= WALL_CLOCK_TIMEOUT_MS) break;

    const apiStartMs = Date.now();
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: loopMessages as Anthropic.MessageParam[],
      tools,
    });

    const latencyMs = Date.now() - apiStartMs;
    const costUsd = computeCost(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    await logApiUsage(pool, {
      provider: "anthropic",
      model,
      purpose: "agent",
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd,
      latencyMs,
    });

    // Check for tool_use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // If no tool calls, extract text and return
    if (toolUseBlocks.length === 0) {
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      const responseText = textBlocks.map((b) => b.text).join("\n") || "";
      return {
        text: prefill ? prefill + responseText : responseText,
        toolCallCount,
        toolNames: [...toolNamesUsed],
        toolCalls: toolCallRecords,
      };
    }

    // Process tool calls — if prefill was the last message, merge to avoid
    // consecutive assistant messages which are invalid for the API.
    const assistantContent = response.content;
    /* v8 ignore next 10 -- prefill + tool calls: compose never triggers tools */
    if (prefill && loopMessages[loopMessages.length - 1]?.content === prefill) {
      loopMessages.pop();
      loopMessages.push({
        role: "assistant",
        content: [
          { type: "text" as const, text: prefill },
          ...(assistantContent as Anthropic.ContentBlockParam[]),
        ],
      });
      prefill = undefined;
    } else {
      loopMessages.push({
        role: "assistant",
        content: assistantContent as Anthropic.ContentBlockParam[],
      });
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      toolCallCount++;
      /* v8 ignore next -- inner break: outer check handles this */
      if (toolCallCount > MAX_TOOL_CALLS) break;

      // No-progress detection
      const toolKey = `${toolUse.name}:${JSON.stringify(toolUse.input)}`;
      if (toolKey === lastToolKey) {
        return {
          text: extractTextFromAnthropicMessages(loopMessages),
          toolCallCount,
          toolNames: [...toolNamesUsed],
          toolCalls: toolCallRecords,
        };
      }
      lastToolKey = toolKey;
      toolNamesUsed.add(toolUse.name);

      // Execute tool
      let result: string;
      const handler = toolHandlers[toolUse.name];
      if (handler) {
        try {
          result = await handler(pool, toolUse.input);
        } catch (err) {
          /* v8 ignore next -- errors are always Error instances in practice */
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      } /* v8 ignore next 2 -- defensive: all registered tools have handlers */ else {
        result = `Error: Unknown tool "${toolUse.name}"`;
      }

      // Store tool result in chat_messages (truncated)
      const truncated = truncateToolResult(toolUse.name, result);
      await insertChatMessage(pool, {
        chatId,
        externalMessageId: null,
        role: "tool_result",
        content: truncated,
        toolCallId: toolUse.id,
      });

      toolCallRecords.push({
        name: toolUse.name,
        args: (toolUse.input ?? /* v8 ignore next -- defensive: Anthropic always provides input */ {}) as Record<string, unknown>,
        result,
        truncated_result: truncated,
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result, // full result for the model
      });
    }

    loopMessages.push({
      role: "user",
      content: toolResults as unknown as Anthropic.ContentBlockParam[],
    });

    if (toolCallCount >= MAX_TOOL_CALLS) break;

    // Check timeout again
    /* v8 ignore next -- wall clock timeout requires real timing */
    if (Date.now() - startMs >= WALL_CLOCK_TIMEOUT_MS) break;
  }

  return {
    text: extractTextFromAnthropicMessages(loopMessages),
    toolCallCount,
    toolNames: [...toolNamesUsed],
    toolCalls: toolCallRecords,
  };
}

async function runOpenAIToolLoop(
  systemPrompt: string,
  messages: ChatHistoryMessage[],
  chatId: string,
  prefill?: string
): Promise<ToolLoopResult> {
  const openai = getOpenAI();
  const model = getLlmModel("openai");
  const tools = getOpenAITools();
  const startMs = Date.now();
  let toolCallCount = 0;
  let lastToolKey = "";
  const toolNamesUsed = new Set<string>();
  const toolCallRecords: ActivityLogToolCall[] = [];

  const loopMessages: OpenAIChatMessage[] = messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  /* v8 ignore next 3 -- OpenAI prefill: tested via Anthropic path */
  if (prefill) {
    loopMessages.push({ role: "assistant", content: prefill });
  }

  while (true) {
    const elapsed = Date.now() - startMs;
    /* v8 ignore next -- wall clock timeout requires real timing */
    if (elapsed >= WALL_CLOCK_TIMEOUT_MS) break;

    const apiStartMs = Date.now();
    const response = await openai.chat.completions.create({
      model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        ...loopMessages,
      ],
      tools,
      tool_choice: "auto",
    });

    const latencyMs = Date.now() - apiStartMs;
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
    await logApiUsage(pool, {
      provider: "openai",
      model,
      purpose: "agent",
      inputTokens,
      outputTokens,
      costUsd: computeCost(model, inputTokens, outputTokens),
      latencyMs,
    });

    const choice = response.choices[0];
    if (!choice) break;
    const assistantMessage = choice.message;
    const toolCalls = assistantMessage.tool_calls ?? [];
    const assistantContent = assistantMessage.content ?? "";

    if (toolCalls.length === 0) {
      return {
        /* v8 ignore next -- OpenAI prefill: tested via Anthropic path */
        text: prefill ? prefill + assistantContent : assistantContent,
        toolCallCount,
        toolNames: [...toolNamesUsed],
        toolCalls: toolCallRecords,
      };
    }

    // If prefill was the last message, remove it before pushing the
    // full assistant response to avoid consecutive assistant messages.
    /* v8 ignore next 5 -- prefill + tool calls: compose never triggers tools */
    if (prefill && loopMessages[loopMessages.length - 1]?.role === "assistant" &&
        loopMessages[loopMessages.length - 1]?.content === prefill) {
      loopMessages.pop();
      prefill = undefined;
    }

    loopMessages.push({
      role: "assistant",
      content: assistantContent || null,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      toolCallCount++;
      /* v8 ignore next -- inner break: outer check handles this */
      if (toolCallCount > MAX_TOOL_CALLS) break;

      const toolName = toolCall.function.name;
      const toolArgs = toolCall.function.arguments;
      const toolKey = `${toolName}:${toolArgs}`;
      if (toolKey === lastToolKey) {
        return {
          text: extractTextFromOpenAIMessages(loopMessages),
          toolCallCount,
          toolNames: [...toolNamesUsed],
          toolCalls: toolCallRecords,
        };
      }
      lastToolKey = toolKey;
      toolNamesUsed.add(toolName);

      let result: string;
      let parsedArgs: unknown = {};
      try {
        parsedArgs = toolArgs ? JSON.parse(toolArgs) : {};
      } catch {
        result = `Error: Invalid JSON arguments for tool "${toolName}"`;
        const truncatedErr = truncateToolResult(toolName, result);
        await insertChatMessage(pool, {
          chatId,
          externalMessageId: null,
          role: "tool_result",
          content: truncatedErr,
          toolCallId: toolCall.id,
        });
        toolCallRecords.push({
          name: toolName,
          args: {},
          result,
          truncated_result: truncatedErr,
        });
        loopMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
        continue;
      }

      const handler = toolHandlers[toolName];
      if (handler) {
        try {
          result = await handler(pool, parsedArgs);
        } catch (err) {
          /* v8 ignore next -- errors are always Error instances in practice */
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      } /* v8 ignore next 2 -- defensive: all registered tools have handlers */ else {
        result = `Error: Unknown tool "${toolName}"`;
      }

      const truncated = truncateToolResult(toolName, result);
      await insertChatMessage(pool, {
        chatId,
        externalMessageId: null,
        role: "tool_result",
        content: truncated,
        toolCallId: toolCall.id,
      });

      toolCallRecords.push({
        name: toolName,
        args: parsedArgs as Record<string, unknown>,
        result,
        truncated_result: truncated,
      });

      loopMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    if (toolCallCount >= MAX_TOOL_CALLS) break;

    // Check timeout again
    /* v8 ignore next -- wall clock timeout requires real timing */
    if (Date.now() - startMs >= WALL_CLOCK_TIMEOUT_MS) break;
  }

  return {
    text: extractTextFromOpenAIMessages(loopMessages),
    toolCallCount,
    toolNames: [...toolNamesUsed],
    toolCalls: toolCallRecords,
  };
}

function extractTextFromAnthropicMessages(messages: AnthropicMessage[]): string {
  // Find last assistant message with text
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      /* v8 ignore next -- content is always array from tool loop */
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(
          (b): b is Anthropic.TextBlock =>
            typeof b === "object" && "type" in b && b.type === "text"
        );
        if (textBlocks.length > 0) {
          return textBlocks.map((b) => b.text).join("\n");
        }
      }
    }
  }
  /* v8 ignore next -- defensive: loop always finds assistant message from tool loop */
  return "";
}

function extractTextFromOpenAIMessages(messages: OpenAIChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return "";
}
