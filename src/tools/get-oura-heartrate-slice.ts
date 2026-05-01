import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getOuraHeartrateRange } from "../db/queries.js";

export async function handleGetOuraHeartrateSlice(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("get_oura_heartrate_slice", input);
  const rows = await getOuraHeartrateRange(pool, params.start, params.end, params.source ?? undefined);
  if (rows.length === 0) {
    return `No heart rate samples for ${params.start} → ${params.end}${params.source ? ` (source=${params.source})` : ""}.`;
  }
  const bpms = rows.map((r) => r.bpm);
  const min = Math.min(...bpms);
  const max = Math.max(...bpms);
  const mean = bpms.reduce((a, b) => a + b, 0) / bpms.length;
  return JSON.stringify(
    {
      start: params.start,
      end: params.end,
      source: params.source ?? "all",
      sample_count: rows.length,
      stats: { min, max, mean: Number(mean.toFixed(1)) },
      samples: rows.map((r) => ({ ts: r.ts, bpm: r.bpm, source: r.source })),
    },
    null,
    2
  );
}
