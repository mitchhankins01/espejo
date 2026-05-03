import Database from "better-sqlite3";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { UpsertDeviceEventInput } from "../db/queries/device-events.js";

export const AW_DB_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "activitywatch",
  "aw-server",
  "peewee-sqlite.v2.db"
);

export const ACTIVITYWATCH_SOURCE = "activitywatch";

/**
 * Hostnames whose URL paths/queries we should drop on ingest. Hostname is
 * preserved so we can still see "spent 14m on X bank's site" without leaking
 * what page/query was viewed.
 */
const SENSITIVE_HOSTS = new Set<string>([
  // banks
  "chase.com",
  "wellsfargo.com",
  "bankofamerica.com",
  "fidelity.com",
  "schwab.com",
  // health portals
  "kp.org",
  "myhealth.va.gov",
  "mychart.com",
  // crypto
  "coinbase.com",
  "kraken.com",
]);

/**
 * Apps where we keep duration but drop window titles — titles often contain
 * the very secret the app was opened to manage.
 */
const SENSITIVE_APPS = new Set<string>([
  "1Password",
  "1Password 7 - Password Manager",
  "Bitwarden",
  "Keychain Access",
]);

interface AwBucket {
  // peewee stores bucketmodel.key as the INTEGER PK and bucketmodel.id as the
  // string bucket name (e.g. "aw-watcher-window_<host>"). Aliased here to the
  // names this module already used.
  id: number; // = bucketmodel.key
  key: string; // = bucketmodel.id
  type: string;
  client: string;
  hostname: string;
}

interface AwEventRow {
  id: number;
  bucket_id: number;
  timestamp: string; // ISO
  duration: number; // seconds (float)
  datastr: string; // JSON
}

export interface ReadActivityWatchOpts {
  dbPath?: string;
  /** Only return events with started_at strictly greater than this. */
  since?: Date | null;
}

/**
 * Read events from the ActivityWatch SQLite store. Read-only.
 *
 * Maps each bucket to a normalized device_events row:
 * - aw-watcher-window_*  → bucket='window'  (app, title)
 * - aw-watcher-web-*     → bucket='web'     (url, title, app=browser hint)
 * - aw-watcher-afk_*     → bucket='afk'     (data.status)
 *
 * Other bucket types are passed through as bucket='other' with everything
 * stuffed into data.
 */
export function readActivityWatchEvents(
  opts: ReadActivityWatchOpts = {}
): UpsertDeviceEventInput[] {
  const dbPath = opts.dbPath ?? AW_DB_PATH;
  if (!existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const buckets = db
      .prepare(
        `SELECT key AS id, id AS "key", type, client, hostname FROM bucketmodel`
      )
      .all() as AwBucket[];
    if (buckets.length === 0) return [];

    const sinceIso = opts.since ? opts.since.toISOString() : null;

    // peewee stores timestamps with a space separator (`2026-05-03 13:54:45...`)
    // not a `T`, so a naive lexicographic compare against an ISO string with `T`
    // is wrong (space < T). Cast both sides via SQLite's `datetime()` for a
    // correct chronological filter.
    const eventStmt = sinceIso
      ? db.prepare(
          `SELECT id, bucket_id, timestamp, duration, datastr
             FROM eventmodel
            WHERE bucket_id = ? AND datetime(timestamp) > datetime(?)
         ORDER BY timestamp ASC`
        )
      : db.prepare(
          `SELECT id, bucket_id, timestamp, duration, datastr
             FROM eventmodel
            WHERE bucket_id = ?
         ORDER BY timestamp ASC`
        );

    const out: UpsertDeviceEventInput[] = [];
    for (const b of buckets) {
      const bucketKind = classifyBucket(b);
      const events = (
        sinceIso ? eventStmt.all(b.id, sinceIso) : eventStmt.all(b.id)
      ) as AwEventRow[];

      for (const ev of events) {
        const startedAt = new Date(ev.timestamp);
        if (Number.isNaN(startedAt.getTime())) continue;
        const durationMs = Math.round((ev.duration ?? 0) * 1000);
        const endedAt =
          durationMs > 0 ? new Date(startedAt.getTime() + durationMs) : null;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(ev.datastr) as Record<string, unknown>;
        } catch {
          data = { __unparseable: ev.datastr };
        }

        const normalized = normalize({
          bucketKind,
          bucketKey: b.key,
          hostname: b.hostname,
          data,
        });
        if (!normalized) continue; // dropped (e.g. incognito)

        out.push({
          source: ACTIVITYWATCH_SOURCE,
          sourceEventId: `${b.key}/${ev.id}`,
          bucket: bucketKind,
          startedAt,
          endedAt,
          durationMs,
          app: normalized.app,
          title: normalized.title,
          url: normalized.url,
          hostname: normalized.hostname ?? b.hostname ?? null,
          data: normalized.data,
        });
      }
    }

    return out;
  } finally {
    db.close();
  }
}

function classifyBucket(b: AwBucket): "window" | "web" | "afk" | "other" {
  const k = b.key.toLowerCase();
  const t = (b.type ?? "").toLowerCase();
  if (k.startsWith("aw-watcher-window") || t === "currentwindow") return "window";
  if (k.startsWith("aw-watcher-web") || t === "web.tab.current") return "web";
  if (k.startsWith("aw-watcher-afk") || t === "afkstatus") return "afk";
  return "other";
}

interface Normalized {
  app: string | null;
  title: string | null;
  url: string | null;
  hostname: string | null;
  data: Record<string, unknown>;
}

function normalize(args: {
  bucketKind: "window" | "web" | "afk" | "other";
  bucketKey: string;
  hostname: string;
  data: Record<string, unknown>;
}): Normalized | null {
  const { bucketKind, data } = args;

  if (bucketKind === "afk") {
    return { app: null, title: null, url: null, hostname: null, data };
  }

  if (bucketKind === "web") {
    if (data.incognito === true || data.private === true) {
      return null;
    }
    const rawUrl = typeof data.url === "string" ? data.url : null;
    const title = typeof data.title === "string" ? data.title : null;
    const { url, hostname } = redactUrl(rawUrl);
    const browserApp = typeof data.app === "string" ? data.app : null;
    return {
      app: browserApp,
      title,
      url,
      hostname,
      data,
    };
  }

  if (bucketKind === "window") {
    const app = typeof data.app === "string" ? data.app : null;
    const rawTitle = typeof data.title === "string" ? data.title : null;
    const title =
      app && SENSITIVE_APPS.has(app) ? null : rawTitle;
    return { app, title, url: null, hostname: null, data };
  }

  // "other": pass through, do not surface specific columns.
  return {
    app: null,
    title: null,
    url: null,
    hostname: null,
    data,
  };
}

function redactUrl(
  raw: string | null
): { url: string | null; hostname: string | null } {
  if (!raw) return { url: null, hostname: null };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw, hostname: null };
  }
  const hostname = parsed.hostname.replace(/^www\./, "");
  if (isSensitiveHost(hostname)) {
    // Keep only protocol+host, drop path/query/hash.
    return { url: `${parsed.protocol}//${parsed.hostname}`, hostname };
  }
  return { url: raw, hostname };
}

function isSensitiveHost(hostname: string): boolean {
  if (SENSITIVE_HOSTS.has(hostname)) return true;
  for (const h of SENSITIVE_HOSTS) {
    if (hostname.endsWith(`.${h}`)) return true;
  }
  return false;
}
