import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

function defaultVaultRoot(): string {
  return path.resolve(process.cwd(), "Artifacts");
}

export interface WritePendingReferenceInput {
  title: string;
  markdown: string;
  hnUrl: string;
  articleUrl: string | null;
  /** YYYY-MM-DD; caller controls timezone. */
  isoDate: string;
  /** Extra tags beyond the default `["hn"]`. Lowercase, hyphenated. */
  extraTags?: string[];
  /** Override the vault root (defaults to ./Artifacts). Mainly for tests. */
  vaultRoot?: string;
}

export interface WrittenReference {
  filePath: string;
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
 * Write the distillation to `Artifacts/Pending/Reference/HN-{date}-{slug}.md`.
 *
 * Frontmatter follows the project convention (kind/status/tags). Title lives
 * in the first `# heading`, never in frontmatter. Body = the distillation +
 * a small footer with the source URLs, parallel to what the email shows.
 *
 * Returns the absolute path so the caller can include it in the success message.
 */
export async function writePendingReference(
  input: WritePendingReferenceInput
): Promise<WrittenReference> {
  const vaultRoot = input.vaultRoot ?? defaultVaultRoot();
  const pendingReferenceDir = path.join(vaultRoot, "Pending", "Reference");
  await mkdir(pendingReferenceDir, { recursive: true });

  const slug = slugify(input.title);
  const filename = `HN-${input.isoDate}-${slug}.md`;
  const filePath = path.join(pendingReferenceDir, filename);

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

  // gray-matter's stringify gives us valid frontmatter without hand-rolling YAML.
  // Wrap in a trim/respace step so there's no blank line between `---` and `# heading`.
  const file = matter.stringify(body, {
    kind: "reference",
    status: "pending",
    tags,
  });

  await writeFile(filePath, file, "utf8");

  return { filePath, filename };
}
