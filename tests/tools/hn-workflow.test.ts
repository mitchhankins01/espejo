import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchHnItem = vi.hoisted(() => vi.fn());
const fetchArticleText = vi.hoisted(() => vi.fn());
const distillThread = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());
const writePendingReference = vi.hoisted(() => vi.fn());
const sendTelegramMessage = vi.hoisted(() => vi.fn());
const logUsage = vi.hoisted(() => vi.fn());
const todayInTimezone = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({ pool: {} }));
vi.mock("../../src/db/queries/usage.js", () => ({ logUsage }));
vi.mock("../../src/config.js", () => ({
  config: { telegram: { allowedChatId: "12345" } },
}));
vi.mock("../../src/telegram/client.js", () => ({ sendTelegramMessage }));
vi.mock("../../src/email/send.js", () => ({ sendEmail }));
vi.mock("../../src/utils/dates.js", () => ({ todayInTimezone }));
vi.mock("../../src/hn/algolia.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/hn/algolia.js")>(
    "../../src/hn/algolia.js"
  );
  return { ...actual, fetchHnItem };
});
vi.mock("../../src/hn/article.js", () => ({ fetchArticleText }));
vi.mock("../../src/hn/distill.js", () => ({ distillThread }));
vi.mock("../../src/hn/vault.js", () => ({ writePendingReference }));

import { runHnDistillWorkflow } from "../../src/hn/workflow.js";

const HN_ITEM = {
  id: 1,
  created_at: null,
  created_at_i: null,
  type: "story" as const,
  author: "alice",
  title: "Test",
  url: "https://example.com",
  text: null,
  points: 100,
  parent_id: null,
  story_id: null,
  children: [],
};

beforeEach(() => {
  fetchHnItem.mockReset();
  fetchArticleText.mockReset();
  distillThread.mockReset();
  sendEmail.mockReset();
  writePendingReference.mockReset();
  sendTelegramMessage.mockReset();
  logUsage.mockReset();
  todayInTimezone.mockReset().mockReturnValue("2026-04-26");
});

describe("runHnDistillWorkflow", () => {
  it("runs the full happy path: fetch → article → distill → email → vault → notify", async () => {
    fetchHnItem.mockResolvedValueOnce(HN_ITEM);
    fetchArticleText.mockResolvedValueOnce({
      url: "https://example.com",
      title: "Article Title",
      text: "article body",
    });
    distillThread.mockResolvedValueOnce({
      markdown: "## body",
      model: "claude-opus-4-7",
      usage: { inputTokens: 1000, outputTokens: 200 },
      cost: { inputCostUsd: 0.005, outputCostUsd: 0.005, totalCostUsd: 0.01 },
    });
    sendEmail.mockResolvedValueOnce(undefined);
    writePendingReference.mockResolvedValueOnce({
      filename: "HN-2026-04-26-article-title.md",
      key: "Pending/Reference/HN-2026-04-26-article-title.md",
    });
    sendTelegramMessage.mockResolvedValueOnce(undefined);

    await runHnDistillWorkflow({
      itemId: 1,
      hnUrl: "https://news.ycombinator.com/item?id=1",
    });

    expect(fetchHnItem).toHaveBeenCalledWith(1);
    expect(fetchArticleText).toHaveBeenCalledWith("https://example.com");
    expect(distillThread).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(writePendingReference).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Article Title",
        markdown: "## body",
        hnUrl: "https://news.ycombinator.com/item?id=1",
        articleUrl: "https://example.com",
        isoDate: "2026-04-26",
      })
    );
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("✅ HN #1 distilled")
    );
    expect(logUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ok: true,
        action: "distill_hn_thread",
        meta: expect.objectContaining({ itemId: 1, costUsd: 0.01 }),
      })
    );
  });

  it("falls back to HN title when article fetch returns null", async () => {
    fetchHnItem.mockResolvedValueOnce({ ...HN_ITEM, url: "https://example.com" });
    fetchArticleText.mockResolvedValueOnce(null);
    distillThread.mockResolvedValueOnce({
      markdown: "x",
      model: "claude-opus-4-7",
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0.0001 },
    });
    sendEmail.mockResolvedValue(undefined);
    writePendingReference.mockResolvedValueOnce({
      filename: "HN-2026-04-26-test.md",
      key: "Pending/Reference/HN-2026-04-26-test.md",
    });

    await runHnDistillWorkflow({
      itemId: 1,
      hnUrl: "https://news.ycombinator.com/item?id=1",
    });

    expect(writePendingReference.mock.calls[0][0].title).toBe("Test");
  });

  it("skips article fetch entirely for self-posts (no item.url)", async () => {
    fetchHnItem.mockResolvedValueOnce({ ...HN_ITEM, url: null });
    distillThread.mockResolvedValueOnce({
      markdown: "x",
      model: "claude-opus-4-7",
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0 },
    });
    sendEmail.mockResolvedValue(undefined);
    writePendingReference.mockResolvedValueOnce({
      filename: "x",
      key: "Pending/Reference/x",
    });

    await runHnDistillWorkflow({
      itemId: 1,
      hnUrl: "https://news.ycombinator.com/item?id=1",
    });

    expect(fetchArticleText).not.toHaveBeenCalled();
  });

  it("continues when article fetch throws (logs and proceeds with thread only)", async () => {
    fetchHnItem.mockResolvedValueOnce({ ...HN_ITEM, url: "https://example.com" });
    fetchArticleText.mockRejectedValueOnce(new Error("403 forbidden"));
    distillThread.mockResolvedValueOnce({
      markdown: "x",
      model: "claude-opus-4-7",
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0 },
    });
    sendEmail.mockResolvedValue(undefined);
    writePendingReference.mockResolvedValueOnce({
      filename: "x",
      key: "Pending/Reference/x",
    });

    await runHnDistillWorkflow({
      itemId: 1,
      hnUrl: "https://news.ycombinator.com/item?id=1",
    });

    expect(distillThread).toHaveBeenCalledTimes(1);
    expect(distillThread.mock.calls[0][0].article).toBeNull();
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("✅")
    );
  });

  it("reports failures via Telegram and logs usage with ok=false", async () => {
    fetchHnItem.mockRejectedValueOnce(new Error("Algolia 503"));
    sendTelegramMessage.mockResolvedValue(undefined);

    await runHnDistillWorkflow({
      itemId: 99,
      hnUrl: "https://news.ycombinator.com/item?id=99",
    });

    expect(sendTelegramMessage).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("❌ HN distill failed for #99: Algolia 503")
    );
    expect(logUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ok: false,
        error: "Algolia 503",
        action: "distill_hn_thread",
      })
    );
  });

  it("falls back to a synthetic title when both article and HN title are missing", async () => {
    fetchHnItem.mockResolvedValueOnce({ ...HN_ITEM, id: 7, url: null, title: null });
    distillThread.mockResolvedValueOnce({
      markdown: "x",
      model: "claude-opus-4-7",
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0 },
    });
    sendEmail.mockResolvedValue(undefined);
    writePendingReference.mockResolvedValueOnce({
      filename: "x",
      key: "Pending/Reference/x",
    });

    await runHnDistillWorkflow({
      itemId: 7,
      hnUrl: "https://news.ycombinator.com/item?id=7",
    });

    expect(writePendingReference.mock.calls[0][0].title).toBe(
      "Hacker News thread #7"
    );
  });
});
