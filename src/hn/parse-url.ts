/**
 * Parse a Hacker News thread URL or bare item id into a numeric item id.
 *
 * Accepts:
 *   - "https://news.ycombinator.com/item?id=12345"
 *   - "http://news.ycombinator.com/item?id=12345"
 *   - "news.ycombinator.com/item?id=12345"
 *   - "12345" (bare numeric id)
 *
 * Throws an actionable error for anything else so the agent surfaces a clear
 * message back to the user instead of silently kicking off a no-op job.
 */
export interface ParsedHnUrl {
  itemId: number;
  hnUrl: string;
}

const HN_HOST_RE = /(?:^|\/\/)(?:www\.)?news\.ycombinator\.com\//i;
const ID_FROM_PATH_RE = /[?&]id=(\d+)/;

export function parseHnUrl(input: string): ParsedHnUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty input — pass an HN thread URL or item id.");
  }

  if (/^\d+$/.test(trimmed)) {
    const itemId = Number.parseInt(trimmed, 10);
    return {
      itemId,
      hnUrl: `https://news.ycombinator.com/item?id=${itemId}`,
    };
  }

  if (!HN_HOST_RE.test(trimmed)) {
    throw new Error(
      `Not a Hacker News URL: "${trimmed}". Expected news.ycombinator.com/item?id=… or a bare numeric id.`
    );
  }

  const match = trimmed.match(ID_FROM_PATH_RE);
  if (!match) {
    throw new Error(
      `HN URL is missing the id parameter: "${trimmed}". Expected /item?id=…`
    );
  }

  const itemId = Number.parseInt(match[1], 10);
  return {
    itemId,
    hnUrl: `https://news.ycombinator.com/item?id=${itemId}`,
  };
}
