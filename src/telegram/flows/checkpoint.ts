import type pg from "pg";
import { config } from "../../config.js";
import { todayDateInTimezone } from "../../utils/dates.js";
import { insertChatMessage } from "../../db/queries/chat.js";
import {
  insertCheckpoint,
  findRecentDuplicate,
} from "../../db/queries/checkpoints.js";
import { logUsage } from "../../db/queries/usage.js";
import { sendTelegramMessage } from "../client.js";
import { END_KEYBOARD, DEFAULT_KEYBOARD } from "../keyboard.js";
import {
  clearFlow,
  setFlow,
  type CheckpointFlowState,
} from "../flow-state.js";

const FLOW_NAME = "checkpoint";
const DUPLICATE_WINDOW_MINUTES = 10;

// One combined prompt: tap the button, answer all three in a single message
// (periods/newlines separate trigger / body / want; a bare blob logs as the
// trigger alone). Bottom-up, breath-cued, no part-naming.
const CHECKPOINT_PROMPT = "Toll. One slow inhale, slower exhale. What, where, why?";

export interface CheckpointDeps {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
}

function normalizeResolution(input: string): "pass" | "go" | "unset" {
  const lower = input.toLowerCase().trim().replace(/[.,!?]+$/, "");
  if (/^(pass(ed)?|sí pasé|paso|si pase|skipped)$/.test(lower)) return "pass";
  if (/^(go|went|fui|sí fui|si fui|did|used)$/.test(lower)) return "go";
  return "unset";
}

// Substance checkpoints are now always logged as "go" — Mitch handles passes
// mentally and never triggers the flow for them. An explicit 4th segment can
// still override (e.g. `/c trigger. body. voice. pass` if you really mean it).
const DEFAULT_RESOLUTION = "go" as const;

interface ParsedShortcutArgs {
  segments: string[];
}

function parseShortcutArgs(argText: string): ParsedShortcutArgs {
  const segments = argText
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { segments };
}

async function persistUserTurn(deps: CheckpointDeps, content: string): Promise<void> {
  await insertChatMessage(deps.pool, {
    chatId: deps.chatId,
    externalMessageId: deps.externalMessageId,
    role: "user",
    content,
    flow: FLOW_NAME,
  });
}

async function persistAssistantTurn(deps: CheckpointDeps, content: string): Promise<void> {
  await insertChatMessage(deps.pool, {
    chatId: deps.chatId,
    externalMessageId: null,
    role: "assistant",
    content,
    flow: FLOW_NAME,
  });
}

async function logCheckpointRow(
  deps: CheckpointDeps,
  data: {
    trigger: string;
    bodySignal: string | null;
    partVoice: string | null;
    resolution: "pass" | "go" | "unset" | null;
    parserFallback: boolean;
  }
): Promise<void> {
  const localDate = todayDateInTimezone(config.timezone);
  const startedAt = Date.now();
  await insertCheckpoint(deps.pool, {
    kind: "substance",
    trigger: data.trigger,
    bodySignal: data.bodySignal,
    partVoice: data.partVoice,
    resolution: data.resolution,
    payload: data.parserFallback ? { parser_fallback: true } : {},
    source: "telegram",
    chatId: deps.chatId,
    localDate,
  });
  await logUsage(deps.pool, {
    source: "telegram",
    surface: "flow",
    action: "checkpoint.log",
    actor: deps.chatId,
    args: {
      trigger: data.trigger,
      resolution: data.resolution,
    },
    ok: true,
    durationMs: Date.now() - startedAt,
  });
}

async function finalizeCheckpoint(
  deps: CheckpointDeps,
  data: {
    trigger: string;
    bodySignal: string | null;
    partVoice: string | null;
    resolution: "pass" | "go" | "unset" | null;
    parserFallback: boolean;
  }
): Promise<void> {
  const dup = await findRecentDuplicate(deps.pool, {
    kind: "substance",
    trigger: data.trigger,
    bodySignal: data.bodySignal,
    partVoice: data.partVoice,
    withinMinutes: DUPLICATE_WINDOW_MINUTES,
  });
  const reply = dup ? "Already logged." : "Logged.";
  if (!dup) await logCheckpointRow(deps, data);
  // Flow over → restore the idle (start) keyboard.
  await sendTelegramMessage(deps.chatId, reply, DEFAULT_KEYBOARD);
  await persistAssistantTurn(deps, reply);
  clearFlow(deps.chatId);
}

export async function startCheckpointFlow(
  deps: CheckpointDeps,
  argText: string
): Promise<void> {
  await persistUserTurn(deps, `/checkpoint${argText ? ` ${argText}` : ""}`);

  const { segments } = parseShortcutArgs(argText);

  // Pre-formed shortcut: 3+ segments → log immediately, skip turns.
  // 4th segment is an optional override; default resolution is "go".
  if (segments.length >= 3) {
    const [trigger, body, partVoice, choice] = segments;
    const resolution =
      choice && normalizeResolution(choice) !== "unset"
        ? normalizeResolution(choice)
        : DEFAULT_RESOLUTION;
    await finalizeCheckpoint(deps, {
      trigger: trigger.trim(),
      bodySignal: body.trim(),
      partVoice: partVoice.trim(),
      resolution,
      parserFallback: false,
    });
    return;
  }

  // Fewer than 3 segments: pre-fill what we have, then ask the one combined
  // question and capture the rest in a single follow-up message.
  const data: CheckpointFlowState["data"] = {};
  if (segments[0]) data.trigger = segments[0];
  if (segments[1]) data.body_signal = segments[1];

  setFlow(deps.chatId, {
    flow: "checkpoint",
    step: "awaiting_pull",
    data,
    startedAt: Date.now(),
  });
  // Entering the capture turn → swap the bottom row to a single End button.
  await sendTelegramMessage(deps.chatId, CHECKPOINT_PROMPT, END_KEYBOARD);
  await persistAssistantTurn(deps, CHECKPOINT_PROMPT);
}

export async function continueCheckpointFlow(
  deps: CheckpointDeps,
  state: CheckpointFlowState,
  text: string
): Promise<void> {
  await persistUserTurn(deps, text);

  // Single capture turn. Split the message on periods/newlines and drop each
  // piece into the still-missing fields, in order: trigger → body → want.
  // (A button tap pre-fills nothing, so all three come from this message;
  // a partial `/c trigger. body` pre-fills the rest.) Extra pieces fold into
  // "want". A blob with no separators logs as the trigger alone — no mirror.
  const parts = text
    .split(/[.\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const pieces = parts.length > 0 ? parts : [text.trim()];

  const slots: ("trigger" | "body" | "voice")[] = [];
  if (!state.data.trigger) slots.push("trigger");
  if (!state.data.body_signal) slots.push("body");
  slots.push("voice");

  let trigger = state.data.trigger ?? null;
  let bodySignal = state.data.body_signal ?? null;
  let partVoice: string | null = null;
  pieces.forEach((piece, i) => {
    const slot = slots[Math.min(i, slots.length - 1)];
    if (slot === "trigger") trigger = piece;
    else if (slot === "body") bodySignal = piece;
    else partVoice = partVoice ? `${partVoice}. ${piece}` : piece;
  });

  await finalizeCheckpoint(deps, {
    trigger: trigger ?? text.trim(),
    bodySignal,
    partVoice,
    // Default "go" — pass is mental, never logged. parser_fallback marks a
    // bare blob we couldn't structure into body/want (so no mirror line).
    resolution: DEFAULT_RESOLUTION,
    parserFallback: bodySignal == null && partVoice == null,
  });
}
