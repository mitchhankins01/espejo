import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import pg from "pg";

interface ExportMediaRow {
  type: "photo" | "video" | "audio";
  url: string | null;
  md5: string | null;
  storage_key: string | null;
  file_size: number | null;
  dimensions: { width: number; height: number } | null;
  duration: number | null;
  camera_info: Record<string, unknown> | null;
  location: Record<string, unknown> | null;
}

interface ExportEntryRow {
  uuid: string;
  text: string | null;
  created_at: Date;
  modified_at: Date | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  country: string | null;
  place_name: string | null;
  admin_area: string | null;
  temperature: number | null;
  weather_conditions: string | null;
  humidity: number | null;
  moon_phase: number | null;
  sunrise: Date | null;
  sunset: Date | null;
  tags: string[];
  media: ExportMediaRow[];
}

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://dev:dev@localhost:5434/journal_dev";

function getVaultPath(): string {
  const flagIdx = process.argv.indexOf("--vault-path");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    return path.resolve(process.argv[flagIdx + 1]);
  }

  if (process.env.OBSIDIAN_VAULT_PATH) {
    return path.resolve(process.env.OBSIDIAN_VAULT_PATH);
  }

  console.error(
    "Error: No vault path provided.\n\n" +
      "Set OBSIDIAN_VAULT_PATH in your .env file or pass --vault-path:\n" +
      "  pnpm export:obsidian -- --vault-path /path/to/vault/journal"
  );
  process.exit(1);
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function maybeObject<T extends Record<string, unknown>>(obj: T): T | undefined {
  return Object.values(obj).some((v) => v != null) ? obj : undefined;
}

function buildMediaRenderBlock(media: ExportMediaRow[]): string {
  const lines: string[] = [];
  for (const item of media) {
    if (!item.url) continue;
    if (item.type === "photo") {
      lines.push(`![](${item.url})`);
      continue;
    }
    if (item.type === "video") {
      lines.push(`[Video](${item.url})`);
      continue;
    }
    lines.push(`[Audio](${item.url})`);
  }

  if (lines.length === 0) return "";

  return [
    "<!-- espejo:media:start -->",
    ...lines,
    "<!-- espejo:media:end -->",
  ].join("\n");
}

function buildNote(entry: ExportEntryRow): string {
  const frontmatter: Record<string, unknown> = {
    uuid: entry.uuid,
    created: entry.created_at.toISOString(),
    modified: toIso(entry.modified_at),
    timezone: entry.timezone,
    tags: entry.tags,
  };

  const location = maybeObject({
    city: entry.city,
    country: entry.country,
    place_name: entry.place_name,
    admin_area: entry.admin_area,
    latitude: entry.latitude,
    longitude: entry.longitude,
  });
  if (location) frontmatter.location = location;

  const weather = maybeObject({
    conditions: entry.weather_conditions,
    temperature: entry.temperature,
    humidity: entry.humidity,
    moon_phase: entry.moon_phase,
    sunrise: toIso(entry.sunrise),
    sunset: toIso(entry.sunset),
  });
  if (weather) frontmatter.weather = weather;

  frontmatter.media = entry.media.map((m) => ({
    type: m.type,
    url: m.url,
    md5: m.md5,
    storage_key: m.storage_key,
    file_size: m.file_size,
    dimensions: m.dimensions,
    duration: m.duration,
    camera_info: m.camera_info,
    location: m.location,
  }));

  const bodyParts: string[] = [];
  const text = entry.text?.replace(/\r\n/g, "\n").trim() ?? "";
  if (text) bodyParts.push(text);

  const mediaBlock = buildMediaRenderBlock(entry.media);
  if (mediaBlock) bodyParts.push(mediaBlock);

  return matter.stringify(bodyParts.join("\n\n"), frontmatter, {
    lineWidth: 0,
  });
}

function buildRelativePath(entry: ExportEntryRow): string {
  const createdIso = entry.created_at.toISOString();
  const datePart = createdIso.slice(0, 10);
  const year = datePart.slice(0, 4);
  const shortUuid = entry.uuid.slice(0, 8).toLowerCase();
  return path.join(year, `${datePart}-${shortUuid}.md`);
}

async function exportToObsidian(): Promise<void> {
  const vaultPath = getVaultPath();
  fs.mkdirSync(vaultPath, { recursive: true });

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query(
      `SELECT
         e.uuid,
         e.text,
         e.created_at,
         e.modified_at,
         e.timezone,
         e.latitude,
         e.longitude,
         e.city,
         e.country,
         e.place_name,
         e.admin_area,
         e.temperature,
         e.weather_conditions,
         e.humidity,
         e.moon_phase,
         e.sunrise,
         e.sunset,
         COALESCE(
           (SELECT array_agg(t.name ORDER BY t.name)
            FROM entry_tags et
            JOIN tags t ON t.id = et.tag_id
            WHERE et.entry_id = e.id),
           '{}'::text[]
         ) AS tags,
         (SELECT COALESCE(json_agg(json_build_object(
           'type', m.type,
           'url', m.url,
           'md5', m.md5,
           'storage_key', m.storage_key,
           'file_size', m.file_size,
           'dimensions', m.dimensions,
           'duration', m.duration,
           'camera_info', m.camera_info,
           'location', m.location
         ) ORDER BY m.id), '[]'::json)
         FROM media m
         WHERE m.entry_id = e.id) AS media
       FROM entries e
       ORDER BY e.created_at ASC`
    );

    const entries = result.rows as unknown as ExportEntryRow[];
    let written = 0;

    for (const entry of entries) {
      const relativePath = buildRelativePath(entry);
      const outPath = path.join(vaultPath, relativePath);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buildNote(entry), "utf8");
      written++;
    }

    console.log(`Exported ${written} notes to ${vaultPath}`);
  } finally {
    await pool.end();
  }
}

exportToObsidian().catch((error: unknown) => {
  console.error("Obsidian export failed:", error);
  process.exit(1);
});
