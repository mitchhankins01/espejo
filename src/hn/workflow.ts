import { pool } from "../db/client.js";
import { logUsage } from "../db/queries/usage.js";
import { config } from "../config.js";
import { sendTelegramMessage } from "../telegram/client.js";
import { sendEmail } from "../email/send.js";
import { todayInTimezone } from "../utils/dates.js";
import { fetchHnItem, countItems, type HnItem } from "./algolia.js";
import { fetchArticleText } from "./article.js";
import { formatThreadForPrompt } from "./format-thread.js";
import { distillThread } from "./distill.js";
import { composeEmail } from "./email.js";
import { writePendingReference } from "./vault.js";
import { formatCost } from "./pricing.js";

export interface RunWorkflowInput {
  itemId: number;
  hnUrl: string;
}

/**
 * Pick the best title for the email subject and vault filename.
 * Article <title> is usually richer than the HN submission title; fall back
 * cleanly when there's no article (Ask HN, Show HN self-posts).
 */
function chooseTitle(
  item: HnItem,
  article: { title: string | null } | null
): string {
  const articleTitle = article?.title?.trim();
  if (articleTitle) return articleTitle;
  const hnTitle = item.title?.trim();
  if (hnTitle) return hnTitle;
  return `Hacker News thread #${item.id}`;
}

/**
 * Background workflow: fetch → distill → email → write vault → notify Telegram.
 *
 * Designed to be invoked fire-and-forget (`void runHnDistillWorkflow(...)`).
 * All errors are caught and reported back to the user via Telegram so the
 * agent loop never sees a rejection from this promise.
 */
export async function runHnDistillWorkflow(
  input: RunWorkflowInput
): Promise<void> {
  const startedAt = Date.now();
  const chatId = config.telegram.allowedChatId;
  let title = `HN #${input.itemId}`;
  let costSummary = "";

  try {
    const item = await fetchHnItem(input.itemId);
    const totalNodes = countItems(item);

    const article =
      item.url && item.url.trim().length > 0
        ? await fetchArticleText(item.url).catch((err) => {
            console.error(
              `[hn-distill] article fetch failed for ${item.url}: ${err instanceof Error ? err.message : err}`
            );
            return null;
          })
        : null;

    const formatted = formatThreadForPrompt(item);
    title = chooseTitle(item, article);

    const distill = await distillThread({
      hnUrl: input.hnUrl,
      hnTitle: item.title,
      hnAuthor: item.author,
      hnPoints: item.points,
      totalComments: formatted.totalComments,
      selfPostBody: formatted.selfPostBody,
      article,
      threadText: formatted.comments,
    });

    const email = composeEmail({
      title,
      markdown: distill.markdown,
      hnUrl: input.hnUrl,
      articleUrl: item.url,
      model: distill.model,
      usage: distill.usage,
      cost: distill.cost,
    });

    await sendEmail({
      subject: email.subject,
      text: email.text,
      html: email.html,
    });

    const vaultFile = await writePendingReference({
      title,
      markdown: distill.markdown,
      hnUrl: input.hnUrl,
      articleUrl: item.url,
      isoDate: todayInTimezone(),
    });

    costSummary = formatCost(distill.cost.totalCostUsd);

    logUsage(pool, {
      source: "telegram",
      surface: "hn-distill",
      action: "distill_hn_thread",
      actor: chatId || undefined,
      ok: true,
      durationMs: Date.now() - startedAt,
      meta: {
        itemId: input.itemId,
        totalNodes,
        totalComments: formatted.totalComments,
        articleFetched: article !== null,
        model: distill.model,
        inputTokens: distill.usage.inputTokens,
        outputTokens: distill.usage.outputTokens,
        costUsd: distill.cost.totalCostUsd,
        vaultFile: vaultFile.filename,
      },
    });

    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `✅ HN #${input.itemId} distilled (${costSummary}) — emailed and saved to <code>Pending/Reference/${vaultFile.filename}</code>`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[hn-distill] workflow failed for #${input.itemId}:`, err);
    logUsage(pool, {
      source: "telegram",
      surface: "hn-distill",
      action: "distill_hn_thread",
      actor: chatId || undefined,
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
      meta: { itemId: input.itemId },
    });
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `❌ HN distill failed for #${input.itemId}: ${message}`
      ).catch(() => {
        /* don't let a Telegram outage mask the original error in logs */
      });
    }
  }
}
