import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { parseHnUrl } from "../hn/parse-url.js";
import { runHnDistillWorkflow } from "../hn/workflow.js";

// In-memory dedupe: when the agent re-fires distill_hn_thread for a URL it
// already kicked off (e.g. it sees prior URLs in chat history and re-batches
// them on the next user turn), we drop the duplicate instead of running the
// expensive workflow + email + vault write twice. Bounded by RECENT_TTL_MS;
// keys that age out are eligible to fire again.
const RECENT_TTL_MS = 10 * 60 * 1000;
const recentItemIds = new Map<number, number>();

function isRecentlyFired(itemId: number): boolean {
  const at = recentItemIds.get(itemId);
  if (!at) return false;
  if (Date.now() - at > RECENT_TTL_MS) {
    recentItemIds.delete(itemId);
    return false;
  }
  return true;
}

function markFired(itemId: number): void {
  recentItemIds.set(itemId, Date.now());
}

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

  if (isRecentlyFired(itemId)) {
    return `HN #${itemId} is already being distilled (kicked off in the last ${RECENT_TTL_MS / 60000}min). Skipping duplicate fire.`;
  }
  markFired(itemId);

  void runHnDistillWorkflow({ itemId, hnUrl });

  return `Starting distillation of HN #${itemId}. I'll email it and ping you back here when it's done (usually 30-90s).`;
}
