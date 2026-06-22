import { describe, it, expect, vi, beforeEach } from "vitest";

const chatMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/llm/index.js", () => ({
  chat: chatMock,
}));

import { distillThread } from "../../src/hn/distill.js";

beforeEach(() => {
  chatMock.mockReset();
});

describe("distillThread", () => {
  it("calls DeepSeek with the spec system prompt and user content", async () => {
    chatMock.mockResolvedValueOnce({
      text: "## Headline facts\n\nA test.",
      usage: { inputTokens: 1000, outputTokens: 200 },
      toolCalls: [],
      toolResults: [],
      finishReason: "stop",
    });

    const result = await distillThread({
      hnUrl: "https://news.ycombinator.com/item?id=1",
      hnTitle: "Test thread",
      hnAuthor: "alice",
      hnPoints: 100,
      totalComments: 3,
      selfPostBody: null,
      article: { url: "https://example.com", title: "Article", text: "body" },
      threadText: "[1] bob: hello",
    });

    expect(chatMock).toHaveBeenCalledTimes(1);
    const call = chatMock.mock.calls[0][0];
    expect(call.provider).toBe("deepseek");
    expect(call.model).toBe("deepseek-v4-pro");
    expect(call.maxTokens).toBe(8192);
    expect(call.system).toContain("distill Hacker News threads");
    expect(call.messages[0].role).toBe("user");
    expect(call.messages[0].content).toContain("ARTICLE");
    expect(call.messages[0].content).toContain("Title: Article");
    expect(call.messages[0].content).toContain("[1] bob: hello");
    expect(call.messages[0].content).toContain("(100 points");
    expect(call.messages[0].content).toContain("3 comments)");

    expect(result.markdown).toBe("## Headline facts\n\nA test.");
    expect(result.model).toBe("deepseek-v4-pro");
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
    // 1000 in * $0.435/M = $0.000435, 200 out * $0.87/M = $0.000174 → $0.000609
    expect(result.cost.totalCostUsd).toBeCloseTo(0.000609, 6);
  });

  it("renders the no-article placeholder for self-posts", async () => {
    chatMock.mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [],
      toolResults: [],
      finishReason: "stop",
    });

    await distillThread({
      hnUrl: "https://news.ycombinator.com/item?id=1",
      hnTitle: "Ask HN",
      hnAuthor: "alice",
      hnPoints: 10,
      totalComments: 0,
      selfPostBody: "What do you think?",
      article: null,
      threadText: "",
    });

    const call = chatMock.mock.calls[0][0];
    expect(call.messages[0].content).toContain("(no linked article");
    expect(call.messages[0].content).toContain("Self-post body:");
    expect(call.messages[0].content).toContain("What do you think?");
  });

  it("handles missing title/author/points gracefully", async () => {
    chatMock.mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [],
      toolResults: [],
      finishReason: "stop",
    });

    await distillThread({
      hnUrl: "https://news.ycombinator.com/item?id=1",
      hnTitle: null,
      hnAuthor: null,
      hnPoints: null,
      totalComments: 0,
      selfPostBody: null,
      article: null,
      threadText: "",
    });

    const call = chatMock.mock.calls[0][0];
    expect(call.messages[0].content).toContain("Title: (untitled)");
    expect(call.messages[0].content).toContain("Submitted by: [deleted]");
    expect(call.messages[0].content).toContain("(0 comments)");
  });
});
