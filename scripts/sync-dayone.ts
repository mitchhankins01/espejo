import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
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
  ZTIMEZONE: Buffer | string | null;
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
const newOnly = process.argv.includes("--new-only");
const SYNC_BATCH_SIZE = 50;

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

function elapsed(start: bigint): string {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function syncDayOne(): Promise<void> {
  const t0 = process.hrtime.bigint();
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
      e.ZMARKDOWNTEXT, e.ZTIMEZONE,
      l.ZLOCALITYNAME, l.ZCOUNTRY, l.ZPLACENAME, l.ZADMINISTRATIVEAREA,
      l.ZLATITUDE, l.ZLONGITUDE,
      w.ZTEMPERATURECELSIUS, w.ZCONDITIONSDESCRIPTION, w.ZRELATIVEHUMIDITY,
      w.ZMOONPHASE, w.ZSUNRISEDATE, w.ZSUNSETDATE
    FROM ZENTRY e
    LEFT JOIN ZLOCATION l ON e.ZLOCATION = l.Z_PK
    LEFT JOIN ZWEATHER w ON e.ZWEATHER = w.Z_PK
    WHERE e.ZUUID IS NOT NULL
    ORDER BY e.ZCREATIONDATE ASC`
    )
    .all() as EntryRow[];

  console.log(`Found ${entries.length} entries in DayOne.sqlite [${elapsed(t0)}]`);

  // Filter to new entries only (not yet in PostgreSQL)
  if (newOnly) {
    const checkPool = new pg.Pool({ connectionString: databaseUrl });
    const existing = await checkPool.query(`SELECT uuid FROM entries`);
    await checkPool.end();
    const existingUuids = new Set(existing.rows.map((r) => r.uuid as string));
    const before = entries.length;
    const filtered = entries.filter((e) => !existingUuids.has(e.ZUUID));
    entries.length = 0;
    entries.push(...filtered);
    console.log(`--new-only: ${before - entries.length} already synced, ${entries.length} new entries to sync`);
    if (entries.length === 0) {
      console.log("Nothing to sync.");
      return;
    }
  }

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
  console.log(`SQLite read complete [${elapsed(t0)}]`);

  // Connect to PostgreSQL
  console.log(`Connecting to PostgreSQL...`);
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

  // Verify connection works before starting the loop
  const connTest = process.hrtime.bigint();
  await pool.query("SELECT 1");
  console.log(`PostgreSQL connected [ping: ${elapsed(connTest)}]`);

  let synced = 0;
  let errors = 0;
  let mediaUploaded = 0;
  let mediaAlreadyInR2 = 0;
  let mediaNoData = 0;
  const totalBatches = Math.ceil(entries.length / SYNC_BATCH_SIZE);

  for (let i = 0; i < entries.length; i += SYNC_BATCH_SIZE) {
    const batch = entries.slice(i, i + SYNC_BATCH_SIZE);
    const batchNum = Math.floor(i / SYNC_BATCH_SIZE) + 1;
    const batchStart = process.hrtime.bigint();

    try {
      const batchStats = await syncBatch(
        pool,
        batch,
        tagsByEntry,
        attachmentsByEntry,
        r2Client,
        dayOneDir
      );
      mediaUploaded += batchStats.uploaded;
      mediaAlreadyInR2 += batchStats.skipped;
      mediaNoData += batchStats.noData;
      synced += batch.length;

      const batchMs = Number(process.hrtime.bigint() - batchStart) / 1e6;
      const perEntry = batchMs / batch.length;
      const remaining = entries.length - synced;
      const etaMin = (remaining * perEntry) / 60000;
      console.log(
        `  Batch ${batchNum}/${totalBatches}: ${synced}/${entries.length} [${elapsed(batchStart)}, ~${perEntry.toFixed(0)}ms/entry, ETA: ${etaMin.toFixed(1)}min]`
      );
    } catch (err) {
      errors += batch.length;
      console.error(
        `  Error in batch ${batchNum}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  console.log(
    `\nDone. Entries synced: ${synced}, Errors: ${errors}, Total: ${entries.length} [${elapsed(t0)}]`
  );
  if (r2Client) {
    console.log(
      `Media uploaded: ${mediaUploaded}, Already in R2: ${mediaAlreadyInR2}, iCloud-only (skipped): ${mediaNoData}`
    );
  }
  await pool.end();
}

async function syncBatch(
  pool: pg.Pool,
  batch: EntryRow[],
  tagsByEntry: Map<number, string[]>,
  attachmentsByEntry: Map<number, AttachmentRow[]>,
  r2Client: S3Client | null,
  dayOneDir: string
): Promise<{ uploaded: number; skipped: number; noData: number }> {
  const stats = { uploaded: 0, skipped: 0, noData: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // --- 1. Prepare column arrays for batch entry upsert ---
    const col = {
      uuids: [] as string[],
      texts: [] as (string | null)[],
      createdAts: [] as (string | null)[],
      modifiedAts: [] as (string | null)[],
      timezones: [] as (string | null)[],
      latitudes: [] as (number | null)[],
      longitudes: [] as (number | null)[],
      cities: [] as (string | null)[],
      countries: [] as (string | null)[],
      placeNames: [] as (string | null)[],
      adminAreas: [] as (string | null)[],
      temperatures: [] as (number | null)[],
      weatherConditions: [] as (string | null)[],
      humidities: [] as (number | null)[],
      moonPhases: [] as (number | null)[],
      sunrises: [] as (string | null)[],
      sunsets: [] as (string | null)[],
    };

    for (const entry of batch) {
      // Parse timezone from BLOB (binary plist with IANA name like "America/Los_Angeles")
      let timezone: string | null = null;
      if (entry.ZTIMEZONE) {
        const raw =
          entry.ZTIMEZONE instanceof Buffer
            ? entry.ZTIMEZONE.toString("utf-8")
            : String(entry.ZTIMEZONE);
        const match = raw.match(/([A-Z][a-z]+(?:\/[A-Za-z_-]+[a-z])+)/);
        timezone = match ? match[1] : sanitize(raw);
      }

      col.uuids.push(entry.ZUUID);
      col.texts.push(entry.ZMARKDOWNTEXT ? normalizeText(entry.ZMARKDOWNTEXT) : null);
      col.createdAts.push(coreDataToIso(entry.ZCREATIONDATE));
      col.modifiedAts.push(coreDataToIso(entry.ZMODIFIEDDATE));
      col.timezones.push(timezone);
      col.latitudes.push(entry.ZLATITUDE ?? null);
      col.longitudes.push(entry.ZLONGITUDE ?? null);
      col.cities.push(sanitize(entry.ZLOCALITYNAME ?? null));
      col.countries.push(sanitize(entry.ZCOUNTRY ?? null));
      col.placeNames.push(sanitize(entry.ZPLACENAME ?? null));
      col.adminAreas.push(sanitize(entry.ZADMINISTRATIVEAREA ?? null));
      col.temperatures.push(entry.ZTEMPERATURECELSIUS ?? null);
      col.weatherConditions.push(sanitize(entry.ZCONDITIONSDESCRIPTION ?? null));
      col.humidities.push(entry.ZRELATIVEHUMIDITY ?? null);
      col.moonPhases.push(entry.ZMOONPHASE ?? null);
      col.sunrises.push(coreDataToIso(entry.ZSUNRISEDATE));
      col.sunsets.push(coreDataToIso(entry.ZSUNSETDATE));
    }

    // --- 2. Batch upsert entries (1 query for all 50) ---
    const entryResult = await client.query(
      `INSERT INTO entries (
        uuid, text, created_at, modified_at, timezone,
        latitude, longitude, city, country, place_name, admin_area,
        temperature, weather_conditions, humidity, moon_phase, sunrise, sunset
      )
      SELECT
        d_uuid, d_text, d_created, d_modified, d_tz,
        d_lat, d_lon, d_city, d_country, d_place, d_admin,
        d_temp, d_weather, d_humid, d_moon, d_sunrise, d_sunset
      FROM unnest(
        $1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[],
        $6::float8[], $7::float8[], $8::text[], $9::text[], $10::text[], $11::text[],
        $12::float8[], $13::text[], $14::float8[], $15::float8[], $16::timestamptz[], $17::timestamptz[]
      ) AS d(
        d_uuid, d_text, d_created, d_modified, d_tz,
        d_lat, d_lon, d_city, d_country, d_place, d_admin,
        d_temp, d_weather, d_humid, d_moon, d_sunrise, d_sunset
      )
      ON CONFLICT (uuid) DO UPDATE SET
        text = EXCLUDED.text,
        modified_at = EXCLUDED.modified_at,
        timezone = EXCLUDED.timezone,
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
        sunset = EXCLUDED.sunset
      RETURNING id, uuid`,
      [
        col.uuids, col.texts, col.createdAts, col.modifiedAts, col.timezones,
        col.latitudes, col.longitudes, col.cities, col.countries, col.placeNames, col.adminAreas,
        col.temperatures, col.weatherConditions, col.humidities, col.moonPhases, col.sunrises, col.sunsets,
      ]
    );

    // Build uuid → id map
    const idMap = new Map<string, number>();
    for (const row of entryResult.rows) {
      idMap.set(row.uuid as string, row.id as number);
    }
    const entryIds = entryResult.rows.map((r) => r.id as number);

    // --- 3. Batch delete old tag associations (1 query) ---
    await client.query(
      `DELETE FROM entry_tags WHERE entry_id = ANY($1::int[])`,
      [entryIds]
    );

    // --- 4. Batch upsert tags + entry_tags (3 queries) ---
    const allTagNames = new Set<string>();
    for (const entry of batch) {
      const tags = tagsByEntry.get(entry.Z_PK) || [];
      for (const t of tags) allTagNames.add(t);
    }

    if (allTagNames.size > 0) {
      const tagArr = Array.from(allTagNames);
      await client.query(
        `INSERT INTO tags (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
        [tagArr]
      );
      const tagResult = await client.query(
        `SELECT id, name FROM tags WHERE name = ANY($1::text[])`,
        [tagArr]
      );
      const tagIdMap = new Map<string, number>();
      for (const row of tagResult.rows) {
        tagIdMap.set(row.name as string, row.id as number);
      }

      const etEntryIds: number[] = [];
      const etTagIds: number[] = [];
      for (const entry of batch) {
        const entryId = idMap.get(entry.ZUUID)!;
        const tags = tagsByEntry.get(entry.Z_PK) || [];
        for (const tag of tags) {
          etEntryIds.push(entryId);
          etTagIds.push(tagIdMap.get(tag)!);
        }
      }

      if (etEntryIds.length > 0) {
        await client.query(
          `INSERT INTO entry_tags (entry_id, tag_id)
           SELECT * FROM unnest($1::int[], $2::int[])
           ON CONFLICT DO NOTHING`,
          [etEntryIds, etTagIds]
        );
      }
    }

    // --- 5. Batch delete old media (1 query) ---
    await client.query(
      `DELETE FROM media WHERE entry_id = ANY($1::int[])`,
      [entryIds]
    );

    // --- 6. Collect + batch insert media (1 query) ---
    const med = {
      entryIds: [] as number[],
      types: [] as string[],
      md5s: [] as (string | null)[],
      fileSizes: [] as (number | null)[],
      dimensions: [] as (string | null)[],
      durations: [] as (number | null)[],
      cameraInfos: [] as (string | null)[],
      storageKeys: [] as (string | null)[],
      urls: [] as (string | null)[],
    };

    for (const entry of batch) {
      const entryId = idMap.get(entry.ZUUID)!;
      const attachments = attachmentsByEntry.get(entry.Z_PK) || [];
      for (const att of attachments) {
        const mediaType = mapMediaType(att.ZTYPE);
        if (!mediaType) continue;

        const dims =
          att.ZWIDTH && att.ZHEIGHT
            ? JSON.stringify({ width: att.ZWIDTH, height: att.ZHEIGHT })
            : null;
        const camInfo =
          att.ZCAMERAMAKE || att.ZCAMERAMODEL
            ? JSON.stringify({ make: att.ZCAMERAMAKE, model: att.ZCAMERAMODEL })
            : null;

        let storageKey: string | null = null;
        let url: string | null = null;

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

        med.entryIds.push(entryId);
        med.types.push(mediaType);
        med.md5s.push(att.ZMD5 ?? null);
        med.fileSizes.push(att.ZFILESIZE ?? null);
        med.dimensions.push(dims);
        med.durations.push(att.ZDURATION ?? null);
        med.cameraInfos.push(camInfo);
        med.storageKeys.push(storageKey);
        med.urls.push(url);
      }
    }

    if (med.entryIds.length > 0) {
      await client.query(
        `INSERT INTO media (entry_id, type, md5, file_size, dimensions, duration, camera_info, storage_key, url)
         SELECT me, mt, mm, mf, md::jsonb, mdu, mc::jsonb, ms, mu
         FROM unnest(
           $1::int[], $2::text[], $3::text[], $4::int[], $5::text[],
           $6::float8[], $7::text[], $8::text[], $9::text[]
         ) AS t(me, mt, mm, mf, md, mdu, mc, ms, mu)`,
        [med.entryIds, med.types, med.md5s, med.fileSizes, med.dimensions,
         med.durations, med.cameraInfos, med.storageKeys, med.urls]
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
