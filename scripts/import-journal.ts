import "dotenv/config";
import fs from "fs";
import pg from "pg";

// ---------------------------------------------------------------------------
// Day One export types
// ---------------------------------------------------------------------------

interface DayOneEntry {
  uuid: string;
  creationDate: string;
  modifiedDate?: string;
  text?: string;
  richText?: unknown;
  creationDevice?: string;
  creationDeviceModel?: string;
  creationDeviceType?: string;
  creationOSName?: string;
  creationOSVersion?: string;
  editingTime?: number;
  isAllDay?: boolean;
  isPinned?: boolean;
  starred?: boolean;
  timeZone?: string;
  duration?: number;
  location?: {
    latitude?: number;
    longitude?: number;
    localityName?: string;
    country?: string;
    placeName?: string;
    administrativeArea?: string;
  };
  weather?: {
    temperatureCelsius?: number;
    conditionsDescription?: string;
    relativeHumidity?: number;
    moonPhase?: number;
    sunriseDate?: string;
    sunsetDate?: string;
  };
  userActivity?: {
    activityName?: string;
    stepCount?: number;
  };
  tags?: string[];
  template?: {
    name?: string;
  };
  photos?: DayOneMedia[];
  videos?: DayOneMedia[];
  audios?: DayOneMedia[];
  sourceString?: string;
}

interface DayOneMedia {
  type?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  md5?: string;
  duration?: number;
  cameraMake?: string;
  cameraModel?: string;
  location?: unknown;
}

interface DayOneExport {
  entries: DayOneEntry[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://dev:dev@localhost:5432/journal_dev";

async function importJournal(filePath: string): Promise<void> {
  console.log(`Reading ${filePath}...`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const data: DayOneExport = JSON.parse(raw);

  console.log(`Found ${data.entries.length} entries.`);

  const pool = new pg.Pool({ connectionString: databaseUrl });

  let imported = 0;
  let errors = 0;

  for (const entry of data.entries) {
    try {
      await importEntry(pool, entry);
      imported++;
      if (imported % 100 === 0) {
        console.log(`  Imported ${imported}/${data.entries.length}...`);
      }
    } catch (err) {
      errors++;
      console.error(
        `  Error importing entry ${entry.uuid}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  console.log(
    `Done. Imported: ${imported}, Errors: ${errors}, Total: ${data.entries.length}`
  );
  await pool.end();
}

async function importEntry(pool: pg.Pool, entry: DayOneEntry): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

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
        entry.uuid,
        entry.text ?? null,
        entry.richText ? JSON.stringify(entry.richText) : null,
        entry.creationDate,
        entry.modifiedDate ?? null,
        entry.timeZone ?? null,
        entry.isAllDay ?? false,
        entry.isPinned ?? false,
        entry.starred ?? false,
        entry.editingTime ?? null,
        entry.duration ?? null,
        entry.creationDevice ?? null,
        entry.creationDeviceModel ?? null,
        entry.creationDeviceType ?? null,
        entry.creationOSName ?? null,
        entry.creationOSVersion ?? null,
        entry.location?.latitude ?? null,
        entry.location?.longitude ?? null,
        entry.location?.localityName ?? null,
        entry.location?.country ?? null,
        entry.location?.placeName ?? null,
        entry.location?.administrativeArea ?? null,
        entry.weather?.temperatureCelsius ?? null,
        entry.weather?.conditionsDescription ?? null,
        entry.weather?.relativeHumidity ?? null,
        entry.weather?.moonPhase ?? null,
        entry.weather?.sunriseDate ?? null,
        entry.weather?.sunsetDate ?? null,
        entry.userActivity?.activityName ?? null,
        entry.userActivity?.stepCount ?? null,
        entry.template?.name ?? null,
        entry.sourceString ?? null,
      ]
    );

    const entryId = result.rows[0].id as number;

    // Clear existing tag associations (for re-import)
    await client.query("DELETE FROM entry_tags WHERE entry_id = $1", [entryId]);

    // Upsert tags and create junction records
    if (entry.tags && entry.tags.length > 0) {
      for (const tag of entry.tags) {
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
    }

    // Clear existing media (for re-import)
    await client.query("DELETE FROM media WHERE entry_id = $1", [entryId]);

    // Insert media
    const mediaItems: Array<{ type: string; item: DayOneMedia }> = [];
    for (const photo of entry.photos ?? []) {
      mediaItems.push({ type: "photo", item: photo });
    }
    for (const video of entry.videos ?? []) {
      mediaItems.push({ type: "video", item: video });
    }
    for (const audio of entry.audios ?? []) {
      mediaItems.push({ type: "audio", item: audio });
    }

    for (const { type, item } of mediaItems) {
      const dimensions =
        item.width && item.height
          ? JSON.stringify({ width: item.width, height: item.height })
          : null;
      const cameraInfo =
        item.cameraMake || item.cameraModel
          ? JSON.stringify({
              make: item.cameraMake,
              model: item.cameraModel,
            })
          : null;

      await client.query(
        `INSERT INTO media (entry_id, type, md5, file_size, dimensions, duration, camera_info, location)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb)`,
        [
          entryId,
          type,
          item.md5 ?? null,
          item.fileSize ?? null,
          dimensions,
          item.duration ?? null,
          cameraInfo,
          item.location ? JSON.stringify(item.location) : null,
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
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: pnpm import -- <path-to-Journal.json>");
  process.exit(1);
}

importJournal(filePath).catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
