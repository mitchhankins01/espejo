import type pg from "pg";

export type UsageSource = "mcp" | "telegram" | "http" | "cron" | "script";

export interface LogUsageInput {
  source: UsageSource;
  surface?: string;
  actor?: string;
  action: string;
  args?: unknown;
  ok: boolean;
  error?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

// Hard cap so a runaway payload can't bloat a single log row.
// args/meta keep their original shape under this size; over it, we replace
// with a marker so debugging still has a hint without the row exploding.
const MAX_JSONB_BYTES = 1_000_000;

function serializeJsonb(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return JSON.stringify({ __unserializable: true });
  }
  if (json.length > MAX_JSONB_BYTES) {
    return JSON.stringify({
      __truncated: true,
      original_bytes: json.length,
    });
  }
  return json;
}

/**
 * Fire-and-forget: callers never await us, and we swallow every error so an
 * outage on usage_logs (or a bad arg shape) can never break the user-facing
 * code path that emitted it.
 */
export function logUsage(pool: pg.Pool, input: LogUsageInput): void {
  const args = serializeJsonb(input.args);
  const meta = serializeJsonb(input.meta);

  try {
    const result = pool.query(
      `INSERT INTO usage_logs
         (source, surface, actor, action, args, ok, error, duration_ms, meta)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)`,
      [
        input.source,
        input.surface ?? null,
        input.actor ?? null,
        input.action,
        args,
        input.ok,
        input.error ?? null,
        input.durationMs ?? null,
        meta,
      ]
    );
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch((err) => {
        console.error("[usage_logs] insert failed:", err);
      });
    }
  } catch (err) {
    /* v8 ignore next -- last-resort guard if pool.query throws synchronously */
    console.error("[usage_logs] insert threw synchronously:", err);
  }
}
