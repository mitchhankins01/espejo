import type pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import { todayDateInTimezone } from "../../utils/dates.js";
import { insertChatMessage } from "../../db/queries/chat.js";
import {
  insertCheckpoint,
  findRecentDuplicate,
} from "../../db/queries/checkpoints.js";
import { logUsage } from "../../db/queries/usage.js";
import { sendTelegramMessage } from "../client.js";
import {
  clearFlow,
  setFlow,
  type CheckpointFlowState,
} from "../flow-state.js";

const FLOW_NAME = "checkpoint";
const MIRROR_FEATURE_ON = true;
const DUPLICATE_WINDOW_MINUTES = 10;

export interface CheckpointDeps {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
}

function currentHHMMInTimezone(tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
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

async function generateMirrorLine(
  trigger: string,
  bodySignal: string,
  partVoice: string
): Promise<string | null> {
  if (!MIRROR_FEATURE_ON) return null;
  if (!config.anthropic.apiKey) return null;
  try {
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const response = await client.messages.create({
      model: config.models.anthropicFast,
      max_tokens: 256,
      system:
        "Reflect Mitch's part in one sentence, in the part's own voice. " +
        "No preface, no commentary, no quotes. One sentence.",
      messages: [
        {
          role: "user",
          content: `Substance/trigger: ${trigger}\nBody signal: ${bodySignal}\nPart voice: ${partVoice}`,
        },
      ],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    return textBlock?.text?.trim() ?? null;
  } catch {
    return null;
  }
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
): Promise<{ hhmm: string }> {
  const hhmm = currentHHMMInTimezone(config.timezone);
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
  return { hhmm };
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
  if (dup) {
    const reply = `Already logged at ${formatHHMM(dup.occurred_at)}.`;
    await sendTelegramMessage(deps.chatId, reply);
    await persistAssistantTurn(deps, reply);
    clearFlow(deps.chatId);
    return;
  }

  const { hhmm } = await logCheckpointRow(deps, data);

  const mirror =
    data.bodySignal && data.partVoice
      ? await generateMirrorLine(data.trigger, data.bodySignal, data.partVoice)
      : null;

  const reply = mirror ? `${mirror}\n\nLogged at ${hhmm}.` : `Logged at ${hhmm}.`;
  await sendTelegramMessage(deps.chatId, reply);
  await persistAssistantTurn(deps, reply);
  clearFlow(deps.chatId);
}

function formatHHMM(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
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

  // Partial: pre-fill what we have and ask for the next missing field.
  const data: CheckpointFlowState["data"] = {};
  if (segments[0]) data.trigger = segments[0];
  if (segments[1]) data.body_signal = segments[1];
  if (segments[2]) data.part_voice = segments[2];

  let step: CheckpointFlowState["step"] = "awaiting_pull";
  let prompt = "Toll. What's pulling — and where in the body?";
  if (data.trigger && data.body_signal) {
    step = "awaiting_voice";
    prompt = "One long inhale. Now the slowest exhale.\n\nWhat does it want?";
  } else if (data.trigger) {
    step = "awaiting_pull";
    prompt = "Where in the body?";
  }

  setFlow(deps.chatId, {
    flow: "checkpoint",
    step,
    data,
    startedAt: Date.now(),
  });
  await sendTelegramMessage(deps.chatId, prompt);
  await persistAssistantTurn(deps, prompt);
}

export async function continueCheckpointFlow(
  deps: CheckpointDeps,
  state: CheckpointFlowState,
  text: string
): Promise<void> {
  await persistUserTurn(deps, text);

  if (state.step === "awaiting_pull") {
    // Expect "Substance. Body" — split on first period+space.
    const trimmed = text.trim();
    const split = trimmed.split(/\.\s+/, 2);
    let trigger: string;
    let body: string | undefined;
    let parserFallback = false;
    if (split.length === 2 && split[0].length > 0 && split[1].length > 0) {
      trigger = split[0].trim();
      body = split[1].trim().replace(/[.!?]+$/, "");
    } else {
      trigger = trimmed;
      parserFallback = true;
    }
    const next: CheckpointFlowState = {
      flow: "checkpoint",
      step: "awaiting_voice",
      data: {
        trigger,
        body_signal: body ?? state.data.body_signal,
        parser_fallback: parserFallback,
      },
      startedAt: state.startedAt,
    };
    setFlow(deps.chatId, next);

    const prompt = body
      ? "One long inhale. Now the slowest exhale.\n\nWhat does it want?"
      : "Where in the body?";
    await sendTelegramMessage(deps.chatId, prompt);
    await persistAssistantTurn(deps, prompt);

    if (!body) {
      // Need body separately — still in awaiting_pull effectively but we use
      // awaiting_voice with body_signal undefined and re-prompt for body next.
      next.step = "awaiting_pull";
      next.data.body_signal = undefined;
      setFlow(deps.chatId, next);
    }
    return;
  }

  if (state.step === "awaiting_voice") {
    // If we still don't have body_signal, this turn is the body answer.
    if (!state.data.body_signal) {
      const next: CheckpointFlowState = {
        flow: "checkpoint",
        step: "awaiting_voice",
        data: { ...state.data, body_signal: text.trim() },
        startedAt: state.startedAt,
      };
      setFlow(deps.chatId, next);
      const prompt = "One long inhale. Now the slowest exhale.\n\nWhat does it want?";
      await sendTelegramMessage(deps.chatId, prompt);
      await persistAssistantTurn(deps, prompt);
      return;
    }
    // Part voice collected → finalize with the default "go" resolution.
    // (Pass is mental, never logged.)
    await finalizeCheckpoint(deps, {
      trigger: state.data.trigger ?? "",
      bodySignal: state.data.body_signal ?? null,
      partVoice: text.trim(),
      resolution: DEFAULT_RESOLUTION,
      parserFallback: state.data.parser_fallback ?? false,
    });
    return;
  }

  if (state.step === "awaiting_choice") {
    // Legacy step — left here for any in-flight flows mid-restart. Treat any
    // text as the part_voice if missing, otherwise just finalize as "go".
    await finalizeCheckpoint(deps, {
      trigger: state.data.trigger ?? "",
      bodySignal: state.data.body_signal ?? null,
      partVoice: state.data.part_voice ?? text.trim(),
      resolution: DEFAULT_RESOLUTION,
      parserFallback: state.data.parser_fallback ?? false,
    });
    return;
  }
}
