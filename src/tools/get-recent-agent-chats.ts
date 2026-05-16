import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { config } from "../config.js";
import { getRecentAgentPrompts } from "../db/queries/agent-sessions.js";
import { getRecentChatPrompts } from "../db/queries/chat.js";
import { todayDateInTimezone, daysAgoInTimezone } from "../utils/dates.js";

function formatHhmm(ts: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ts);
}

const MAX_PROMPT_CHARS = 200;

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_PROMPT_CHARS
    ? collapsed.slice(0, MAX_PROMPT_CHARS) + "…"
    : collapsed;
}

export async function handleGetRecentAgentChats(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("get_recent_agent_chats", input);
  const toDate = todayDateInTimezone(config.timezone);
  const fromDate = daysAgoInTimezone(params.days - 1);

  const [agentRows, chatRows] = await Promise.all([
    getRecentAgentPrompts(pool, {
      fromDate,
      toDate,
      timezone: config.timezone,
    }),
    getRecentChatPrompts(pool, {
      fromDate,
      toDate,
      timezone: config.timezone,
    }),
  ]);

  const sections: string[] = [];
  sections.push(`Agent + chat prompts from ${fromDate} to ${toDate}:`);

  sections.push(`\nAgent sessions (Claude Code / Codex) — ${agentRows.length} prompt${agentRows.length === 1 ? "" : "s"}:`);
  if (agentRows.length === 0) {
    sections.push("  (none)");
  } else {
    for (const r of agentRows) {
      sections.push(
        `  ${formatHhmm(r.started_at, config.timezone)} [${r.surface}/${r.category}] ${truncate(r.text)}`
      );
    }
  }

  sections.push(`\nTelegram (all flows) — ${chatRows.length} turn${chatRows.length === 1 ? "" : "s"}:`);
  if (chatRows.length === 0) {
    sections.push("  (none)");
  } else {
    for (const r of chatRows) {
      sections.push(
        `  ${formatHhmm(r.created_at, config.timezone)} [${r.flow ?? "—"}] ${truncate(r.content)}`
      );
    }
  }

  return sections.join("\n");
}
