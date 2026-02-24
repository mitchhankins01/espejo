import dotenv from "dotenv";
if (process.env.NODE_ENV !== "production") {
  dotenv.config({
    path: process.env.NODE_ENV === "test" ? ".env.test" : ".env",
    override: true,
  });
}
import crypto from "crypto";
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import pg from "pg";
import {
  createClient,
  uploadMedia,
  mediaExists,
  getPublicUrl,
} from "../src/storage/r2.js";
import type { S3Client } from "../src/storage/r2.js";

type MediaType = "photo" | "video" | "audio";

interface SyncedMediaItem {
  type: MediaType;
  md5: string | null;
  fileSize: number | null;
  dimensions: { width: number; height: number } | null;
  duration: number | null;
  cameraInfo: Record<string, unknown> | null;
  location: Record<string, unknown> | null;
  storageKey: string | null;
  url: string | null;
}

interface ParsedEntry {
  sourcePath: string;
  uuid: string;
  text: string | null;
  createdAt: string;
  modifiedAt: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  country: string | null;
  placeName: string | null;
  adminArea: string | null;
  temperature: number | null;
  weatherConditions: string | null;
  humidity: number | null;
  moonPhase: number | null;
  sunrise: string | null;
  sunset: string | null;
  tags: string[];
  media: SyncedMediaItem[];
  frontmatter: Record<string, unknown>;
  bodyRaw: string;
  frontmatterUpdated: boolean;
}

interface BatchStats {
  uploaded: number;
  skipped: number;
  ignored: number;
  unresolved: number;
}

const GENERATED_MEDIA_BLOCK_REGEX =
  /<!--\s*espejo:media:start\s*-->[\s\S]*?<!--\s*espejo:media:end\s*-->/gi;
const WIKI_EMBED_REGEX = /!\[\[([^\]]+)\]\]/g;
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\(([^)]+)\)/g;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "heic", "tiff", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mov", "mp4", "m4v", "avi", "webm"]);
const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "wav", "aac", "caf", "ogg", "flac"]);

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://dev:dev@localhost:5434/journal_dev";

const skipMedia = process.argv.includes("--skip-media");
const newOnly = process.argv.includes("--new-only");
const dryRun = process.argv.includes("--dry-run");
const writeFrontmatter = process.argv.includes("--write-frontmatter");
const SYNC_BATCH_SIZE = 50;

function elapsed(start: bigint): string {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
}

function getVaultPath(): string {
  const fromFlag = getArgValue("--vault-path");
  if (fromFlag) {
    return path.resolve(fromFlag);
  }

  if (process.env.OBSIDIAN_VAULT_PATH) {
    return path.resolve(process.env.OBSIDIAN_VAULT_PATH);
  }

  console.error(
    "Error: No vault path provided.\n\n" +
      "Set OBSIDIAN_VAULT_PATH in your .env file or pass --vault-path:\n" +
      "  pnpm sync -- --vault-path /path/to/vault/journal"
  );
  process.exit(1);
}

function getAttachmentsPath(vaultPath: string): string | null {
  const fromFlag = getArgValue("--attachments-path");
  if (fromFlag) {
    return path.resolve(fromFlag);
  }

  if (process.env.OBSIDIAN_ATTACHMENTS_PATH) {
    return path.resolve(process.env.OBSIDIAN_ATTACHMENTS_PATH);
  }

  const defaultPath = path.join(vaultPath, "attachments");
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

function walkMarkdownFiles(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

function sanitizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\0/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function sanitizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseDateToIso(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const tags = raw
      .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
      .filter((tag) => tag.length > 0);
    return Array.from(new Set(tags));
  }

  if (typeof raw === "string") {
    const tags = raw
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    return Array.from(new Set(tags));
  }

  return [];
}

function normalizeDimensions(
  raw: unknown
): { width: number; height: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const width = sanitizeNumber((raw as { width?: unknown }).width);
  const height = sanitizeNumber((raw as { height?: unknown }).height);
  if (width == null || height == null) return null;
  return { width, height };
}

function normalizeMediaType(value: unknown): MediaType | null {
  if (value === "photo" || value === "video" || value === "audio") {
    return value;
  }
  return null;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeFrontmatterMedia(raw: unknown): SyncedMediaItem[] {
  if (!Array.isArray(raw)) return [];

  const media: SyncedMediaItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const type = normalizeMediaType(obj.type);
    if (!type) continue;

    media.push({
      type,
      md5: sanitizeString(obj.md5),
      fileSize: sanitizeNumber(obj.file_size),
      dimensions: normalizeDimensions(obj.dimensions),
      duration: sanitizeNumber(obj.duration),
      cameraInfo: normalizeJsonObject(obj.camera_info),
      location: normalizeJsonObject(obj.location),
      storageKey: sanitizeString(obj.storage_key),
      url: sanitizeString(obj.url),
    });
  }

  return media;
}

function stripGeneratedMediaBlock(text: string): string {
  return text.replace(GENERATED_MEDIA_BLOCK_REGEX, "");
}

function normalizeText(text: string): string {
  return (
    stripGeneratedMediaBlock(text)
      // Strip null bytes (PostgreSQL rejects 0x00 in text/json columns)
      .replace(/\0/g, "")
      // Strip local media embed syntax but preserve intentional remote references.
      .replace(WIKI_EMBED_REGEX, (full, rawRef) => {
        const ref = normalizeReference(String(rawRef ?? ""));
        return isLikelyMediaReference(ref) ? "" : full;
      })
      .replace(MARKDOWN_IMAGE_REGEX, (full, rawRef) => {
        const ref = normalizeReference(String(rawRef ?? ""));
        if (isRemoteReference(ref)) return full;
        return isLikelyMediaReference(ref) ? "" : full;
      })
      // Normalize invisible unicode
      .replace(/\u2028/g, "\n")
      .replace(/[\u200B\u200D]/g, "")
      .replace(/[\u202C\u202D]/g, "")
      .replace(/\u2003/g, " ")
      // Collapse excessive spacing
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function extractRefsWithRegex(regex: RegExp, content: string): string[] {
  const refs: string[] = [];
  regex.lastIndex = 0;

  let match = regex.exec(content);
  while (match) {
    refs.push(match[1]);
    match = regex.exec(content);
  }

  return refs;
}

function normalizeReference(raw: string): string {
  let ref = raw.trim();

  if (ref.startsWith("<") && ref.endsWith(">")) {
    ref = ref.slice(1, -1).trim();
  }

  if (ref.includes("|")) {
    ref = ref.split("|")[0].trim();
  }

  if (ref.includes("#")) {
    ref = ref.split("#")[0].trim();
  }

  if ((ref.startsWith('"') && ref.endsWith('"')) || (ref.startsWith("'") && ref.endsWith("'"))) {
    ref = ref.slice(1, -1).trim();
  }

  try {
    ref = decodeURIComponent(ref);
  } catch {
    // Keep original reference if malformed URI sequence.
  }

  return ref;
}

function isRemoteReference(ref: string): boolean {
  const lower = ref.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("data:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:")
  );
}

function mapExtensionToMediaType(ext: string): MediaType | null {
  if (IMAGE_EXTENSIONS.has(ext)) return "photo";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return null;
}

function isLikelyMediaReference(ref: string): boolean {
  const ext = path.extname(ref.toLowerCase()).slice(1);
  return mapExtensionToMediaType(ext) !== null;
}

function computeMd5(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(buffer).digest("hex");
}

function buildStorageKey(type: MediaType, md5: string, ext: string): string {
  return `${type}s/${md5}.${ext}`;
}

function mediaIdentity(item: SyncedMediaItem): string {
  if (item.storageKey) return `storage:${item.storageKey}`;
  if (item.md5) return `md5:${item.type}:${item.md5}`;
  if (item.url) return `url:${item.url}`;
  return `anon:${item.type}:${crypto.randomUUID()}`;
}

function dedupeMedia(items: SyncedMediaItem[]): SyncedMediaItem[] {
  const deduped: SyncedMediaItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const id = mediaIdentity(item);
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(item);
  }

  return deduped;
}

function resolveMediaPath(
  ref: string,
  notePath: string,
  vaultPath: string,
  attachmentsPath: string | null
): string | null {
  const normalized = ref.replace(/\\/g, "/");
  const candidates = new Set<string>();

  if (normalized.startsWith("/")) {
    candidates.add(path.resolve(vaultPath, `.${normalized}`));
  }

  candidates.add(path.resolve(path.dirname(notePath), normalized));
  candidates.add(path.resolve(vaultPath, normalized));

  if (attachmentsPath) {
    candidates.add(path.resolve(attachmentsPath, normalized));
    candidates.add(path.resolve(attachmentsPath, path.basename(normalized)));
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
  }

  return null;
}

function atomicWrite(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

function parseEntry(notePath: string): ParsedEntry | null {
  const raw = fs.readFileSync(notePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;

  const uuid = sanitizeString(data.uuid);
  if (!uuid) {
    console.warn(`Skipping ${notePath}: frontmatter.uuid is required.`);
    return null;
  }

  const createdAt = parseDateToIso(data.created);
  if (!createdAt) {
    console.warn(`Skipping ${notePath}: frontmatter.created must be a valid ISO timestamp.`);
    return null;
  }

  const modifiedAt = parseDateToIso(data.modified);
  const timezone = sanitizeString(data.timezone);

  const location = normalizeJsonObject(data.location) ?? {};
  const weather = normalizeJsonObject(data.weather) ?? {};

  const text = normalizeText(parsed.content);
  const media = normalizeFrontmatterMedia(data.media);

  return {
    sourcePath: notePath,
    uuid,
    text: text.length > 0 ? text : null,
    createdAt,
    modifiedAt,
    timezone,
    latitude: sanitizeNumber((location as { latitude?: unknown }).latitude),
    longitude: sanitizeNumber((location as { longitude?: unknown }).longitude),
    city: sanitizeString((location as { city?: unknown }).city),
    country: sanitizeString((location as { country?: unknown }).country),
    placeName: sanitizeString((location as { place_name?: unknown }).place_name),
    adminArea: sanitizeString((location as { admin_area?: unknown }).admin_area),
    temperature: sanitizeNumber((weather as { temperature?: unknown }).temperature),
    weatherConditions: sanitizeString((weather as { conditions?: unknown }).conditions),
    humidity: sanitizeNumber((weather as { humidity?: unknown }).humidity),
    moonPhase: sanitizeNumber((weather as { moon_phase?: unknown }).moon_phase),
    sunrise: parseDateToIso((weather as { sunrise?: unknown }).sunrise),
    sunset: parseDateToIso((weather as { sunset?: unknown }).sunset),
    tags: normalizeTags(data.tags),
    media: dedupeMedia(media),
    frontmatter: data,
    bodyRaw: parsed.content,
    frontmatterUpdated: false,
  };
}

async function enrichMediaFromBody(
  entry: ParsedEntry,
  vaultPath: string,
  attachmentsPath: string | null,
  r2Client: S3Client | null,
  summary: BatchStats
): Promise<void> {
  const contentForScan = stripGeneratedMediaBlock(entry.bodyRaw);
  const rawRefs = [
    ...extractRefsWithRegex(WIKI_EMBED_REGEX, contentForScan),
    ...extractRefsWithRegex(MARKDOWN_IMAGE_REGEX, contentForScan),
  ];

  const refs = Array.from(
    new Set(
      rawRefs
        .map((ref) => normalizeReference(ref))
        .filter((ref) => ref.length > 0 && !isRemoteReference(ref))
    )
  );

  if (refs.length === 0) return;

  const existingByStorage = new Map<string, SyncedMediaItem>();
  const existingByMd5 = new Map<string, SyncedMediaItem>();
  for (const item of entry.media) {
    if (item.storageKey) existingByStorage.set(item.storageKey, item);
    if (item.md5) existingByMd5.set(`${item.type}:${item.md5}`, item);
  }

  for (const ref of refs) {
    const resolved = resolveMediaPath(ref, entry.sourcePath, vaultPath, attachmentsPath);
    if (!resolved) {
      summary.unresolved++;
      continue;
    }

    const ext = path.extname(resolved).slice(1).toLowerCase();
    const mediaType = mapExtensionToMediaType(ext);
    if (!mediaType) {
      summary.ignored++;
      continue;
    }

    const stat = fs.statSync(resolved);
    const md5 = computeMd5(resolved);
    const storageKey = buildStorageKey(mediaType, md5, ext);

    const existing =
      existingByStorage.get(storageKey) || existingByMd5.get(`${mediaType}:${md5}`);

    if (existing) {
      if (!existing.storageKey) existing.storageKey = storageKey;
      if (!existing.md5) existing.md5 = md5;
      if (!existing.fileSize) existing.fileSize = stat.size;
      continue;
    }

    let url: string | null = null;
    if (r2Client) {
      const alreadyUploaded = await mediaExists(r2Client, storageKey);
      if (alreadyUploaded) {
        url = getPublicUrl(storageKey);
        summary.skipped++;
      } else {
        url = await uploadMedia(r2Client, resolved, storageKey);
        summary.uploaded++;
      }
    }

    const item: SyncedMediaItem = {
      type: mediaType,
      md5,
      fileSize: stat.size,
      dimensions: null,
      duration: null,
      cameraInfo: null,
      location: null,
      storageKey,
      url,
    };

    entry.media.push(item);
    existingByStorage.set(storageKey, item);
    existingByMd5.set(`${mediaType}:${md5}`, item);
    entry.frontmatterUpdated = true;
  }

  entry.media = dedupeMedia(entry.media);
}

function mediaToFrontmatter(media: SyncedMediaItem[]): Record<string, unknown>[] {
  return media.map((item) => ({
    type: item.type,
    url: item.url,
    md5: item.md5,
    storage_key: item.storageKey,
    file_size: item.fileSize,
    dimensions: item.dimensions,
    duration: item.duration,
    camera_info: item.cameraInfo,
    location: item.location,
  }));
}

async function syncBatch(
  pool: pg.Pool,
  batch: ParsedEntry[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const col = {
      uuids: [] as string[],
      texts: [] as (string | null)[],
      createdAts: [] as string[],
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
      col.uuids.push(entry.uuid);
      col.texts.push(entry.text);
      col.createdAts.push(entry.createdAt);
      col.modifiedAts.push(entry.modifiedAt);
      col.timezones.push(entry.timezone);
      col.latitudes.push(entry.latitude);
      col.longitudes.push(entry.longitude);
      col.cities.push(entry.city);
      col.countries.push(entry.country);
      col.placeNames.push(entry.placeName);
      col.adminAreas.push(entry.adminArea);
      col.temperatures.push(entry.temperature);
      col.weatherConditions.push(entry.weatherConditions);
      col.humidities.push(entry.humidity);
      col.moonPhases.push(entry.moonPhase);
      col.sunrises.push(entry.sunrise);
      col.sunsets.push(entry.sunset);
    }

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
        col.uuids,
        col.texts,
        col.createdAts,
        col.modifiedAts,
        col.timezones,
        col.latitudes,
        col.longitudes,
        col.cities,
        col.countries,
        col.placeNames,
        col.adminAreas,
        col.temperatures,
        col.weatherConditions,
        col.humidities,
        col.moonPhases,
        col.sunrises,
        col.sunsets,
      ]
    );

    const idMap = new Map<string, number>();
    for (const row of entryResult.rows) {
      idMap.set(row.uuid as string, row.id as number);
    }

    const entryIds = entryResult.rows.map((row) => row.id as number);

    await client.query(`DELETE FROM entry_tags WHERE entry_id = ANY($1::int[])`, [
      entryIds,
    ]);

    const allTagNames = new Set<string>();
    for (const entry of batch) {
      for (const tag of entry.tags) allTagNames.add(tag);
    }

    if (allTagNames.size > 0) {
      const tagArr = Array.from(allTagNames);
      await client.query(
        `INSERT INTO tags (name)
         SELECT unnest($1::text[])
         ON CONFLICT (name) DO NOTHING`,
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
        const entryId = idMap.get(entry.uuid);
        if (!entryId) continue;

        for (const tag of entry.tags) {
          const tagId = tagIdMap.get(tag);
          if (!tagId) continue;
          etEntryIds.push(entryId);
          etTagIds.push(tagId);
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

    await client.query(`DELETE FROM media WHERE entry_id = ANY($1::int[])`, [entryIds]);

    const med = {
      entryIds: [] as number[],
      types: [] as MediaType[],
      md5s: [] as (string | null)[],
      fileSizes: [] as (number | null)[],
      dimensions: [] as (string | null)[],
      durations: [] as (number | null)[],
      cameraInfos: [] as (string | null)[],
      locations: [] as (string | null)[],
      storageKeys: [] as (string | null)[],
      urls: [] as (string | null)[],
    };

    for (const entry of batch) {
      const entryId = idMap.get(entry.uuid);
      if (!entryId) continue;

      for (const item of entry.media) {
        med.entryIds.push(entryId);
        med.types.push(item.type);
        med.md5s.push(item.md5);
        med.fileSizes.push(item.fileSize);
        med.dimensions.push(item.dimensions ? JSON.stringify(item.dimensions) : null);
        med.durations.push(item.duration);
        med.cameraInfos.push(
          item.cameraInfo ? JSON.stringify(item.cameraInfo) : null
        );
        med.locations.push(item.location ? JSON.stringify(item.location) : null);
        med.storageKeys.push(item.storageKey);
        med.urls.push(item.url);
      }
    }

    if (med.entryIds.length > 0) {
      await client.query(
        `INSERT INTO media (
           entry_id, type, md5, file_size, dimensions,
           duration, camera_info, location, storage_key, url
         )
         SELECT me, mt, mm, mf, md::jsonb, mdu, mc::jsonb, ml::jsonb, ms, mu
         FROM unnest(
           $1::int[], $2::text[], $3::text[], $4::int[], $5::text[],
           $6::float8[], $7::text[], $8::text[], $9::text[], $10::text[]
         ) AS t(me, mt, mm, mf, md, mdu, mc, ml, ms, mu)`,
        [
          med.entryIds,
          med.types,
          med.md5s,
          med.fileSizes,
          med.dimensions,
          med.durations,
          med.cameraInfos,
          med.locations,
          med.storageKeys,
          med.urls,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function syncObsidian(): Promise<void> {
  const t0 = process.hrtime.bigint();
  const vaultPath = getVaultPath();
  const attachmentsPath = getAttachmentsPath(vaultPath);

  if (!fs.existsSync(vaultPath)) {
    throw new Error(`Vault path does not exist: ${vaultPath}`);
  }

  console.log(`Reading notes from: ${vaultPath}`);
  if (attachmentsPath) {
    console.log(`Attachments path: ${attachmentsPath}`);
  }

  const notePaths = walkMarkdownFiles(vaultPath);
  console.log(`Found ${notePaths.length} markdown files [${elapsed(t0)}]`);

  const parsedEntries: ParsedEntry[] = [];
  let skippedInvalid = 0;
  for (const notePath of notePaths) {
    const parsed = parseEntry(notePath);
    if (!parsed) {
      skippedInvalid++;
      continue;
    }
    parsedEntries.push(parsed);
  }

  if (skippedInvalid > 0) {
    console.log(`Skipped invalid notes: ${skippedInvalid}`);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    if (newOnly) {
      const existing = await pool.query(`SELECT uuid FROM entries`);
      const existingUuids = new Set(existing.rows.map((row) => row.uuid as string));
      const before = parsedEntries.length;
      const filtered = parsedEntries.filter((entry) => !existingUuids.has(entry.uuid));
      parsedEntries.length = 0;
      parsedEntries.push(...filtered);
      console.log(
        `--new-only: ${before - parsedEntries.length} already synced, ${parsedEntries.length} new notes to sync`
      );
      if (parsedEntries.length === 0) {
        console.log("Nothing to sync.");
        return;
      }
    }

    let r2Client: S3Client | null = null;
    if (!skipMedia && process.env.R2_ACCOUNT_ID) {
      r2Client = createClient();
      console.log("R2 media upload enabled");
    } else if (!skipMedia) {
      console.log(
        "R2 credentials not configured, syncing media metadata without uploads"
      );
    } else {
      console.log("Media sync skipped (--skip-media)");
    }

    const mediaStats: BatchStats = {
      uploaded: 0,
      skipped: 0,
      ignored: 0,
      unresolved: 0,
    };

    let pendingFrontmatterWrites = 0;
    if (!skipMedia) {
      for (const entry of parsedEntries) {
        await enrichMediaFromBody(
          entry,
          vaultPath,
          attachmentsPath,
          r2Client,
          mediaStats
        );

        if (writeFrontmatter && entry.frontmatterUpdated) {
          if (!dryRun) {
            const updatedFrontmatter = {
              ...entry.frontmatter,
              media: mediaToFrontmatter(entry.media),
            };
            const next = matter.stringify(entry.bodyRaw, updatedFrontmatter, {
              lineWidth: 0,
            });
            atomicWrite(entry.sourcePath, next);
          }
        }
        if (entry.frontmatterUpdated && !writeFrontmatter) {
          pendingFrontmatterWrites++;
        }
      }
    }

    if (dryRun) {
      console.log(
        `[dry-run] Parsed ${parsedEntries.length} notes. No database or file writes were performed.`
      );
      console.log(
        `[dry-run] Media: uploaded=${mediaStats.uploaded}, already_in_r2=${mediaStats.skipped}, unresolved_refs=${mediaStats.unresolved}, ignored_refs=${mediaStats.ignored}`
      );
      if (pendingFrontmatterWrites > 0 && !writeFrontmatter) {
        console.log(
          `[dry-run] ${pendingFrontmatterWrites} notes have new media metadata that was not written back (pass --write-frontmatter to persist).`
        );
      }
      return;
    }

    if (pendingFrontmatterWrites > 0 && !writeFrontmatter) {
      console.log(
        `Media metadata detected for ${pendingFrontmatterWrites} notes but not written to frontmatter (pass --write-frontmatter to persist).`
      );
    }

    const connTest = process.hrtime.bigint();
    await pool.query("SELECT 1");
    console.log(`PostgreSQL connected [ping: ${elapsed(connTest)}]`);

    const totalBatches = Math.ceil(parsedEntries.length / SYNC_BATCH_SIZE);
    let synced = 0;

    for (let i = 0; i < parsedEntries.length; i += SYNC_BATCH_SIZE) {
      const batch = parsedEntries.slice(i, i + SYNC_BATCH_SIZE);
      const batchNum = Math.floor(i / SYNC_BATCH_SIZE) + 1;
      const batchStart = process.hrtime.bigint();

      await syncBatch(pool, batch);
      synced += batch.length;

      const batchMs = Number(process.hrtime.bigint() - batchStart) / 1e6;
      const perEntry = batchMs / batch.length;
      const remaining = parsedEntries.length - synced;
      const etaMin = (remaining * perEntry) / 60000;

      console.log(
        `  Batch ${batchNum}/${totalBatches}: ${synced}/${parsedEntries.length} [${elapsed(batchStart)}, ~${perEntry.toFixed(0)}ms/note, ETA: ${etaMin.toFixed(1)}min]`
      );
    }

    console.log(
      `\nDone. Notes synced: ${synced}, Total: ${parsedEntries.length} [${elapsed(t0)}]`
    );

    if (!skipMedia) {
      console.log(
        `Media uploaded: ${mediaStats.uploaded}, Already in R2: ${mediaStats.skipped}, Unresolved refs: ${mediaStats.unresolved}, Unsupported refs: ${mediaStats.ignored}`
      );
    }
  } finally {
    await pool.end();
  }
}

syncObsidian().catch((error: unknown) => {
  console.error("Obsidian sync failed:", error);
  process.exit(1);
});
