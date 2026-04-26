import { describe, it, expect, vi, beforeEach } from "vitest";

const messagesCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class FakeAnthropic {
      public messages = { create: messagesCreate };
    },
  };
});

import { distillThread } from "../../src/hn/distill.js";

beforeEach(() => {
  messagesCreate.mockReset();
});

describe("distillThread", () => {
  it("calls Opus 4.7 with the spec system prompt and user content", async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "## Headline facts\n\nA test." }],
      usage: { input_tokens: 1000, output_tokens: 200 },
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

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const call = messagesCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-opus-4-7");
    expect(call.max_tokens).toBe(4096);
    expect(call.system).toContain("distill Hacker News threads");
    expect(call.messages[0].role).toBe("user");
    expect(call.messages[0].content).toContain("ARTICLE");
    expect(call.messages[0].content).toContain("Title: Article");
    expect(call.messages[0].content).toContain("[1] bob: hello");
    expect(call.messages[0].content).toContain("(100 points");
    expect(call.messages[0].content).toContain("3 comments)");

    expect(result.markdown).toBe("## Headline facts\n\nA test.");
    expect(result.model).toBe("claude-opus-4-7");
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
    // 1000 in * $5/M = $0.005, 200 out * $25/M = $0.005 → $0.01
    expect(result.cost.totalCostUsd).toBeCloseTo(0.01, 6);
  });

  it("renders the no-article placeholder for self-posts", async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 5 },
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

    const call = messagesCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("(no linked article");
    expect(call.messages[0].content).toContain("Self-post body:");
    expect(call.messages[0].content).toContain("What do you think?");
  });

  it("handles missing title/author/points gracefully", async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
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

    const call = messagesCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("Title: (untitled)");
    expect(call.messages[0].content).toContain("Submitted by: [deleted]");
    expect(call.messages[0].content).toContain("(0 comments)");
  });
});
