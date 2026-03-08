import type pg from "pg";
import {
  findOrCreateDailyLogArtifact,
  appendToDailyLog,
  markCheckinResponded,
} from "../db/queries.js";
import { currentTimeLabel, todayDateInTimezone } from "../utils/dates.js";

// ============================================================================
// LLM summary client interface (DI for testability)
// ============================================================================

export interface SummaryLlmClient {
  summarize(messages: string[]): Promise<string>;
}

export function createOpenAISummaryClient(
  // Accept the OpenAI client or any object with a compatible shape
  openai: { chat: { completions: { create: CallableFunction } } },
  model: string = "gpt-4o-mini"
): SummaryLlmClient {
  return {
    async summarize(messages: string[]): Promise<string> {
      const conversation = messages.join("\n\n");
      const response = (await openai.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content:
              "Summarize this check-in conversation into a concise paragraph (2-4 sentences) " +
              "capturing the person's state, key themes, and anything notable. " +
              "Write in first person from the user's perspective. " +
              "Keep the language they used (Spanish/English/Dutch mix is fine). " +
              "Do not add headers or formatting.",
          },
          { role: "user", content: conversation },
        ],
        max_tokens: 300,
        temperature: 0.3,
      })) as { choices: Array<{ message: { content: string | null } }> };
      return response.choices[0]?.message?.content?.trim() ?? "";
    },
  };
}

// ============================================================================
// Post-checkin processing
// ============================================================================

export async function processCheckinSummary(
  pool: pg.Pool,
  client: SummaryLlmClient,
  checkinId: number,
  conversationMessages: string[],
  timezone: string
): Promise<{ artifactId: string; section: string } | null> {
  if (conversationMessages.length === 0) return null;

  const summary = await client.summarize(conversationMessages);
  if (!summary) return null;

  const dateStr = todayDateInTimezone(timezone);
  const timeLabel = currentTimeLabel(timezone);
  const section = `## ${timeLabel}\n${summary}`;

  const artifact = await findOrCreateDailyLogArtifact(pool, dateStr, ["daily-log"]);
  await appendToDailyLog(pool, artifact.id, section);
  await markCheckinResponded(pool, checkinId, artifact.id);

  return { artifactId: artifact.id, section };
}
