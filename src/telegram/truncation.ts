// Tool result truncation — used to keep persisted tool_result rows compact.
// (Lifted from src/telegram/agent/truncation.ts so flows don't depend on the
// soon-to-be-deleted agent module.)

const TOOL_RESULT_MAX_CHARS = 500;
const SEARCH_RESULT_ENTRY_MAX_CHARS = 100;

export function truncateToolResult(toolName: string, result: string): string {
  if (result.length <= TOOL_RESULT_MAX_CHARS) return result;

  if (toolName === "search_entries") {
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
