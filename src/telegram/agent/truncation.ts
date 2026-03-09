import { TOOL_RESULT_MAX_CHARS, SEARCH_RESULT_ENTRY_MAX_CHARS } from "./constants.js";

// ---------------------------------------------------------------------------
// Tool result truncation
// ---------------------------------------------------------------------------

export function truncateToolResult(
  toolName: string,
  result: string
): string {
  if (result.length <= TOOL_RESULT_MAX_CHARS) return result;

  if (toolName === "search_entries") {
    // Extract UUIDs, dates, and truncated text
    const lines = result.split("\n");
    const truncated: string[] = [];
    let chars = 0;
    for (const line of lines) {
      if (chars + line.length > TOOL_RESULT_MAX_CHARS) {
        truncated.push(line.slice(0, SEARCH_RESULT_ENTRY_MAX_CHARS) + "...");
        break;
      }
      truncated.push(line);
      chars += line.length;
    }
    return truncated.join("\n");
  }

  return result.slice(0, TOOL_RESULT_MAX_CHARS) + "...";
}
