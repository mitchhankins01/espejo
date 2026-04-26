/**
 * Hacker News thread fetch via the Algolia API.
 *
 * The HTML page at news.ycombinator.com/item?id=… under-returns deeper
 * sub-threads (collapsed "more" links). The Algolia endpoint at
 * https://hn.algolia.com/api/v1/items/{id} returns the entire nested tree
 * as JSON in one shot — that's what we use here.
 */

const ALGOLIA_BASE = "https://hn.algolia.com/api/v1/items";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 800;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface HnItem {
  id: number;
  created_at: string | null;
  created_at_i: number | null;
  type: "story" | "comment" | "poll" | "pollopt" | "job" | string;
  author: string | null;
  title: string | null;
  url: string | null;
  /** HTML-formatted body. Null/empty for stories with a `url`, or for deleted comments. */
  text: string | null;
  points: number | null;
  parent_id: number | null;
  story_id: number | null;
  children: HnItem[];
  options?: unknown[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchHnItem(itemId: number): Promise<HnItem> {
  const url = `${ALGOLIA_BASE}/${itemId}`;
  let response: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(url);
    if (
      response.ok ||
      !RETRYABLE_STATUSES.has(response.status) ||
      attempt >= MAX_RETRIES
    ) {
      break;
    }
    await sleep(BASE_DELAY_MS * 2 ** attempt);
  }

  if (!response.ok) {
    throw new Error(
      `HN Algolia API failed for item ${itemId} (HTTP ${response.status}). ` +
        `Verify the id exists and the URL was a real HN thread.`
    );
  }

  return (await response.json()) as HnItem;
}

/** Recursively count every node (including the root) in an item tree. */
export function countItems(item: HnItem): number {
  let count = 1;
  for (const child of item.children ?? []) {
    count += countItems(child);
  }
  return count;
}
