import matter from "gray-matter";
import { z } from "zod";

import type { ArtifactKind } from "../db/queries/artifacts.js";
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

const frontmatterSchema = z
  .object({
    kind: z
      .string()
      .transform((k) => (VALID_KINDS.includes(k) ? k : "note"))
      .default("note"),
  })
  .passthrough();

export interface ParsedNote {
  title: string;
  body: string;
  kind: ArtifactKind;
  wikiLinks: string[];
  createdAt?: Date;
  updatedAt?: Date;
  /** Per-field date-parse problems. Empty when frontmatter timestamps parse cleanly or are absent. */
  dateParseErrors: string[];
}

/**
 * Parse an Obsidian markdown note into structured fields.
 * Extracts frontmatter (kind, created_at, updated_at), title, body, and wiki links.
 */
export function parseObsidianNote(
  content: string,
  filename: string
): ParsedNote {
  const { data, content: markdownBody } = matter(content);

  const fm = frontmatterSchema.safeParse(data);
  const kind = (fm.success ? fm.data.kind : "note") as ArtifactKind;

  const dateParseErrors: string[] = [];
  const createdAt = parseFrontmatterDate(
    "created_at",
    data.created_at,
    filename,
    dateParseErrors
  );
  const updatedAt = parseFrontmatterDate(
    "updated_at",
    data.updated_at,
    filename,
    dateParseErrors
  );

  const title = extractTitle(markdownBody) ?? filenameStem(filename);
  const body = stripFirstHeading(markdownBody).trim() || title;
  const wikiLinks = extractWikiLinks(markdownBody);

  return {
    title: title.slice(0, 300),
    body,
    kind,
    wikiLinks,
    createdAt,
    updatedAt,
    dateParseErrors,
  };
}

/**
 * Parse a frontmatter date value into a Date.
 * Accepts a Date (js-yaml auto-parses unquoted YYYY-MM-DD into a Date)
 * or a string (ISO 8601, YYYY-MM-DD, etc.).
 *
 * Returns undefined and records an error message in `errors` for malformed input;
 * returns undefined silently if the field is absent.
 */
function parseFrontmatterDate(
  field: "created_at" | "updated_at",
  raw: unknown,
  filename: string,
  errors: string[]
): Date | undefined {
  if (raw === undefined || raw === null) return undefined;

  let date: Date | undefined;
  let error: string | undefined;

  if (raw instanceof Date) {
    date = Number.isNaN(raw.getTime()) ? undefined : raw;
    if (!date) error = "non-finite Date object";
  } else if (typeof raw === "string") {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      error = `unparseable date string: ${JSON.stringify(raw)}`;
    } else {
      date = d;
    }
  } else {
    error = `expected string or Date, got ${typeof raw}`;
  }

  if (error) {
    const msg = `invalid ${field}: ${error}`;
    errors.push(msg);
    console.warn(`[obsidian-parser] ${filename}: ${msg}`);
  }
  return date;
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

/**
 * Strip the `## Sources` section (and everything after it) from a body.
 * Sources are graph metadata, not content — embedding them pulls pairs with
 * overlapping source sets closer in vector space than their actual meaning warrants.
 */
export function stripSources(body: string): string {
  const match = body.match(/^##\s+Sources\s*$/m);
  if (!match || match.index === undefined) return body;
  return body.slice(0, match.index).trimEnd();
}

/** Extract filename stem: "Directory/Sub note.md" → "Sub note" */
function filenameStem(filename: string): string {
  const base = filename.includes("/")
    ? filename.substring(filename.lastIndexOf("/") + 1)
    : filename;
  return base.replace(/\.md$/i, "");
}
