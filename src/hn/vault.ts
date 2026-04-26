import matter from "gray-matter";
import { config } from "../config.js";
import { createClient, putObjectContent } from "../storage/r2.js";

/**
 * Vault bucket name. Must stay in sync with `VAULT_BUCKET` in
 * src/obsidian/sync.ts — Remotely Save (in Obsidian) writes to this same
 * bucket, our R2→DB sync reads from it, and the new HN distill writes here
 * so the file shows up in both Mitch's local vault (via Remotely Save) and
 * the knowledge_artifacts DB (via the periodic sync).
 */
const VAULT_BUCKET = "artifacts";

export interface WritePendingReferenceInput {
  title: string;
  markdown: string;
  hnUrl: string;
  articleUrl: string | null;
  /** YYYY-MM-DD; caller controls timezone. */
  isoDate: string;
  /** Extra tags beyond the default `["hn"]`. Lowercase, hyphenated. */
  extraTags?: string[];
  /** Override the vault key prefix (defaults to "Pending/Reference"). For tests. */
  keyPrefix?: string;
}

export interface WrittenReference {
  key: string;
  filename: string;
}

/** Slugify a title for use in a vault filename. */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return base || "untitled";
}

/**
 * Upload the distillation to R2 at `Pending/Reference/HN-{date}-{slug}.md`
 * inside the vault bucket. Remotely Save (Obsidian plugin) syncs that key
 * down to Mitch's local vault on its next run, and src/obsidian/sync.ts
 * indexes it into the DB on its next 30-min cycle.
 *
 * Frontmatter follows project convention (kind/status/tags). Title lives in
 * the first `# heading`, never in frontmatter. Body = the distillation + a
 * footer with the source URLs, parallel to what the email shows.
 */
export async function writePendingReference(
  input: WritePendingReferenceInput
): Promise<WrittenReference> {
  if (!config.r2.accountId || !config.r2.accessKeyId) {
    throw new Error(
      "R2 credentials are not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
    );
  }

  const slug = slugify(input.title);
  const filename = `HN-${input.isoDate}-${slug}.md`;
  const prefix = (input.keyPrefix ?? "Pending/Reference").replace(/\/+$/, "");
  const key = `${prefix}/${filename}`;

  const tags = ["hn", ...(input.extraTags ?? [])];
  const sourceLines = [`HN thread: ${input.hnUrl}`];
  if (input.articleUrl) sourceLines.push(`Original article: ${input.articleUrl}`);

  const body = [
    `# ${input.title}`,
    "",
    input.markdown.trim(),
    "",
    "---",
    "",
    sourceLines.join("\n"),
    "",
  ].join("\n");

  const file = matter.stringify(body, {
    kind: "reference",
    status: "pending",
    tags,
  });

  const client = createClient();
  await putObjectContent(client, VAULT_BUCKET, key, file);

  return { key, filename };
}
