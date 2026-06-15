import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";

export type LlmProvider = "anthropic" | "openai" | "deepseek";

// DeepSeek exposes an OpenAI-compatible Chat Completions API. We reach it
// through the AI SDK's OpenAI provider pointed at DeepSeek's base URL, forcing
// the `.chat()` (chat-completions) endpoint since DeepSeek does not implement
// OpenAI's newer Responses API. Created lazily so a missing key only matters
// when a deepseek-tier call is actually made (the dedup council reaches the same
// API via raw curl — this is the typed path for the book pipeline).
let deepseekProvider: ReturnType<typeof createOpenAI> | undefined;
function deepseek(modelId: string) {
  if (!deepseekProvider) {
    deepseekProvider = createOpenAI({
      name: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    });
  }
  return deepseekProvider.chat(modelId);
}

export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}
export interface ToolResultEvent extends ToolCallEvent {
  result: unknown;
}

export interface ChatRequest {
  provider: LlmProvider;
  model: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  /** Anthropic ephemeral cache marker on the system message. */
  cacheSystem?: boolean;
  maxTokens?: number;
  /** Sampling temperature. Omitted → provider default. Set 0 for deterministic classifiers. */
  temperature?: number;
  /** Tool-loop step cap. Default 15. */
  maxSteps?: number;
  onTextDelta?: (snapshot: string) => void;
  onToolCall?: (event: ToolCallEvent) => void | Promise<void>;
  onToolResult?: (event: ToolResultEvent) => void | Promise<void>;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCallEvent[];
  toolResults: ToolResultEvent[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  finishReason: string;
}

function selectModel(provider: LlmProvider, modelId: string) {
  if (provider === "openai") return openai(modelId);
  if (provider === "deepseek") return deepseek(modelId);
  return anthropic(modelId);
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const messages: ModelMessage[] = [];
  if (req.system && req.cacheSystem && req.provider === "anthropic") {
    messages.push({
      role: "system",
      content: req.system,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    });
  }
  messages.push(...req.messages);

  const useTopLevelSystem =
    req.system && !(req.cacheSystem && req.provider === "anthropic");

  const result = streamText({
    model: selectModel(req.provider, req.model),
    ...(useTopLevelSystem ? { system: req.system } : {}),
    // The cacheSystem path deliberately carries the system prompt as a
    // role:"system" message (so it can take an ephemeral cache marker); opt out
    // of the AI SDK's prompt-injection warning for that intentional case.
    ...(!useTopLevelSystem && req.system ? { allowSystemInMessages: true } : {}),
    messages,
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
    stopWhen: stepCountIs(req.maxSteps ?? 15),
    onStepFinish: async ({ toolCalls, toolResults }) => {
      for (const c of toolCalls) {
        await req.onToolCall?.({
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          args: (c as unknown as { input: unknown }).input,
        });
      }
      for (const r of toolResults) {
        await req.onToolResult?.({
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          args: (r as unknown as { input: unknown }).input,
          result: (r as unknown as { output: unknown }).output,
        });
      }
    },
  });

  let snapshot = "";
  for await (const delta of result.textStream) {
    snapshot += delta;
    req.onTextDelta?.(snapshot);
  }

  const text = await result.text;
  const sdkToolCalls = await result.toolCalls;
  const sdkToolResults = await result.toolResults;
  const usage = await result.usage;
  const finishReason = await result.finishReason;

  return {
    text,
    toolCalls: sdkToolCalls.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      args: (c as unknown as { input: unknown }).input,
    })),
    toolResults: sdkToolResults.map((r) => ({
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      args: (r as unknown as { input: unknown }).input,
      result: (r as unknown as { output: unknown }).output,
    })),
    usage: {
      inputTokens: usage.inputTokens ?? undefined,
      outputTokens: usage.outputTokens ?? undefined,
      totalTokens: usage.totalTokens ?? undefined,
    },
    finishReason: String(finishReason),
  };
}
