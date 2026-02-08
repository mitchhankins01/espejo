import dotenv from "dotenv";
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env", override: true });
}
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import pg from "pg";
import {
  createClient,
  uploadMedia,
  mediaExists,
  getPublicUrl,
} from "../src/storage/r2.js";
import type { S3Client } from "../src/storage/r2.js";

// ---------------------------------------------------------------------------
// Core Data epoch offset (2001-01-01 00:00:00 UTC)
// ---------------------------------------------------------------------------

const CORE_DATA_EPOCH_OFFSET = 978307200;

function coreDataToIso(timestamp: number | null): string | null {
  if (timestamp == null) return null;
  return new Date((timestamp + CORE_DATA_EPOCH_OFFSET) * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/** Strip null bytes that PostgreSQL rejects in text columns */
function sanitize(s: string | null): string | null {
  return s ? s.replace(/\0/g, "") : s;
}

function normalizeText(text: string): string {
  return (
    text
      // Strip null bytes (PostgreSQL rejects 0x00 in text/json columns)
      .replace(/\0/g, "")
      // Strip Day One's backslash escapes on punctuation: \. \- \( \) \! \* \+ \{ \} \[ \]
      .replace(/\\([.\-()!*+{}[\]])/g, "$1")
      // Remove dayone-moment:// image/media references
      .replace(/!\[\]\(dayone-moment:\/\/[A-Fa-f0-9]+\)/g, "")
      // Normalize invisible unicode
      .replace(/\u2028/g, "\n") // LINE SEPARATOR → newline
      .replace(/[\u200B\u200D]/g, "") // zero-width space/joiner → remove
      .replace(/[\u202C\u202D]/g, "") // bidi overrides → remove
      .replace(/\u2003/g, " ") // EM SPACE → regular space
      // Collapse runs of 3+ newlines left by stripped image refs
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Media type mapping and file resolution
// ---------------------------------------------------------------------------

function mapMediaType(
  ztype: string | null
): "photo" | "video" | "audio" | null {
  if (!ztype) return null;
  const t = ztype.toLowerCase();
  if (["jpeg", "png", "gif", "heic", "tiff", "webp"].includes(t))
    return "photo";
  if (["mov", "mp4", "m4v", "avi"].includes(t)) return "video";
  if (["m4a", "mp3", "wav", "aac", "caf"].includes(t)) return "audio";
  return null;
}

/** Map media type to Day One's directory name */
function dayOneMediaDir(mediaType: "photo" | "video" | "audio"): string {
  switch (mediaType) {
    case "photo":
      return "DayOnePhotos";
    case "video":
      return "DayOneVideos";
    case "audio":
      return "DayOneAudios";
  }
}

/** Get the file extension for an attachment */
function getFileExtension(att: AttachmentRow): string {
  // Audio files in Day One always use .m4a regardless of ZTYPE
  if (!att.ZTYPE) return "m4a";
  return att.ZTYPE.toLowerCase();
}

/** Build the R2 storage key for an attachment */
function buildStorageKey(
  mediaType: "photo" | "video" | "audio",
  md5: string,
  ext: string
): string {
  return `${mediaType}s/${md5}.${ext}`;
}

// ---------------------------------------------------------------------------
// SQLite row types
// ---------------------------------------------------------------------------

interface EntryRow {
  Z_PK: number;
  ZUUID: string;
  ZCREATIONDATE: number | null;
  ZMODIFIEDDATE: number | null;
  ZMARKDOWNTEXT: string | null;
  ZRICHTEXTJSON: string | null;
  ZTIMEZONE: Buffer | string | null;
  ZISALLDAY: number;
  ZISPINNED: number;
  ZSTARRED: number;
  ZEDITINGTIME: number | null;
  ZDURATION: number | null;
  ZCREATIONDEVICE: string | null;
  ZCREATIONDEVICEMODEL: string | null;
  ZCREATIONDEVICETYPE: string | null;
  ZCREATIONOSNAME: string | null;
  ZCREATIONOSVERSION: string | null;
  ZSOURCESTRING: string | null;
  // Joined fields
  ZLOCALITYNAME: string | null;
  ZCOUNTRY: string | null;
  ZPLACENAME: string | null;
  ZADMINISTRATIVEAREA: string | null;
  ZLATITUDE: number | null;
  ZLONGITUDE: number | null;
  ZTEMPERATURECELSIUS: number | null;
  ZCONDITIONSDESCRIPTION: string | null;
  ZRELATIVEHUMIDITY: number | null;
  ZMOONPHASE: number | null;
  ZSUNRISEDATE: number | null;
  ZSUNSETDATE: number | null;
  ZACTIVITYNAME: string | null;
  ZSTEPCOUNT: number | null;
  ZTEMPLATETITLE: string | null;
}

interface TagRow {
  Z_17ENTRIES: number;
  ZNAME: string;
}

interface AttachmentRow {
  ZENTRY: number;
  ZTYPE: string | null;
  ZMD5: string | null;
  ZFILESIZE: number | null;
  ZWIDTH: number | null;
  ZHEIGHT: number | null;
  ZDURATION: number | null;
  ZCAMERAMAKE: string | null;
  ZCAMERAMODEL: string | null;
  ZHASDATA: number;
}

// ---------------------------------------------------------------------------
// CLI flags + config
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://dev:dev@localhost:5434/journal_dev";

const skipMedia = process.argv.includes("--skip-media");

function getSqlitePath(): string {
  const flagIdx = process.argv.indexOf("--sqlite-path");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    return process.argv[flagIdx + 1];
  }

  if (process.env.DAYONE_SQLITE_PATH) {
    return process.env.DAYONE_SQLITE_PATH;
  }

  console.error(
    "Error: No SQLite path provided.\n\n" +
      "Set DAYONE_SQLITE_PATH in your .env file or pass --sqlite-path:\n" +
      "  pnpm sync -- --sqlite-path /path/to/DayOne.sqlite\n\n" +
      "The DayOne.sqlite file is typically located at:\n" +
      "  ~/Library/Group Containers/5U8NS4GX82.dayoneapp2/Data/Documents/DayOne.sqlite"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function syncDayOne(): Promise<void> {
  const sqlitePath = getSqlitePath();
  const dayOneDir = path.dirname(sqlitePath);
  console.log(`Reading from: ${sqlitePath}`);

  // Open SQLite read-only
  const sqlite = new Database(sqlitePath, { readonly: true });

  // Read all entries with joined data
  const entries = sqlite
    .prepare(
      `SELECT
      e.Z_PK, e.ZUUID, e.ZCREATIONDATE, e.ZMODIFIEDDATE,
      e.ZMARKDOWNTEXT, e.ZRICHTEXTJSON, e.ZTIMEZONE,
      e.ZISALLDAY, e.ZISPINNED, e.ZSTARRED,
      e.ZEDITINGTIME, e.ZDURATION,
      e.ZCREATIONDEVICE, e.ZCREATIONDEVICEMODEL, e.ZCREATIONDEVICETYPE,
      e.ZCREATIONOSNAME, e.ZCREATIONOSVERSION, e.ZSOURCESTRING,
      l.ZLOCALITYNAME, l.ZCOUNTRY, l.ZPLACENAME, l.ZADMINISTRATIVEAREA,
      l.ZLATITUDE, l.ZLONGITUDE,
      w.ZTEMPERATURECELSIUS, w.ZCONDITIONSDESCRIPTION, w.ZRELATIVEHUMIDITY,
      w.ZMOONPHASE, w.ZSUNRISEDATE, w.ZSUNSETDATE,
      ua.ZACTIVITYNAME, ua.ZSTEPCOUNT,
      t.ZTITLE AS ZTEMPLATETITLE
    FROM ZENTRY e
    LEFT JOIN ZLOCATION l ON e.ZLOCATION = l.Z_PK
    LEFT JOIN ZWEATHER w ON e.ZWEATHER = w.Z_PK
    LEFT JOIN ZUSERACTIVITY ua ON e.ZUSERACTIVITY = ua.Z_PK
    LEFT JOIN ZTEMPLATE t ON e.ZTEMPLATE = t.Z_PK
    WHERE e.ZUUID IS NOT NULL
    ORDER BY e.ZCREATIONDATE ASC`
    )
    .all() as EntryRow[];

  console.log(`Found ${entries.length} entries in DayOne.sqlite`);

  // Read all entry-tag relationships
  const tagRows = sqlite
    .prepare(
      `SELECT jt.Z_17ENTRIES, t.ZNAME
     FROM Z_17TAGS jt
     JOIN ZTAG t ON t.Z_PK = jt.Z_64TAGS1`
    )
    .all() as TagRow[];

  // Group tags by entry Z_PK
  const tagsByEntry = new Map<number, string[]>();
  for (const row of tagRows) {
    const existing = tagsByEntry.get(row.Z_17ENTRIES) || [];
    existing.push(row.ZNAME);
    tagsByEntry.set(row.Z_17ENTRIES, existing);
  }

  // Read all attachments (including ZHASDATA for local file check)
  const attachmentRows = sqlite
    .prepare(
      `SELECT ZENTRY, ZTYPE, ZMD5, ZFILESIZE, ZWIDTH, ZHEIGHT,
            ZDURATION, ZCAMERAMAKE, ZCAMERAMODEL, ZHASDATA
     FROM ZATTACHMENT
     WHERE ZENTRY IS NOT NULL`
    )
    .all() as AttachmentRow[];

  // Group attachments by entry Z_PK
  const attachmentsByEntry = new Map<number, AttachmentRow[]>();
  for (const row of attachmentRows) {
    const existing = attachmentsByEntry.get(row.ZENTRY) || [];
    existing.push(row);
    attachmentsByEntry.set(row.ZENTRY, existing);
  }

  sqlite.close();

  // Connect to PostgreSQL
  const pool = new pg.Pool({ connectionString: databaseUrl });

  // Initialize R2 client if uploading media
  let r2Client: S3Client | null = null;
  if (!skipMedia && process.env.R2_ACCOUNT_ID) {
    r2Client = createClient();
    console.log("R2 media upload enabled");
  } else if (!skipMedia) {
    console.log(
      "R2 credentials not configured, skipping media upload (metadata only)"
    );
  } else {
    console.log("Media upload skipped (--skip-media)");
  }

  let synced = 0;
  let errors = 0;
  let mediaUploaded = 0;
  let mediaAlreadyInR2 = 0;
  let mediaNoData = 0;

  for (const entry of entries) {
    try {
      const stats = await syncEntry(
        pool,
        entry,
        tagsByEntry,
        attachmentsByEntry,
        r2Client,
        dayOneDir
      );
      mediaUploaded += stats.uploaded;
      mediaAlreadyInR2 += stats.skipped;
      mediaNoData += stats.noData;
      synced++;
      if (synced % 100 === 0) {
        console.log(`  Entries: ${synced}/${entries.length}...`);
      }
    } catch (err) {
      errors++;
      console.error(
        `  Error syncing ${entry.ZUUID}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  console.log(
    `\nDone. Entries synced: ${synced}, Errors: ${errors}, Total: ${entries.length}`
  );
  if (r2Client) {
    console.log(
      `Media uploaded: ${mediaUploaded}, Already in R2: ${mediaAlreadyInR2}, iCloud-only (skipped): ${mediaNoData}`
    );
  }
  await pool.end();
}

async function syncEntry(
  pool: pg.Pool,
  entry: EntryRow,
  tagsByEntry: Map<number, string[]>,
  attachmentsByEntry: Map<number, AttachmentRow[]>,
  r2Client: S3Client | null,
  dayOneDir: string
): Promise<{ uploaded: number; skipped: number; noData: number }> {
  const stats = { uploaded: 0, skipped: 0, noData: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Parse timezone from BLOB — it's a binary plist (NSKeyedArchiver)
    // containing an IANA timezone name like "America/Los_Angeles"
    let timezone: string | null = null;
    if (entry.ZTIMEZONE) {
      const raw =
        entry.ZTIMEZONE instanceof Buffer
          ? entry.ZTIMEZONE.toString("utf-8")
          : String(entry.ZTIMEZONE);
      const match = raw.match(/([A-Z][a-z]+(?:\/[A-Za-z_-]+[a-z])+)/);
      timezone = match ? match[1] : sanitize(raw);
    }

    // Upsert entry
    const result = await client.query(
      `INSERT INTO entries (
        uuid, text, rich_text, created_at, modified_at, timezone,
        is_all_day, is_pinned, starred, editing_time, duration,
        creation_device, device_model, device_type, os_name, os_version,
        latitude, longitude, city, country, place_name, admin_area,
        temperature, weather_conditions, humidity, moon_phase, sunrise, sunset,
        user_activity, step_count, template_name, source_string
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
        $23, $24, $25, $26, $27, $28, $29, $30, $31, $32
      )
      ON CONFLICT (uuid) DO UPDATE SET
        text = EXCLUDED.text,
        rich_text = EXCLUDED.rich_text,
        modified_at = EXCLUDED.modified_at,
        timezone = EXCLUDED.timezone,
        is_all_day = EXCLUDED.is_all_day,
        is_pinned = EXCLUDED.is_pinned,
        starred = EXCLUDED.starred,
        editing_time = EXCLUDED.editing_time,
        duration = EXCLUDED.duration,
        creation_device = EXCLUDED.creation_device,
        device_model = EXCLUDED.device_model,
        device_type = EXCLUDED.device_type,
        os_name = EXCLUDED.os_name,
        os_version = EXCLUDED.os_version,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        city = EXCLUDED.city,
        country = EXCLUDED.country,
        place_name = EXCLUDED.place_name,
        admin_area = EXCLUDED.admin_area,
        temperature = EXCLUDED.temperature,
        weather_conditions = EXCLUDED.weather_conditions,
        humidity = EXCLUDED.humidity,
        moon_phase = EXCLUDED.moon_phase,
        sunrise = EXCLUDED.sunrise,
        sunset = EXCLUDED.sunset,
        user_activity = EXCLUDED.user_activity,
        step_count = EXCLUDED.step_count,
        template_name = EXCLUDED.template_name,
        source_string = EXCLUDED.source_string
      RETURNING id`,
      [
        entry.ZUUID,
        entry.ZMARKDOWNTEXT ? normalizeText(entry.ZMARKDOWNTEXT) : null,
        sanitize(entry.ZRICHTEXTJSON ?? null),
        coreDataToIso(entry.ZCREATIONDATE),
        coreDataToIso(entry.ZMODIFIEDDATE),
        timezone,
        entry.ZISALLDAY === 1,
        entry.ZISPINNED === 1,
        entry.ZSTARRED === 1,
        entry.ZEDITINGTIME ?? null,
        entry.ZDURATION ?? null,
        sanitize(entry.ZCREATIONDEVICE ?? null),
        sanitize(entry.ZCREATIONDEVICEMODEL ?? null),
        sanitize(entry.ZCREATIONDEVICETYPE ?? null),
        sanitize(entry.ZCREATIONOSNAME ?? null),
        sanitize(entry.ZCREATIONOSVERSION ?? null),
        entry.ZLATITUDE ?? null,
        entry.ZLONGITUDE ?? null,
        sanitize(entry.ZLOCALITYNAME ?? null),
        sanitize(entry.ZCOUNTRY ?? null),
        sanitize(entry.ZPLACENAME ?? null),
        sanitize(entry.ZADMINISTRATIVEAREA ?? null),
        entry.ZTEMPERATURECELSIUS ?? null,
        sanitize(entry.ZCONDITIONSDESCRIPTION ?? null),
        entry.ZRELATIVEHUMIDITY ?? null,
        entry.ZMOONPHASE ?? null,
        coreDataToIso(entry.ZSUNRISEDATE),
        coreDataToIso(entry.ZSUNSETDATE),
        sanitize(entry.ZACTIVITYNAME ?? null),
        entry.ZSTEPCOUNT ?? null,
        sanitize(entry.ZTEMPLATETITLE ?? null),
        sanitize(entry.ZSOURCESTRING ?? null),
      ]
    );

    const entryId = result.rows[0].id as number;

    // Clear existing tag associations
    await client.query("DELETE FROM entry_tags WHERE entry_id = $1", [entryId]);

    // Upsert tags
    const tags = tagsByEntry.get(entry.Z_PK) || [];
    for (const tag of tags) {
      await client.query(
        "INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
        [tag]
      );
      const tagResult = await client.query(
        "SELECT id FROM tags WHERE name = $1",
        [tag]
      );
      const tagId = tagResult.rows[0].id as number;
      await client.query(
        "INSERT INTO entry_tags (entry_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [entryId, tagId]
      );
    }

    // Clear existing media
    await client.query("DELETE FROM media WHERE entry_id = $1", [entryId]);

    // Insert attachments and upload to R2
    const attachments = attachmentsByEntry.get(entry.Z_PK) || [];
    for (const att of attachments) {
      const mediaType = mapMediaType(att.ZTYPE);
      if (!mediaType) continue;

      const dimensions =
        att.ZWIDTH && att.ZHEIGHT
          ? JSON.stringify({ width: att.ZWIDTH, height: att.ZHEIGHT })
          : null;
      const cameraInfo =
        att.ZCAMERAMAKE || att.ZCAMERAMODEL
          ? JSON.stringify({ make: att.ZCAMERAMAKE, model: att.ZCAMERAMODEL })
          : null;

      let storageKey: string | null = null;
      let url: string | null = null;

      // Upload to R2 if client is available, file has data, and md5 exists
      if (r2Client && att.ZMD5) {
        if (!att.ZHASDATA) {
          stats.noData++;
        } else {
          const ext = getFileExtension(att);
          storageKey = buildStorageKey(mediaType, att.ZMD5, ext);

          const alreadyUploaded = await mediaExists(r2Client, storageKey);
          if (alreadyUploaded) {
            url = getPublicUrl(storageKey);
            stats.skipped++;
          } else {
            const dir = dayOneMediaDir(mediaType);
            const localPath = path.join(dayOneDir, dir, `${att.ZMD5}.${ext}`);

            if (fs.existsSync(localPath)) {
              url = await uploadMedia(r2Client, localPath, storageKey);
              stats.uploaded++;
            } else {
              console.warn(`  File not found: ${localPath}`);
              storageKey = null;
            }
          }
        }
      }

      await client.query(
        `INSERT INTO media (entry_id, type, md5, file_size, dimensions, duration, camera_info, storage_key, url)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)`,
        [
          entryId,
          mediaType,
          att.ZMD5 ?? null,
          att.ZFILESIZE ?? null,
          dimensions,
          att.ZDURATION ?? null,
          cameraInfo,
          storageKey,
          url,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return stats;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

syncDayOne().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
