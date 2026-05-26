/**
 * Single parser for the `<!-- BEGIN <NAME> ... --> ... <!-- END <NAME> ... -->`
 * marker blocks that Mitch hand-edits inside `Artifacts/Prompt/Spanish/Tomo.md`
 * (the OPEN QUESTIONS list and the SERIES QUEUE). `open-questions.ts` and
 * `series-queue.ts` both used to carry near-identical copies of this slicer.
 */
import { readFile } from "fs/promises";

export const TOMO_PROMPT_PATH = "Artifacts/Prompt/Spanish/Tomo.md";

/**
 * Return the text between `<!-- BEGIN <name>` and `<!-- END <name>`, excluding
 * the marker lines themselves. The match is prefix-based, so the markers may
 * carry a trailing comment (e.g. `<!-- BEGIN OPEN QUESTIONS — Mitch edits…`).
 * Returns "" when either marker is missing or out of order.
 */
export function extractMarkedBlock(text: string, name: string): string {
  const start = text.indexOf(`<!-- BEGIN ${name}`);
  const end = text.indexOf(`<!-- END ${name}`);
  if (start === -1 || end === -1 || end < start) return "";
  const blockStart = text.indexOf("\n", start) + 1;
  return text.slice(blockStart, end);
}

/** Read the doc and extract a marked block. Returns "" if the file is missing. */
export async function readMarkedBlock(
  name: string,
  path: string = TOMO_PROMPT_PATH
): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return "";
  }
  return extractMarkedBlock(text, name);
}
