import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { todayInTimezone } from "../utils/dates.js";
import {
  createClient,
  putObjectContent,
  getObjectContent,
} from "../storage/r2.js";

const VAULT_BUCKET = "artifacts";
const REVIEW_FOLDER = "Review";
const TEMPLATE_KEY = "Templates/Review.md";

async function getReviewTemplate(
  r2Client: ReturnType<typeof createClient>
): Promise<string> {
  try {
    return await getObjectContent(r2Client, VAULT_BUCKET, TEMPLATE_KEY);
  } catch {
    // Fallback if template doesn't exist
    return `---
kind: review
status: approved
---
# {{title}}

{{body}}
`;
  }
}

function applyTemplate(
  template: string,
  title: string,
  body: string,
  date: string
): string {
  return template
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{body\}\}/g, body)
    .replace(/\{\{date\}\}/g, date);
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

  const r2Client = createClient();
  const template = await getReviewTemplate(r2Client);
  const markdown = applyTemplate(template, title, params.text, date);
  await putObjectContent(r2Client, VAULT_BUCKET, key, markdown);

  return `Evening review saved to Obsidian vault: ${key}`;
}
