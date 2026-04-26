import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { parseHnUrl } from "../hn/parse-url.js";
import { runHnDistillWorkflow } from "../hn/workflow.js";

/**
 * Kick off an HN thread distillation in the background and return immediately.
 *
 * The work (fetch article + Algolia tree, one Opus 4.7 call, email, vault
 * write, follow-up Telegram ping) takes longer than the agent's wall-clock
 * tool budget, so we fire-and-forget. The workflow's own try/catch reports
 * success or failure back to the user via Telegram.
 */
export async function handleDistillHnThread(
  _pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("distill_hn_thread", input);
  const { itemId, hnUrl } = parseHnUrl(params.url);

  void runHnDistillWorkflow({ itemId, hnUrl });

  return `Starting distillation of HN #${itemId}. I'll email it and ping you back here when it's done (usually 30-90s).`;
}
