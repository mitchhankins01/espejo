import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchHnItem, countItems, type HnItem } from "../../src/hn/algolia.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tree(over: Partial<HnItem> = {}): HnItem {
  return {
    id: 1,
    created_at: null,
    created_at_i: null,
    type: "story",
    author: "alice",
    title: "x",
    url: null,
    text: null,
    points: null,
    parent_id: null,
    story_id: null,
    children: [],
    ...over,
  };
}

describe("countItems", () => {
  it("counts the root alone for a leaf", () => {
    expect(countItems(tree())).toBe(1);
  });

  it("counts the full recursive tree", () => {
    const item = tree({
      children: [tree({ children: [tree(), tree()] }), tree()],
    });
    // root + (a + a.1 + a.2) + b = 5
    expect(countItems(item)).toBe(5);
  });
});

describe("fetchHnItem", () => {
  it("returns parsed JSON on a 200 response", async () => {
    const payload = tree({ id: 12345, title: "ok" });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    const result = await fetchHnItem(12345);
    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hn.algolia.com/api/v1/items/12345"
    );
  });

  it("retries on 503 then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => tree({ id: 7 }),
      });
    const result = await fetchHnItem(7);
    expect(result.id).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws an actionable error on a non-retryable 404", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    await expect(fetchHnItem(404)).rejects.toThrow(/HN Algolia API failed/);
  });
});
