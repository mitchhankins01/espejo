import { readMarkedBlock, TOMO_PROMPT_PATH } from "./prompt-doc.js";

export async function readSeriesQueue(
  path: string = TOMO_PROMPT_PATH
): Promise<string> {
  return (await readMarkedBlock("SERIES QUEUE", path)).trim();
}

export function formatSeriesQueueForPlanner(queue: string): string {
  if (queue.length === 0) return "";
  return [
    "# Series queue — active veins (highest priority after editorial direction)",
    "Each bullet below is a vein the reader wants several tomos to draw from. For each active vein, produce at least one candidate (essay or flow) that engages it directly, and name the vein explicitly in that candidate's `take`. The other candidates remain free.",
    "",
    queue,
  ].join("\n");
}
