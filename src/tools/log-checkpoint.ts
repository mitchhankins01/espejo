import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { config } from "../config.js";
import { todayDateInTimezone } from "../utils/dates.js";
import {
  insertCheckpoint,
  findRecentDuplicate,
} from "../db/queries/checkpoints.js";

const DUPLICATE_WINDOW_MINUTES = 10;

function currentHHMMInTimezone(tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export async function handleLogCheckpoint(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("log_checkpoint", input);
  const localDate = todayDateInTimezone(config.timezone);
  const hhmm = currentHHMMInTimezone(config.timezone);

  const dup = await findRecentDuplicate(pool, {
    kind: params.kind,
    trigger: params.substance,
    bodySignal: params.body,
    partVoice: params.part_voice,
    withinMinutes: DUPLICATE_WINDOW_MINUTES,
  });
  if (dup) {
    const dupHhmm = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(dup.occurred_at);
    return `Already logged at ${dupHhmm} (skipped duplicate within ${DUPLICATE_WINDOW_MINUTES} min).`;
  }

  await insertCheckpoint(pool, {
    kind: params.kind,
    trigger: params.substance,
    bodySignal: params.body,
    partVoice: params.part_voice,
    comment: params.comment ?? null,
    resolution: params.choice,
    source: "mcp",
    localDate,
  });

  return `Toll logged at ${hhmm}.`;
}
