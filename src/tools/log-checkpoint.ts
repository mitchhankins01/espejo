import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { config } from "../config.js";
import { todayDateInTimezone } from "../utils/dates.js";
import {
  createClient,
  getObjectContent,
  putObjectContent,
} from "../storage/r2.js";

const VAULT_BUCKET = "artifacts";
const CHECKPOINT_FOLDER = "Checkpoint";

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

export async function handleLogCheckpoint(
  _pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("log_checkpoint", input);
  const date = todayDateInTimezone(config.timezone);
  const hhmm = currentHHMMInTimezone(config.timezone);
  const key = `${CHECKPOINT_FOLDER}/${date}.md`;

  const bullet = buildBullet({
    hhmm,
    substance: params.substance,
    body: params.body,
    partVoice: params.part_voice,
    choice: params.choice,
  });

  const r2Client = createClient();

  let existing: string | null = null;
  try {
    existing = await getObjectContent(r2Client, VAULT_BUCKET, key);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const content =
    existing == null
      ? `${FRONTMATTER}${bullet}\n`
      : `${existing.replace(/\s+$/, "")}\n${bullet}\n`;

  await putObjectContent(r2Client, VAULT_BUCKET, key, content);

  return `Toll logged: ${key} at ${hhmm}.`;
}
