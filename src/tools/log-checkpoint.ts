import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { config } from "../config.js";
import { daysAgoInTimezone, todayDateInTimezone } from "../utils/dates.js";
import {
  createClient,
  getObjectContent,
  putObjectContent,
} from "../storage/r2.js";

const VAULT_BUCKET = "artifacts";
const CHECKPOINT_FOLDER = "Checkpoint";

// If the same {substance, body, part_voice} was logged within this many
// minutes of "now", reject the call as a duplicate. Catches the failure mode
// where the agent re-runs log_checkpoint in response to ambiguous follow-ups
// like "Done?" — see specs/2026-05-03-checkpoint-bugfixes.md.
const DUPLICATE_WINDOW_MINUTES = 10;

const FRONTMATTER = `---
kind: note
tags:
  - checkpoint
  - parts-work
  - substance-use
---
`;

function currentHHMMInTimezone(tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } });
  return (
    code.name === "NoSuchKey" ||
    code.name === "NotFound" ||
    code.Code === "NoSuchKey" ||
    code.$metadata?.httpStatusCode === 404
  );
}

function trimTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:!?\s]+$/, "");
}

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?]/g, "").trim();
}

function buildBullet(params: {
  hhmm: string;
  substance: string;
  body: string;
  partVoice: string;
  choice: "pass" | "go" | "unset";
}): string {
  const choiceMarker =
    params.choice === "unset" ? "(no answer)" : params.choice;
  const substance = trimTrailingPunctuation(params.substance);
  const body = trimTrailingPunctuation(params.body);
  const partVoice = trimTrailingPunctuation(params.partVoice);
  return `- ${params.hhmm} ${substance}. ${body}. ${partVoice}. ${choiceMarker}`;
}

interface ParsedBullet {
  hhmm: string;
  substance: string;
  body: string;
  partVoice: string;
}

// Parse a bullet of the shape:
//   - HH:MM Substance. Body. Part voice. choice
// Returns null if the bullet doesn't match the expected shape (legacy entries,
// backfilled rows, etc.). Used only for duplicate detection — best-effort.
function parseBullet(line: string): ParsedBullet | null {
  const match = /^- (\d{2}:\d{2}) (.+)$/.exec(line);
  if (!match) return null;
  const hhmm = match[1];
  const segments = match[2].split(". ");
  if (segments.length < 4) return null;
  const [substance, body, partVoice] = segments;
  return { hhmm, substance, body, partVoice };
}

function minutesBetween(a: string, b: string): number | null {
  const am = /^(\d{2}):(\d{2})$/.exec(a);
  const bm = /^(\d{2}):(\d{2})$/.exec(b);
  if (!am || !bm) return null;
  const aMin = Number(am[1]) * 60 + Number(am[2]);
  const bMin = Number(bm[1]) * 60 + Number(bm[2]);
  return Math.abs(aMin - bMin);
}

function findRecentDuplicate(
  existing: string,
  now: { hhmm: string; substance: string; body: string; partVoice: string }
): ParsedBullet | null {
  const nowKey = [
    normalizeForCompare(now.substance),
    normalizeForCompare(now.body),
    normalizeForCompare(now.partVoice),
  ].join("|");

  const lines = existing.split("\n").filter((l) => l.startsWith("- "));
  for (const line of lines) {
    const parsed = parseBullet(line);
    if (!parsed) continue;
    const key = [
      normalizeForCompare(parsed.substance),
      normalizeForCompare(parsed.body),
      normalizeForCompare(parsed.partVoice),
    ].join("|");
    if (key !== nowKey) continue;
    const minutes = minutesBetween(parsed.hhmm, now.hhmm);
    if (minutes != null && minutes <= DUPLICATE_WINDOW_MINUTES) {
      return parsed;
    }
  }
  return null;
}

// Token-Jaccard threshold for fabrication detection. Picked so that
// "a flourishing in the upper chest, almost on the surface" vs "flourishing in
// the upper chest, almost on the surface" (the 2026-05-04 incident — agent
// prepended a single token to yesterday's bullet) trips the guard, while
// genuinely different free-form descriptions stay well below.
const FABRICATION_JACCARD_THRESHOLD = 0.85;
const FABRICATION_MIN_TOKENS = 5;

function tokenize(s: string): Set<string> {
  return new Set(
    normalizeForCompare(s)
      .split(/\s+/)
      .filter((t) => t.length > 1)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// Fabrication guard: if the input substance matches a bullet in the file AND
// the body+part_voice tokens overlap heavily (Jaccard ≥ 0.85), the agent is
// almost certainly copy-pasting a recent toll from scrollback rather than
// logging a fresh user signal. Applied to BOTH today's file (catches
// mid-conversation re-runs the 10-min window misses, e.g. 11:12 → 13:35) and
// yesterday's (catches midnight rollover). 2026-05-04 hit both modes: agent
// fabricated bullets from yesterday twice in the morning, then later in the
// day fabricated a Nicotine bullet copying its own 11:12 entry while logging
// a real Weed entry in the same turn.
function findFabricationMatch(
  fileContent: string,
  now: { substance: string; body: string; partVoice: string }
): ParsedBullet | null {
  const nowSubstance = normalizeForCompare(now.substance);
  const nowTokens = tokenize(`${now.body} ${now.partVoice}`);
  if (nowTokens.size < FABRICATION_MIN_TOKENS) return null;

  const lines = fileContent.split("\n").filter((l) => l.startsWith("- "));
  for (const line of lines) {
    const parsed = parseBullet(line);
    if (!parsed) continue;
    if (normalizeForCompare(parsed.substance) !== nowSubstance) continue;
    const theirTokens = tokenize(`${parsed.body} ${parsed.partVoice}`);
    if (theirTokens.size < FABRICATION_MIN_TOKENS) continue;
    if (jaccard(nowTokens, theirTokens) >= FABRICATION_JACCARD_THRESHOLD) {
      return parsed;
    }
  }
  return null;
}

export async function handleLogCheckpoint(
  _pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("log_checkpoint", input);
  const date = todayDateInTimezone(config.timezone);
  const hhmm = currentHHMMInTimezone(config.timezone);
  const key = `${CHECKPOINT_FOLDER}/${date}.md`;

  const r2Client = createClient();

  let existing: string | null = null;
  try {
    existing = await getObjectContent(r2Client, VAULT_BUCKET, key);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  if (existing != null) {
    const dup = findRecentDuplicate(existing, {
      hhmm,
      substance: params.substance,
      body: params.body,
      partVoice: params.part_voice,
    });
    if (dup) {
      return `Already logged at ${dup.hhmm} (skipped duplicate within ${DUPLICATE_WINDOW_MINUTES} min).`;
    }
    const fab = findFabricationMatch(existing, {
      substance: params.substance,
      body: params.body,
      partVoice: params.part_voice,
    });
    if (fab) {
      return `Rejected: matches ${date} ${fab.hhmm} bullet (likely fabricated from scrollback). If this is a real fresh toll, vary the wording.`;
    }
  }

  const yesterdayDate = daysAgoInTimezone(1);
  const yesterdayKey = `${CHECKPOINT_FOLDER}/${yesterdayDate}.md`;
  let previousDay: string | null = null;
  try {
    previousDay = await getObjectContent(r2Client, VAULT_BUCKET, yesterdayKey);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  if (previousDay != null) {
    const crossDayDup = findFabricationMatch(previousDay, {
      substance: params.substance,
      body: params.body,
      partVoice: params.part_voice,
    });
    if (crossDayDup) {
      return `Rejected: identical to ${yesterdayDate} ${crossDayDup.hhmm} bullet (likely fabricated from scrollback). If this is a real fresh toll, vary the wording.`;
    }
  }

  const bullet = buildBullet({
    hhmm,
    substance: params.substance,
    body: params.body,
    partVoice: params.part_voice,
    choice: params.choice,
  });

  const content =
    existing == null
      ? `${FRONTMATTER}${bullet}\n`
      : `${existing.replace(/\s+$/, "")}\n${bullet}\n`;

  await putObjectContent(r2Client, VAULT_BUCKET, key, content);

  return `Toll logged: ${key} at ${hhmm}.`;
}
