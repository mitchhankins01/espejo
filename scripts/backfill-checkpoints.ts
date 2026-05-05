import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else {
  dotenv.config({ path: ".env", override: true });
}

import pg from "pg";
import { config } from "../src/config.js";
import {
  createClient,
  getObjectContent,
  listAllObjects,
} from "../src/storage/r2.js";
import { insertCheckpointIdempotent } from "../src/db/queries/checkpoints.js";

const VAULT_BUCKET = "artifacts";
const PREFIX = "Checkpoint/";

interface ParsedBullet {
  hhmm: string;
  trigger: string;
  body: string;
  partVoice: string;
  resolution: string;
}

function parseBullet(line: string): ParsedBullet | null {
  const match = /^- (\d{2}:\d{2}) (.+)$/.exec(line);
  if (!match) return null;
  const hhmm = match[1];
  const segments = match[2].split(". ");
  if (segments.length < 4) return null;
  const [trigger, body, partVoice, ...rest] = segments;
  const last = rest.join(". ").trim();
  return {
    hhmm,
    trigger: trigger.trim(),
    body: body.trim(),
    partVoice: partVoice.trim(),
    resolution: normalizeResolution(last),
  };
}

function normalizeResolution(value: string): string {
  const lower = value.toLowerCase().trim();
  if (lower.startsWith("pass")) return "pass";
  if (lower.startsWith("go") || lower.startsWith("went")) return "go";
  return "unset";
}

function dateFromKey(key: string): string | null {
  const match = /^Checkpoint\/(\d{4}-\d{2}-\d{2})\.md$/.exec(key);
  return match ? match[1] : null;
}

function buildOccurredAt(localDate: string, hhmm: string): Date {
  // Construct a TIMESTAMPTZ at the configured TZ. Postgres will store it in UTC.
  // We bake the tz offset by computing what UTC time corresponds to this local
  // wall-clock time in the configured zone.
  const [y, m, d] = localDate.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  // Naive: treat as local for the host. Postgres stores as TIMESTAMPTZ; we
  // convert by formatting in the configured tz and reverse-applying the offset.
  const naive = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  // Compute offset: format the naive instant back through the configured tz
  // and find the difference to the same wall-clock interpretation in UTC.
  const offsetMinutes = tzOffsetMinutes(naive, config.timezone);
  return new Date(naive.getTime() - offsetMinutes * 60_000);
}

function tzOffsetMinutes(date: Date, tz: string): number {
  // Returns the offset (in minutes) such that UTC + offset = local time in tz.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60_000;
}

interface BackfillStats {
  filesScanned: number;
  bulletsParsed: number;
  inserted: number;
  skippedDuplicate: number;
  parseFailures: number;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    console.log("[backfill-checkpoints] DRY RUN — pass --apply to mutate.");
  }

  const databaseUrl =
    process.env.DATABASE_URL ||
    (process.env.NODE_ENV === "production"
      ? ""
      : "postgresql://dev:dev@localhost:5434/journal_dev");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const r2 = createClient();
  const stats: BackfillStats = {
    filesScanned: 0,
    bulletsParsed: 0,
    inserted: 0,
    skippedDuplicate: 0,
    parseFailures: 0,
  };

  try {
    const objects = await listAllObjects(r2, VAULT_BUCKET, PREFIX);
    for (const obj of objects) {
      const date = dateFromKey(obj.key);
      if (!date) continue;
      stats.filesScanned++;

      const content = await getObjectContent(r2, VAULT_BUCKET, obj.key);
      const lines = content.split("\n").filter((l) => l.startsWith("- "));
      for (const line of lines) {
        const parsed = parseBullet(line);
        if (!parsed) {
          stats.parseFailures++;
          continue;
        }
        stats.bulletsParsed++;
        if (!apply) continue;

        const occurredAt = buildOccurredAt(date, parsed.hhmm);
        const inserted = await insertCheckpointIdempotent(pool, {
          kind: "substance",
          trigger: parsed.trigger,
          bodySignal: parsed.body,
          partVoice: parsed.partVoice,
          resolution: parsed.resolution,
          source: "vault-backfill",
          occurredAt,
          localDate: date,
        });
        if (inserted) stats.inserted++;
        else stats.skippedDuplicate++;
      }
    }
    console.log(
      `[backfill-checkpoints] files=${stats.filesScanned} bullets=${stats.bulletsParsed} inserted=${stats.inserted} skipped=${stats.skippedDuplicate} parse_failures=${stats.parseFailures}`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[backfill-checkpoints] failed:", err);
  process.exit(1);
});
