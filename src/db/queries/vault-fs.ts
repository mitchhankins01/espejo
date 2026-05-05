import type pg from "pg";

export type VaultFsEventSource = "fswatch" | "eslogger" | "manual";
export type VaultFsEventType =
  | "create"
  | "unlink"
  | "rename"
  | "modify"
  | "other";

export interface VaultFsEventInput {
  source: VaultFsEventSource;
  eventType: VaultFsEventType;
  path: string;
  processName?: string | null;
  pid?: number | null;
  ppid?: number | null;
  raw?: unknown;
  ts?: Date;
}

const MAX_RAW_BYTES = 32_768;

function serializeRaw(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return JSON.stringify({ __unserializable: true });
  }
  if (json.length > MAX_RAW_BYTES) {
    return JSON.stringify({ __truncated: true, original_bytes: json.length });
  }
  return json;
}

export async function insertVaultFsEvent(
  pool: pg.Pool,
  input: VaultFsEventInput
): Promise<void> {
  const raw = serializeRaw(input.raw);
  if (input.ts) {
    await pool.query(
      `INSERT INTO vault_fs_events
         (ts, source, event_type, path, process_name, pid, ppid, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.ts,
        input.source,
        input.eventType,
        input.path,
        input.processName ?? null,
        input.pid ?? null,
        input.ppid ?? null,
        raw,
      ]
    );
  } else {
    await pool.query(
      `INSERT INTO vault_fs_events
         (source, event_type, path, process_name, pid, ppid, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.source,
        input.eventType,
        input.path,
        input.processName ?? null,
        input.pid ?? null,
        input.ppid ?? null,
        raw,
      ]
    );
  }
}

/**
 * Bulk insert with a single round-trip. The watcher batches events and calls
 * this so we don't issue one query per FS event under load (e.g. when Obsidian
 * indexer rewrites every cache file at startup).
 */
export async function insertVaultFsEvents(
  pool: pg.Pool,
  events: VaultFsEventInput[]
): Promise<void> {
  if (events.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const e of events) {
    const placeholders = e.ts
      ? `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb)`
      : `(NOW(), $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb)`;
    values.push(placeholders);
    if (e.ts) params.push(e.ts);
    params.push(
      e.source,
      e.eventType,
      e.path,
      e.processName ?? null,
      e.pid ?? null,
      e.ppid ?? null,
      serializeRaw(e.raw)
    );
  }
  await pool.query(
    `INSERT INTO vault_fs_events
       (ts, source, event_type, path, process_name, pid, ppid, raw)
     VALUES ${values.join(", ")}`,
    params
  );
}
