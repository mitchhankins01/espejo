import { readFile } from "fs/promises";

const TOMO_PROMPT_PATH = "Artifacts/Prompt/Spanish/Tomo.md";
const BEGIN = "<!-- BEGIN SERIES QUEUE";
const END = "<!-- END SERIES QUEUE";

export async function readSeriesQueue(
  path: string = TOMO_PROMPT_PATH
): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return "";
  }
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return "";
  const blockStart = text.indexOf("\n", start) + 1;
  return text.slice(blockStart, end).trim();
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
