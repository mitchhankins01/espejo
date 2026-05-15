import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleGetRecentCommits } from "../../src/tools/get-recent-commits.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockPool = {} as never;

describe("handleGetRecentCommits", () => {
  it("formats commits returned by GitHub", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          sha: "abcdef1234567890",
          html_url: "https://github.com/mitchhankins01/espejo/commit/abcdef1",
          commit: {
            author: { date: "2026-05-15T10:30:00Z", name: "Mitch" },
            message: "feat: add evening review dual-flow\n\nlong body here",
          },
        },
        {
          sha: "0123456789abcdef",
          html_url: "https://github.com/mitchhankins01/espejo/commit/0123456",
          commit: {
            author: { date: "2026-05-15T11:00:00Z", name: "Mitch" },
            message: "fix: typo",
          },
        },
      ],
    } as unknown as Response);

    const result = await handleGetRecentCommits(mockPool, {
      since_iso: "2026-05-15T00:00:00Z",
      limit: 30,
    });

    expect(result).toContain("2 commits");
    expect(result).toContain("abcdef1 2026-05-15T10:30:00Z feat: add evening review dual-flow");
    expect(result).toContain("0123456 2026-05-15T11:00:00Z fix: typo");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/mitchhankins01/espejo/commits");
    expect(calledUrl).toContain("since=2026-05-15T00%3A00%3A00Z");
    expect(calledUrl).toContain("per_page=30");
  });

  it("notes when there are no commits", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as unknown as Response);

    const result = await handleGetRecentCommits(mockPool, {
      since_iso: "2026-05-15T00:00:00Z",
      limit: 30,
    });
    expect(result).toContain("No commits");
  });

  it("reports GitHub API errors without throwing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "rate limited",
    } as unknown as Response);

    const result = await handleGetRecentCommits(mockPool, {
      since_iso: "2026-05-15T00:00:00Z",
      limit: 30,
    });
    expect(result).toContain("GitHub API error (403)");
    expect(result).toContain("rate limited");
  });

  it("falls back to today 00:00 local when since_iso is omitted", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as unknown as Response);

    await handleGetRecentCommits(mockPool, { limit: 30 });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toMatch(/since=\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}/);
  });
});
