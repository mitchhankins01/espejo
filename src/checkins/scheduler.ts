import type pg from "pg";
import { config } from "../config.js";
import {
  getUserSettings,
  upsertUserSettings,
  insertCheckin,
  getLastCheckinForWindow,
  markCheckinsIgnored,
  getConsecutiveIgnoredCount,
  type CheckinWindow,
  type UserSettingsRow,
} from "../db/queries.js";
import { sendTelegramMessage } from "../telegram/client.js";
import { notifyError } from "../telegram/notify.js";
import { currentHourInTimezone, currentTimeLabel } from "../utils/dates.js";
import { buildOuraContextPrompt } from "../oura/context.js";
import { buildTodoContextPrompt } from "../todos/context.js";
import { buildCheckinPrompt } from "./prompts.js";

const CHECKIN_LOCK_KEY = 9152203;
const IGNORE_AFTER_HOURS = 2;

// Pending check-ins awaiting user response (chatId -> checkinId)
export const pendingCheckins = new Map<string, number>();

// ============================================================================
// Window evaluation
// ============================================================================

interface WindowConfig {
  window: CheckinWindow;
  hour: number;
}

function getWindowConfigs(settings: UserSettingsRow): WindowConfig[] {
  return [
    { window: "morning", hour: settings.checkin_morning_hour },
    { window: "afternoon", hour: settings.checkin_afternoon_hour },
    { window: "evening", hour: settings.checkin_evening_hour },
  ];
}

export function isWindowDue(
  currentHour: number,
  windowHour: number
): boolean {
  // Window is due if current hour matches the configured hour
  return currentHour === windowHour;
}

function isSnoozed(settings: UserSettingsRow): boolean {
  if (!settings.checkin_snooze_until) return false;
  return new Date() < new Date(settings.checkin_snooze_until);
}

// ============================================================================
// Engine
// ============================================================================

export interface CheckinEngineResult {
  checkinsSent: number;
  checkinsIgnored: number;
  skippedDisabled: boolean;
  skippedSnoozed: boolean;
}

export async function runCheckinEngine(pool: pg.Pool): Promise<CheckinEngineResult | null> {
  const lock = await pool.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS ok",
    [CHECKIN_LOCK_KEY]
  );
  if (!lock.rows[0]?.ok) return null;

  try {
    const chatId = config.telegram.allowedChatId;
    if (!chatId) {
      return { checkinsSent: 0, checkinsIgnored: 0, skippedDisabled: true, skippedSnoozed: false };
    }

    // Get or create user settings
    let settings = await getUserSettings(pool, chatId);
    if (!settings) {
      settings = await upsertUserSettings(pool, chatId, {});
    }

    if (!settings.checkin_enabled) {
      return { checkinsSent: 0, checkinsIgnored: 0, skippedDisabled: true, skippedSnoozed: false };
    }

    if (isSnoozed(settings)) {
      return { checkinsSent: 0, checkinsIgnored: 0, skippedDisabled: false, skippedSnoozed: true };
    }

    const tz = settings.timezone;
    const currentHour = currentHourInTimezone(tz);
    const windows = getWindowConfigs(settings);

    let checkinsSent = 0;

    for (const { window, hour } of windows) {
      if (!isWindowDue(currentHour, hour)) continue;

      // Check if already sent for this window today (within last 12h to handle timezone shifts)
      const existing = await getLastCheckinForWindow(pool, chatId, window, 12);
      if (existing) {
        // Already sent for this window within the lookback period — skip
        continue;
      }

      // Check adaptation: should we ask to adjust?
      const ignoredCount = await getConsecutiveIgnoredCount(pool, chatId, window);
      if (ignoredCount >= config.checkins.ignoreThreshold) {
        // Send adaptation prompt instead
        const adaptText =
          `He notado que no has respondido a los últimos ${ignoredCount} check-ins de ${window}. ` +
          `¿Quieres que ajuste el horario, los haga menos frecuentes, o los apague para ${window}?`;

        const checkinId = await insertCheckin(pool, {
          chatId,
          window,
          triggerType: "scheduled",
          promptText: adaptText,
          metadata: { adaptation: true, ignored_count: ignoredCount },
        });

        pendingCheckins.set(chatId, checkinId);
        void sendTelegramMessage(chatId, adaptText).catch((err) => {
          console.error("Failed to send adaptation check-in:", err);
        });
        checkinsSent++;
        continue;
      }

      // Build context-aware prompt
      const [ouraCtx, todoCtx] = await Promise.all([
        buildOuraContextPrompt(pool).catch(() => null),
        buildTodoContextPrompt(pool).catch(() => null),
      ]);

      const promptText = buildCheckinPrompt(window, ouraCtx, todoCtx);
      const timeLabel = currentTimeLabel(tz);

      const checkinId = await insertCheckin(pool, {
        chatId,
        window,
        triggerType: "scheduled",
        promptText,
        metadata: { time_label: timeLabel },
      });

      pendingCheckins.set(chatId, checkinId);

      void sendTelegramMessage(chatId, promptText).catch((err) => {
        console.error("Failed to send check-in:", err);
      });

      checkinsSent++;
    }

    // Sweep: mark old unresponded check-ins as ignored
    const checkinsIgnored = await markCheckinsIgnored(pool, IGNORE_AFTER_HOURS);

    return {
      checkinsSent,
      checkinsIgnored,
      skippedDisabled: false,
      skippedSnoozed: false,
    };
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [CHECKIN_LOCK_KEY]);
  }
}

// ============================================================================
// Timer
// ============================================================================

async function runAndNotify(pool: pg.Pool): Promise<void> {
  try {
    await runCheckinEngine(pool);
    /* v8 ignore next 3 -- background engine: errors are notified */
  } catch (err) {
    notifyError("Check-in engine", err);
  }
}

export function startCheckinTimer(pool: pg.Pool): NodeJS.Timeout | null {
  if (!config.checkins.enabled) return null;
  if (!config.telegram.botToken || !config.telegram.allowedChatId) return null;

  void runAndNotify(pool);
  /* v8 ignore next 3 -- interval callback body is not testable in unit tests */
  return setInterval(() => {
    void runAndNotify(pool);
  }, config.checkins.intervalMinutes * 60_000);
}
