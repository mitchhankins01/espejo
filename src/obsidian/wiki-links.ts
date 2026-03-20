// ============================================================================
// Wiki link extraction from Obsidian markdown
// ============================================================================

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;

/**
 * Extract wiki link targets from markdown content.
 * Handles: [[Title]], [[Title|Display]], [[Title#Heading]],
 * [[Title#^block]], ![[Embed]]. Strips code blocks first.
 */
export function extractWikiLinks(content: string): string[] {
  const cleaned = content
    .replace(FENCED_CODE_RE, "")
    .replace(INLINE_CODE_RE, "");

  const seen = new Set<string>();
  const results: string[] = [];

  for (const match of cleaned.matchAll(WIKILINK_RE)) {
    let target = match[1];

    // [[Title|Display Text]] → extract Title
    const pipeIdx = target.indexOf("|");
    if (pipeIdx !== -1) target = target.substring(0, pipeIdx);

    // [[Title#Heading]] or [[Title#^block-id]] → strip fragment
    const hashIdx = target.indexOf("#");
    if (hashIdx !== -1) target = target.substring(0, hashIdx);

    target = target.trim();
    if (target.length > 0 && !seen.has(target)) {
      seen.add(target);
      results.push(target);
    }
  }

  return results;
}
