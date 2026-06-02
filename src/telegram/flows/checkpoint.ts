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

// Substance checkpoints are always logged as "go" — Mitch handles passes
// mentally and never triggers the flow for them, so the flow no longer parses a
// pass/go override out of the message; the 4th+ segment is now the comment.
const DEFAULT_RESOLUTION = "go" as const;

export interface ParsedCheckpoint {
  trigger: string | null;
  bodySignal: string | null;
  partVoice: string | null;
  comment: string | null;
}

// Distribute period/newline-separated pieces into checkpoint slots in order:
// trigger → body → voice → comment, where comment is the catch-all for any
// piece past the third (joined by ". "). `prefilled` lets a partial
// `/c trigger. body` skip already-known slots so the follow-up message fills
// only what's left. A bare blob (one piece, no separators) lands in trigger.
export function assignCheckpointSlots(
  pieces: string[],
  prefilled: { trigger?: string | null; bodySignal?: string | null } = {}
): ParsedCheckpoint {
  const slots: ("trigger" | "body" | "voice" | "comment")[] = [];
  if (!prefilled.trigger) slots.push("trigger");
  if (!prefilled.bodySignal) slots.push("body");
  slots.push("voice", "comment");

  let trigger = prefilled.trigger ?? null;
  let bodySignal = prefilled.bodySignal ?? null;
  let partVoice: string | null = null;
  let comment: string | null = null;
  pieces.forEach((piece, i) => {
    const slot = slots[Math.min(i, slots.length - 1)];
    if (slot === "trigger") trigger = piece;
    else if (slot === "body") bodySignal = piece;
    else if (slot === "voice") partVoice = piece;
    else comment = comment ? `${comment}. ${piece}` : piece;
  });
  return { trigger, bodySignal, partVoice, comment };
}

function splitSegments(text: string): string[] {
  return text
    .split(/[.\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

interface CheckpointData {
  trigger: string;
  bodySignal: string | null;
  partVoice: string | null;
  comment: string | null;
  resolution: "pass" | "go" | "unset" | null;
  parserFallback: boolean;
}

async function logCheckpointRow(
  deps: CheckpointDeps,
  data: CheckpointData
): Promise<void> {
  const localDate = todayDateInTimezone(config.timezone);
  const startedAt = Date.now();
  await insertCheckpoint(deps.pool, {
    kind: "substance",
    trigger: data.trigger,
    bodySignal: data.bodySignal,
    partVoice: data.partVoice,
    comment: data.comment,
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
  data: CheckpointData
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

  const segments = splitSegments(argText);

  // Pre-formed shortcut: 3+ segments → log immediately, skip turns.
  // trigger. body. voice. [comment...] — 4th+ segment is the free-text comment.
  if (segments.length >= 3) {
    const parsed = assignCheckpointSlots(segments);
    await finalizeCheckpoint(deps, {
      trigger: (parsed.trigger ?? "").trim(),
      bodySignal: parsed.bodySignal,
      partVoice: parsed.partVoice,
      comment: parsed.comment,
      resolution: DEFAULT_RESOLUTION,
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
  // piece into the still-missing fields, in order: trigger → body → want →
  // comment. (A button tap pre-fills nothing, so all come from this message; a
  // partial `/c trigger. body` pre-fills the rest.) The 4th+ piece is the
  // free-text comment. A blob with no separators logs as the trigger alone.
  const parts = splitSegments(text);
  const pieces = parts.length > 0 ? parts : [text.trim()];

  const parsed = assignCheckpointSlots(pieces, {
    trigger: state.data.trigger,
    bodySignal: state.data.body_signal,
  });

  await finalizeCheckpoint(deps, {
    trigger: parsed.trigger ?? text.trim(),
    bodySignal: parsed.bodySignal,
    partVoice: parsed.partVoice,
    comment: parsed.comment,
    // Default "go" — pass is mental, never logged. parser_fallback marks a
    // bare blob we couldn't structure into body/want (so no mirror line).
    resolution: DEFAULT_RESOLUTION,
    parserFallback: parsed.bodySignal == null && parsed.partVoice == null,
  });
}
