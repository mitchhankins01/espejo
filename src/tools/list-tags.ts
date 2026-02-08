import type pg from "pg";
import { listTags } from "../db/queries.js";

export async function handleListTags(
  pool: pg.Pool,
  _input: unknown
): Promise<string> {
  const tags = await listTags(pool);

  if (tags.length === 0) {
    return "No tags found in the journal.";
  }

  const lines: string[] = [];
  lines.push(`Found ${tags.length} tag${tags.length > 1 ? "s" : ""}:\n`);

  for (const tag of tags) {
    lines.push(
      `  \uD83C\uDFF7\uFE0F ${tag.name} (${tag.count} entr${tag.count > 1 ? "ies" : "y"})`
    );
  }

  return lines.join("\n");
}
