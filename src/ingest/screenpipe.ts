import Database from "better-sqlite3";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const SCREENPIPE_DB_PATH = join(
  homedir(),
  ".screenpipe",
  "db.sqlite"
);

export const SCREENPIPE_SOURCE = "screenpipe";

/** Width of one chunk window in seconds. */
export const CHUNK_SECONDS = 30;

/**
 * Apps where OCR captures the very secret the app exists to manage. We drop
 * the chunk entirely (OCR + audio) — much more aggressive than ActivityWatch's
 * title-redaction because OCR can pull keys out of pixel content.
 */
const SENSITIVE_APPS = new Set<string>([
  "1Password",
  "1Password 7 - Password Manager",
  "1Password 8",
  "Bitwarden",
  "Keychain Access",
  "Messages",
  "Signal",
  "Telegram",
  "WhatsApp",
  "Mail",
]);

/**
 * Hostnames that should never appear in screen-capture content. If the active
 * window title contains any of these as a substring, drop the chunk. Less
 * precise than AW's URL-based check (Screenpipe only sees window titles), but
 * still catches the common "<page title> — chase.com — Chrome" form.
 */
const SENSITIVE_HOSTS = [
  "chase.com",
  "wellsfargo.com",
  "bankofamerica.com",
  "fidelity.com",
  "schwab.com",
  "kp.org",
  "myhealth.va.gov",
  "mychart.com",
  "coinbase.com",
  "kraken.com",
];

interface FrameRow {
  id: number;
  timestamp: string; // ISO
  app_name: string | null;
  window_name: string | null;
}

interface AudioRow {
  ts: string; // ISO
  transcription: string | null;
}

export interface ScreenCaptureChunk {
  sourceChunkId: string;
  startedAt: Date;
  endedAt: Date;
  app: string;
  window: string;
  ocrText: string;
  audioText: string | null;
  data: {
    frame_count: number;
    frame_id_min: number;
    frame_id_max: number;
    ocr_chars: number;
    audio_chars: number;
  };
}

export interface ReadScreenpipeOpts {
  dbPath?: string;
  /** Only return chunks whose started_at is strictly greater than this. */
  since?: Date | null;
  /** Override chunk window width (seconds). Tests use this. */
  chunkSeconds?: number;
}

/**
 * Read OCR + audio from Screenpipe's local SQLite store and chunk it into
 * (app, window, ~30s) windows. Read-only.
 *
 * Chunking strategy: bucket frames by floor(epoch / chunkSeconds) AND
 * (app, window). Concatenate OCR text within a bucket (deduped consecutively
 * — Screenpipe captures ~1 fps and most consecutive frames show the same
 * pixels, so the raw concat is mostly identical). For each chunk, find any
 * audio transcription whose timestamp overlaps [started_at, ended_at] and
 * concatenate that into audioText.
 */
export function readScreenpipeChunks(
  opts: ReadScreenpipeOpts = {}
): ScreenCaptureChunk[] {
  const dbPath = opts.dbPath ?? SCREENPIPE_DB_PATH;
  if (!existsSync(dbPath)) return [];

  const chunkSeconds = opts.chunkSeconds ?? CHUNK_SECONDS;
  const sinceIso = opts.since ? opts.since.toISOString() : null;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Frames + OCR. A LEFT JOIN keeps frames whose OCR row hasn't landed yet
    // (we'll just record an empty ocr_text for that frame).
    const frameStmt = sinceIso
      ? db.prepare(
          `SELECT f.id, f.timestamp, f.app_name, f.window_name, o.text
             FROM frames f
        LEFT JOIN ocr_text o ON o.frame_id = f.id
            WHERE datetime(f.timestamp) > datetime(?)
         ORDER BY f.timestamp ASC`
        )
      : db.prepare(
          `SELECT f.id, f.timestamp, f.app_name, f.window_name, o.text
             FROM frames f
        LEFT JOIN ocr_text o ON o.frame_id = f.id
         ORDER BY f.timestamp ASC`
        );

    const rows = (
      sinceIso ? frameStmt.all(sinceIso) : frameStmt.all()
    ) as (FrameRow & { text: string | null })[];

    if (rows.length === 0) return [];

    // Group rows into chunk buckets keyed by (app, window, bucketIndex).
    interface BucketAcc {
      app: string;
      window: string;
      bucketIndex: number;
      bucketStart: Date;
      frameIds: number[];
      ocrLines: string[]; // dedup-on-append
      lastOcr: string | null;
      tsMin: Date;
      tsMax: Date;
    }
    const buckets = new Map<string, BucketAcc>();

    for (const r of rows) {
      const ts = new Date(r.timestamp);
      if (Number.isNaN(ts.getTime())) continue;
      const app = (r.app_name ?? "").trim();
      const win = (r.window_name ?? "").trim();
      // Skip frames with no app context — we can't attribute them.
      if (!app) continue;
      // Privacy gates.
      if (SENSITIVE_APPS.has(app)) continue;
      if (containsSensitiveHost(win)) continue;

      const bucketIndex = Math.floor(ts.getTime() / 1000 / chunkSeconds);
      const key = `${app}${win}${bucketIndex}`;

      let acc = buckets.get(key);
      if (!acc) {
        acc = {
          app,
          window: win,
          bucketIndex,
          bucketStart: new Date(bucketIndex * chunkSeconds * 1000),
          frameIds: [],
          ocrLines: [],
          lastOcr: null,
          tsMin: ts,
          tsMax: ts,
        };
        buckets.set(key, acc);
      }
      acc.frameIds.push(r.id);
      if (ts < acc.tsMin) acc.tsMin = ts;
      if (ts > acc.tsMax) acc.tsMax = ts;

      const text = (r.text ?? "").trim();
      if (text && text !== acc.lastOcr) {
        acc.ocrLines.push(text);
        acc.lastOcr = text;
      }
    }

    if (buckets.size === 0) return [];

    // Read overlapping audio transcriptions in one shot. Bound the time range
    // by min/max chunk start to keep the scan small.
    const allBuckets = Array.from(buckets.values());
    const audioByBucketIndex = readAudioForBuckets(
      db,
      allBuckets,
      chunkSeconds
    );

    const out: ScreenCaptureChunk[] = [];
    for (const acc of allBuckets) {
      const ocrText = acc.ocrLines.join("\n").trim();
      // A chunk with no OCR text and no audio is just dwell — skip; AW already
      // captures dwell more cheaply.
      const audioText = audioByBucketIndex.get(audioKey(acc)) ?? null;
      if (!ocrText && !audioText) continue;

      const startedAt = acc.bucketStart;
      const endedAt = new Date(
        (acc.bucketIndex + 1) * chunkSeconds * 1000
      );
      const sourceChunkId = `chunk:${acc.app}|${acc.window}|${acc.bucketIndex}`;

      out.push({
        sourceChunkId,
        startedAt,
        endedAt,
        app: acc.app,
        window: acc.window,
        ocrText,
        audioText,
        data: {
          frame_count: acc.frameIds.length,
          frame_id_min: Math.min(...acc.frameIds),
          frame_id_max: Math.max(...acc.frameIds),
          ocr_chars: ocrText.length,
          audio_chars: audioText ? audioText.length : 0,
        },
      });
    }

    // Sort chronologically so the bulk upsert stays append-friendly.
    out.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    return out;
  } finally {
    db.close();
  }
}

interface BucketLite {
  app: string;
  window: string;
  bucketIndex: number;
}

function audioKey(b: BucketLite): string {
  return `${b.app}${b.window}${b.bucketIndex}`;
}

function readAudioForBuckets(
  db: Database.Database,
  buckets: BucketLite[],
  chunkSeconds: number
): Map<string, string> {
  // Some Screenpipe builds don't have audio_chunks/audio_transcriptions if
  // the recorder was started with audio disabled. Bail silently.
  const hasAudioChunks = tableExists(db, "audio_chunks");
  const hasAudioTranscriptions = tableExists(db, "audio_transcriptions");
  if (!hasAudioChunks || !hasAudioTranscriptions) return new Map();

  const minBucket = Math.min(...buckets.map((b) => b.bucketIndex));
  const maxBucket = Math.max(...buckets.map((b) => b.bucketIndex));
  const startIso = new Date(minBucket * chunkSeconds * 1000).toISOString();
  const endIso = new Date(
    (maxBucket + 1) * chunkSeconds * 1000
  ).toISOString();

  const audioRows = db
    .prepare(
      `SELECT ac.timestamp AS ts, t.transcription AS transcription
         FROM audio_chunks ac
         JOIN audio_transcriptions t ON t.audio_chunk_id = ac.id
        WHERE datetime(ac.timestamp) >= datetime(?)
          AND datetime(ac.timestamp) <  datetime(?)
     ORDER BY ac.timestamp ASC`
    )
    .all(startIso, endIso) as AudioRow[];

  // Audio doesn't know what app the user was in. Map each transcription to
  // every (app, window) bucket whose time window contains the audio_chunks
  // timestamp. In practice there's usually exactly one bucket per timestamp,
  // because the user can only have one active app at a time — but if the
  // recorder briefly captured frames from two apps in the same 30s window
  // (app switch), we attach the audio to both. That's the right call: we
  // can't disambiguate, and dropping it would lose signal entirely.
  const bucketsByIndex = new Map<number, BucketLite[]>();
  for (const b of buckets) {
    const arr = bucketsByIndex.get(b.bucketIndex) ?? [];
    arr.push(b);
    bucketsByIndex.set(b.bucketIndex, arr);
  }

  const acc = new Map<string, string[]>();
  for (const row of audioRows) {
    const text = (row.transcription ?? "").trim();
    if (!text) continue;
    const ts = new Date(row.ts);
    if (Number.isNaN(ts.getTime())) continue;
    const idx = Math.floor(ts.getTime() / 1000 / chunkSeconds);
    const targets = bucketsByIndex.get(idx);
    if (!targets) continue;
    for (const t of targets) {
      const key = audioKey(t);
      const lines = acc.get(key) ?? [];
      lines.push(text);
      acc.set(key, lines);
    }
  }

  const out = new Map<string, string>();
  for (const [key, lines] of acc) {
    out.set(key, lines.join("\n"));
  }
  return out;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function containsSensitiveHost(windowTitle: string): boolean {
  if (!windowTitle) return false;
  const t = windowTitle.toLowerCase();
  for (const h of SENSITIVE_HOSTS) {
    if (t.includes(h)) return true;
  }
  return false;
}
