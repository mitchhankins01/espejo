import * as cheerio from "cheerio";
import type { HnItem } from "./algolia.js";

const MAX_PATH_DEPTH = 8;

/**
 * Convert HN's HTML-formatted comment body to plain text.
 * HN wraps comments in <p>, links as <a href>, and keeps `>` quotes inline.
 * We collapse it to readable plain text so Claude doesn't burn tokens on markup.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  const $ = cheerio.load(`<root>${html}</root>`);
  // Convert paragraph breaks to double newlines.
  $("p").each((_, el) => {
    $(el).append("\n\n");
  });
  // Inline links as "text (url)" only when href differs from visible text.
  $("a[href]").each((_, el) => {
    const node = $(el);
    const href = node.attr("href");
    const text = node.text();
    if (href && href.trim() !== text.trim()) {
      node.replaceWith(`${text} (${href})`);
    }
  });
  return $.root()
    .text()
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface FlatComment {
  path: string;
  depth: number;
  author: string;
  text: string;
}

function flatten(item: HnItem, path: number[] = []): FlatComment[] {
  const out: FlatComment[] = [];
  const children = item.children ?? [];
  children.forEach((child, i) => {
    const childPath = [...path, i + 1];
    const text = htmlToPlainText(child.text ?? "");
    const author = child.author ?? "[deleted]";
    if (text || author !== "[deleted]") {
      out.push({
        path: childPath.join("."),
        depth: childPath.length,
        author,
        text,
      });
    }
    if (childPath.length < MAX_PATH_DEPTH) {
      out.push(...flatten(child, childPath));
    }
  });
  return out;
}

export interface FormattedThread {
  comments: string;
  selfPostBody: string | null;
  totalComments: number;
}

/**
 * Render a thread item into the prompt-shaped string Claude will consume.
 *
 * - Drops deleted comments with no body (HN tombstones).
 * - Indents by depth so hierarchy is visible without parsing the [path] tag.
 * - Limits depth to MAX_PATH_DEPTH to keep pathological recursive replies sane.
 */
export function formatThreadForPrompt(item: HnItem): FormattedThread {
  const flat = flatten(item).filter((c) => c.text.length > 0);

  const lines = flat.map((c) => {
    const indent = "  ".repeat(Math.max(0, c.depth - 1));
    // Embed body lines on their own indented continuation lines so multi-paragraph
    // comments don't smear into the path marker.
    const bodyLines = c.text.split("\n").map((line, idx) => {
      if (idx === 0) return `${indent}[${c.path}] ${c.author}: ${line}`;
      return `${indent}    ${line}`;
    });
    return bodyLines.join("\n");
  });

  const selfPost = htmlToPlainText(item.text ?? "");

  return {
    comments: lines.join("\n\n"),
    selfPostBody: selfPost.length > 0 ? selfPost : null,
    totalComments: flat.length,
  };
}
