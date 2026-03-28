import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { todayInTimezone } from "../utils/dates.js";
import { createClient, putObjectContent } from "../storage/r2.js";

const VAULT_BUCKET = "artifacts";
const REVIEW_FOLDER = "Review";

function reviewToMarkdown(title: string, body: string): string {
  return `---
kind: review
status: approved
tags: []
---
# ${title}

${body}
`;
}

export async function handleSaveEveningReview(
  _pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("save_evening_review", input);
  const date = params.date ?? todayInTimezone();
  const title = `${date} — Evening Checkin`;
  const filename = `${title}.md`;
  const key = `${REVIEW_FOLDER}/${filename}`;

  const markdown = reviewToMarkdown(title, params.text);
  const r2Client = createClient();
  await putObjectContent(r2Client, VAULT_BUCKET, key, markdown);

  return `Evening review saved to Obsidian vault: ${key}`;
}
