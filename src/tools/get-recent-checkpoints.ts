import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { config } from "../config.js";
import { getRecentCheckpoints } from "../db/queries/checkpoints.js";
import { todayDateInTimezone, daysAgoInTimezone } from "../utils/dates.js";

function formatHhmm(occurredAt: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(occurredAt);
}

export async function handleGetRecentCheckpoints(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("get_recent_checkpoints", input);
  const toDate = todayDateInTimezone(config.timezone);
  const fromDate = daysAgoInTimezone(params.days - 1);

  const rows = await getRecentCheckpoints(pool, { fromDate, toDate });
  if (rows.length === 0) {
    return `No checkpoints between ${fromDate} and ${toDate}.`;
  }

  const lines = rows.map((r) => {
    const hhmm = formatHhmm(r.occurred_at, config.timezone);
    const ld = r.local_date as unknown;
    const localDate =
      ld instanceof Date
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: config.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(ld)
        : String(ld);
    const base = `${localDate} ${hhmm} | ${r.kind} | ${r.trigger} | ${r.body_signal ?? "—"} | ${r.part_voice ?? "—"} | ${r.resolution ?? "—"}`;
    return r.comment ? `${base} | ${r.comment}` : base;
  });

  return `${rows.length} checkpoint${rows.length === 1 ? "" : "s"} from ${fromDate} to ${toDate}:\n\n${lines.join("\n")}`;
}
