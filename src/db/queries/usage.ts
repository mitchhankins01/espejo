import type pg from "pg";

export type UsageSource =
  | "mcp"
  | "telegram"
  | "http"
  | "cron"
  | "script"
  | "shell";

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
  /**
   * Override the row's timestamp. When unset, Postgres uses NOW(). Set this
   * when backdating historical rows (e.g. atuin shell history backfill).
   */
  ts?: Date;
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
    const result = input.ts
      ? pool.query(
          `INSERT INTO usage_logs
             (ts, source, surface, actor, action, args, ok, error, duration_ms, meta)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb)`,
          [
            input.ts,
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
        )
      : pool.query(
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

/**
 * Awaitable bulk insert for backfill paths (e.g. atuin shell history). Unlike
 * `logUsage`, this surfaces errors so the caller can count failures and write
 * an accurate ingest summary. Each input must have a `ts` — backfilled rows
 * always carry their own timestamp.
 */
export async function bulkInsertUsageLogs(
  pool: pg.Pool,
  inputs: (LogUsageInput & { ts: Date })[]
): Promise<void> {
  if (inputs.length === 0) return;
  const cols = 10;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const base = i * cols;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}::jsonb)`
    );
    values.push(
      input.ts,
      input.source,
      input.surface ?? null,
      input.actor ?? null,
      input.action,
      serializeJsonb(input.args),
      input.ok,
      input.error ?? null,
      input.durationMs ?? null,
      serializeJsonb(input.meta)
    );
  }
  await pool.query(
    `INSERT INTO usage_logs
       (ts, source, surface, actor, action, args, ok, error, duration_ms, meta)
     VALUES ${placeholders.join(", ")}`,
    values
  );
}

/**
 * Watermark for the atuin (or any other) shell-history backfill: the most
 * recent ts already in `usage_logs` for the given source. Returns null when
 * nothing has been ingested yet.
 */
export async function latestUsageLogTs(
  pool: pg.Pool,
  source: UsageSource
): Promise<Date | null> {
  const result = await pool.query<{ ts: Date | null }>(
    `SELECT MAX(ts) AS ts FROM usage_logs WHERE source = $1`,
    [source]
  );
  return result.rows[0]?.ts ?? null;
}
