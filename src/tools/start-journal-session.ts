import type pg from "pg";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { validateToolInput } from "../../specs/tools.spec.js";
import { buildMorningContext, buildEveningContext } from "../sessions/context.js";

export async function handleStartJournalSession(
  pool: pg.Pool,
  input: unknown
): Promise<CallToolResult> {
  const params = validateToolInput("start_journal_session", input);

  const ctx =
    params.type === "morning"
      ? await buildMorningContext(pool, params.date)
      : await buildEveningContext(pool, params.date);

  // Template body + context → shown to both user and assistant
  const userFacing = JSON.stringify(
    { template: { body: ctx.template.body }, context: ctx.context, date: ctx.date },
    null,
    2
  );

  const content: CallToolResult["content"] = [
    {
      type: "text" as const,
      text: userFacing,
      annotations: { audience: ["user" as const, "assistant" as const], priority: 1 },
    },
  ];

  // System prompt → assistant-only (LLM instructions, not for user display)
  if (ctx.template.system_prompt) {
    content.push({
      type: "text" as const,
      text: ctx.template.system_prompt,
      annotations: { audience: ["assistant" as const], priority: 0.8 },
    });
  }

  return { content };
}
