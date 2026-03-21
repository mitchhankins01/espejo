import matter from "gray-matter";
import { z } from "zod";

import type { ArtifactKind } from "../db/queries/artifacts.js";
import { normalizeTags } from "../db/queries/artifacts.js";
import { extractWikiLinks } from "./wiki-links.js";

// ============================================================================
// Obsidian markdown parser
// ============================================================================

const VALID_KINDS: readonly string[] = [
  "insight",
  "reference",
  "note",
  "project",
  "review",
];

const VALID_STATUSES: readonly string[] = ["pending", "approved"];

const frontmatterSchema = z
  .object({
    kind: z
      .string()
      .transform((k) => (VALID_KINDS.includes(k) ? k : "note"))
      .default("note"),
    tags: z
      .union([z.array(z.string()), z.string().transform((s) => [s])])
      .default([]),
    status: z
      .string()
      .transform((s) => (VALID_STATUSES.includes(s) ? s : "approved"))
      .default("approved"),
  })
  .passthrough();

export interface ParsedNote {
  title: string;
  body: string;
  kind: ArtifactKind;
  tags: string[];
  status: string;
  wikiLinks: string[];
}

/**
 * Parse an Obsidian markdown note into structured fields.
 * Extracts frontmatter (kind, tags), title, body, and wiki links.
 */
export function parseObsidianNote(
  content: string,
  filename: string
): ParsedNote {
  const { data, content: markdownBody } = matter(content);

  const fm = frontmatterSchema.safeParse(data);
  const kind = (fm.success ? fm.data.kind : "note") as ArtifactKind;
  const tags = fm.success ? normalizeTags(fm.data.tags) : [];
  // Reviews are always approved — status: pending is only for extracted insights
  const rawStatus = fm.success ? fm.data.status : "approved";
  const status = kind === "review" ? "approved" : rawStatus;

  const title = extractTitle(markdownBody) ?? filenameStem(filename);
  const body = stripFirstHeading(markdownBody).trim() || title;
  const wikiLinks = extractWikiLinks(markdownBody);

  return {
    title: title.slice(0, 300),
    body,
    kind,
    tags,
    status,
    wikiLinks,
  };
}

/** Extract first # heading from markdown, stripping formatting */
function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) return null;
  // Strip markdown formatting: **bold**, *italic*, [[links]], `code`
  return match[1]
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

/** Strip the first # heading line from markdown */
function stripFirstHeading(markdown: string): string {
  return markdown.replace(/^#\s+.+$/m, "").trim();
}

/** Extract filename stem: "Directory/Sub note.md" → "Sub note" */
function filenameStem(filename: string): string {
  const base = filename.includes("/")
    ? filename.substring(filename.lastIndexOf("/") + 1)
    : filename;
  return base.replace(/\.md$/i, "");
}
