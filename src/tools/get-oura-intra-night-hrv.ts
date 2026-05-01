import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getOuraIntraNightHrv } from "../db/queries.js";

export async function handleGetOuraIntraNightHrv(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("get_oura_intra_night_hrv", input);
  const row = await getOuraIntraNightHrv(pool, params.date);
  if (!row) return `No long_sleep recorded for ${params.date}.`;

  const hrvItems = row.hrv_5min?.items ?? [];
  const hrItems = row.heart_rate_5min?.items ?? [];
  const interval = row.hrv_5min?.interval ?? row.heart_rate_5min?.interval ?? 300;

  const validHrv = hrvItems.filter((v): v is number => typeof v === "number");
  const validHr = hrItems.filter((v): v is number => typeof v === "number");

  const hrvMin = validHrv.length ? Math.min(...validHrv) : null;
  const hrvMax = validHrv.length ? Math.max(...validHrv) : null;
  const hrvAvg = validHrv.length ? validHrv.reduce((a, b) => a + b, 0) / validHrv.length : null;
  const hrMin = validHr.length ? Math.min(...validHr) : null;

  return JSON.stringify(
    {
      day: params.date,
      bedtime_start: row.bedtime_start,
      interval_seconds: interval,
      hrv_samples: hrvItems,
      hr_samples: hrItems,
      hrv_stats: hrvMin === null ? null : { min: hrvMin, max: hrvMax, mean: Number(hrvAvg!.toFixed(1)) },
      hr_stats: hrMin === null ? null : { min: hrMin },
    },
    null,
    2
  );
}
