import { randomUUID } from "crypto";
import type pg from "pg";
import { sendTelegramMessage, editTelegramMessageText } from "../client.js";
import { insertChatMessage } from "../../db/queries/chat.js";
import { logUsage } from "../../db/queries/usage.js";
import {
  getDueQueue,
  serveCard,
  rateCard,
  getReviewById,
  getSessionCounts,
  type VocabReviewRow,
} from "../../db/queries/vocab-reviews.js";
import { nextState, type Grade } from "../../fsrs/scheduler.js";
import {
  clearFlow,
  getFlow,
  setFlow,
  type SrsFlowState,
} from "../flow-state.js";
import { buildRatePayload, buildShowPayload, type SrsCallback } from "../srs-callbacks.js";

const FLOW_NAME = "srs";
const SRS_NEW_PER_SESSION_DEFAULT = 20;
const SRS_NEW_PER_SESSION_MIN = 1;
const SRS_NEW_PER_SESSION_MAX = 100;

/**
 * Parse the optional integer argument from `/srs N`. Returns:
 *   - `{ newCap: undefined }` for `/srs` (use default)
 *   - `{ newCap: <int> }` for `/srs 30`
 *   - `{ error: "..." }` for `/srs foo` or out-of-range values
 */
export function parseSrsArgs(
  argText: string
): { newCap: number | undefined } | { error: string } {
  const trimmed = argText.trim();
  if (!trimmed) return { newCap: undefined };
  const n = Number(trimmed);
  if (
    !Number.isInteger(n) ||
    n < SRS_NEW_PER_SESSION_MIN ||
    n > SRS_NEW_PER_SESSION_MAX
  ) {
    return {
      error: `Usage: /srs [${SRS_NEW_PER_SESSION_MIN}-${SRS_NEW_PER_SESSION_MAX}]. Got "${argText.trim()}".`,
    };
  }
  return { newCap: n };
}

const RATING_LABELS: Record<Grade, string> = {
  1: "again",
  2: "hard",
  3: "good",
  4: "easy",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const FLOW_LABEL: Record<string, string> = {
  checkpoint: "checkpoint",
  practice: "practice",
  "vault-prompt": "vault-prompt",
  chat: "chat",
};

function flowLabel(name: string): string {
  return FLOW_LABEL[name] ?? name;
}

interface CardFrontView {
  text: string;
  replyMarkup: Record<string, unknown>;
}

export function renderCardFront(row: VocabReviewRow): CardFrontView {
  const text =
    `<b>${escapeHtml(row.stem)}</b>\n\n` +
    `<i>${escapeHtml(row.sample_usage)}</i>`;
  return {
    text,
    replyMarkup: {
      inline_keyboard: [
        [{ text: "Show", callback_data: buildShowPayload(row.id) }],
      ],
    },
  };
}

export function renderRevealed(row: VocabReviewRow): CardFrontView {
  const gloss = row.gloss_override ?? row.gloss ?? "(no gloss)";
  const text =
    `<b>${escapeHtml(row.stem)}</b> → ${escapeHtml(gloss)}\n\n` +
    `<i>${escapeHtml(row.sample_usage)}</i>`;
  return {
    text,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "1 Again", callback_data: buildRatePayload(row.id, 1) },
          { text: "2 Hard", callback_data: buildRatePayload(row.id, 2) },
          { text: "3 Good", callback_data: buildRatePayload(row.id, 3) },
          { text: "4 Easy", callback_data: buildRatePayload(row.id, 4) },
        ],
      ],
    },
  };
}

/**
 * Format the human-facing interval between `now` and `due`. Computed from the
 * actual due date so learning-state cards (FSRS tracks them in minutes via
 * `due`, not via `scheduled_days`) get correct labels.
 */
export function formatInterval(due: Date, now: Date = new Date()): string {
  const ms = Math.max(0, due.getTime() - now.getTime());
  const minutes = ms / 60_000;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

export function renderRatedSummary(
  row: VocabReviewRow,
  rating: Grade,
  due: Date,
  now: Date = new Date()
): string {
  return (
    `✓ ${escapeHtml(row.stem)} (${RATING_LABELS[rating]}) → ` +
    `next in ${formatInterval(due, now)}`
  );
}

interface SrsDeps {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
}

async function persistAssistant(
  pool: pg.Pool,
  chatId: string,
  content: string
): Promise<void> {
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content,
    flow: FLOW_NAME,
  });
}

async function persistUser(
  pool: pg.Pool,
  chatId: string,
  externalMessageId: string | null,
  content: string
): Promise<void> {
  await insertChatMessage(pool, {
    chatId,
    externalMessageId,
    role: "user",
    content,
    flow: FLOW_NAME,
  });
}

async function serveNextCard(
  deps: SrsDeps,
  state: SrsFlowState
): Promise<void> {
  const nextId = state.queue[state.queueIndex];
  if (nextId === undefined) {
    await endSessionWithSummary(deps, state, "Listo");
    return;
  }
  const row = await getReviewById(deps.pool, nextId);
  if (!row) {
    state.queueIndex += 1;
    setFlow(deps.chatId, state);
    await serveNextCard(deps, state);
    return;
  }
  await serveCard(deps.pool, {
    id: row.id,
    sessionId: state.sessionId,
    chatId: deps.chatId,
  });
  state.lastServedReviewId = row.id;
  state.lastServedAt = Date.now();
  setFlow(deps.chatId, state);
  const front = renderCardFront(row);
  await sendTelegramMessage(deps.chatId, front.text, front.replyMarkup);
  await persistAssistant(deps.pool, deps.chatId, front.text);
}

async function endSessionWithSummary(
  deps: SrsDeps,
  state: SrsFlowState,
  prefix: "Listo" | "Stopped"
): Promise<void> {
  const counts = await getSessionCounts(deps.pool);
  const r = state.countsByRating;
  const summary =
    `${prefix}. ${state.reviewedCount} revisadas ` +
    `(${r[1]} again, ${r[2]} hard, ${r[3]} good, ${r[4]} easy).\n` +
    `${counts.due} pendientes, ${counts.stalling} atascadas, ` +
    `${counts.newCards} nuevas esperando.`;
  await sendTelegramMessage(deps.chatId, summary);
  await persistAssistant(deps.pool, deps.chatId, summary);
  clearFlow(deps.chatId);
}

export async function startSrsFlow(
  deps: SrsDeps & { argText?: string }
): Promise<void> {
  const { pool, chatId, externalMessageId, argText } = deps;
  const rawCommand = `/srs${argText ? ` ${argText}` : ""}`;
  const active = getFlow(chatId);
  if (active) {
    const reply = `Termina /done primero — tienes flow ${flowLabel(active.flow)} activa.`;
    await persistUser(pool, chatId, externalMessageId, rawCommand);
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    return;
  }

  await persistUser(pool, chatId, externalMessageId, rawCommand);

  const parsed = parseSrsArgs(argText ?? "");
  if ("error" in parsed) {
    await sendTelegramMessage(chatId, parsed.error);
    await persistAssistant(pool, chatId, parsed.error);
    return;
  }
  const newCap = parsed.newCap ?? SRS_NEW_PER_SESSION_DEFAULT;

  const queue = await getDueQueue(pool, newCap);
  if (queue.length === 0) {
    const reply = "Cola vacía. Vuelve a leer un rato y prueba de nuevo más tarde.";
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "srs.start",
      actor: chatId,
      args: { queueSize: 0, newCap },
      ok: true,
    });
    return;
  }

  const state: SrsFlowState = {
    flow: "srs",
    sessionId: randomUUID(),
    startedAt: Date.now(),
    queue: queue.map((r) => r.id),
    queueIndex: 0,
    reviewedCount: 0,
    countsByRating: { 1: 0, 2: 0, 3: 0, 4: 0 },
    lastServedReviewId: null,
    lastServedAt: null,
  };
  setFlow(chatId, state);

  logUsage(pool, {
    source: "telegram",
    surface: "flow",
    action: "srs.start",
    actor: chatId,
    args: { queueSize: queue.length, newCap },
    ok: true,
  });

  await serveNextCard(deps, state);
}

export async function endSrsFlow(deps: SrsDeps): Promise<{ ended: boolean }> {
  const state = getFlow(deps.chatId);
  if (state?.flow !== "srs") return { ended: false };
  await persistUser(deps.pool, deps.chatId, deps.externalMessageId, "/done");
  await endSessionWithSummary(deps, state, "Stopped");
  return { ended: true };
}

/**
 * Handle a non-prose message while an SRS flow is active. The flow only
 * accepts callback taps and /done; any free text gets a nudge back.
 */
export async function handleSrsProse(deps: SrsDeps): Promise<void> {
  const reply = "Toca un botón o /done.";
  await sendTelegramMessage(deps.chatId, reply);
  await persistAssistant(deps.pool, deps.chatId, reply);
}

export async function handleSrsCallback(
  deps: SrsDeps & { messageId: number; callback: SrsCallback }
): Promise<void> {
  const { pool, chatId, messageId, callback } = deps;
  const state = getFlow(chatId);
  if (state?.flow !== "srs") {
    // Flow was lost (bot restart, etc). Stale button — silently no-op.
    logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "srs.callback.stale",
      actor: chatId,
      args: { kind: callback.kind, reviewId: callback.reviewId },
      ok: true,
    });
    return;
  }

  if (callback.kind === "show") {
    const row = await getReviewById(pool, callback.reviewId);
    if (!row) return;
    if (row.current_session_id !== state.sessionId) {
      // Stale: card was served in a previous session.
      return;
    }
    if (row.current_session_rated_at !== null) {
      // Already rated this session — ignore double-tap on Show.
      return;
    }
    const back = renderRevealed(row);
    await editTelegramMessageText(chatId, messageId, back.text, "HTML", back.replyMarkup);
    return;
  }

  // Rate
  const row = await getReviewById(pool, callback.reviewId);
  if (!row) return;
  if (row.current_session_id !== state.sessionId) return;
  if (row.current_session_rated_at !== null) return;

  const cardBefore = {
    due: row.due,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    last_review: row.last_review,
  };
  const next = nextState(cardBefore, callback.rating);

  const ok = await rateCard(pool, {
    id: row.id,
    sessionId: state.sessionId,
    rating: callback.rating,
    next,
    chatId,
  });
  if (!ok) {
    // Race: another callback got there first. No-op.
    return;
  }

  state.reviewedCount += 1;
  state.countsByRating[callback.rating] += 1;
  state.queueIndex += 1;
  setFlow(chatId, state);

  const summary = renderRatedSummary(row, callback.rating, next.due);
  await editTelegramMessageText(chatId, messageId, summary, "HTML");
  await persistAssistant(pool, chatId, summary);

  logUsage(pool, {
    source: "telegram",
    surface: "flow",
    action: "srs.rate",
    actor: chatId,
    args: { reviewId: row.id, rating: callback.rating, state_after: next.state },
    ok: true,
  });

  await serveNextCard(deps, state);
}
