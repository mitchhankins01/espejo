import { describe, it, expect, vi, beforeEach } from "vitest";

const mockR2 = vi.hoisted(() => ({
  createClient: vi.fn().mockReturnValue({}),
  putObjectContent: vi.fn().mockResolvedValue(undefined),
}));

const mockDates = vi.hoisted(() => ({
  todayInTimezone: vi.fn().mockReturnValue("2026-03-28"),
  daysAgoInTimezone: vi.fn(),
  currentHourInTimezone: vi.fn(),
  todayDateInTimezone: vi.fn(),
  currentTimeLabel: vi.fn(),
}));

vi.mock("../../src/storage/r2.js", () => mockR2);
vi.mock("../../src/utils/dates.js", () => mockDates);

import { handleSaveEveningReview } from "../../src/tools/save-evening-review.js";

const mockPool = {} as any;

beforeEach(() => {
  mockR2.putObjectContent.mockReset().mockResolvedValue(undefined);
  mockR2.createClient.mockReset().mockReturnValue({});
});

describe("handleSaveEveningReview", () => {
  it("writes review markdown to R2 in Review folder", async () => {
    const result = await handleSaveEveningReview(mockPool, {
      text: "**System state**: escalera green, boundaries yellow",
    });

    expect(mockR2.putObjectContent).toHaveBeenCalledWith(
      {},
      "artifacts",
      "Review/2026-03-28 — Evening Checkin.md",
      expect.stringContaining("**System state**: escalera green, boundaries yellow")
    );
    expect(result).toContain("Review/2026-03-28 — Evening Checkin.md");
  });

  it("includes correct frontmatter", async () => {
    await handleSaveEveningReview(mockPool, { text: "Review body" });

    const markdown = mockR2.putObjectContent.mock.calls[0][3] as string;
    expect(markdown).toContain("kind: review");
    expect(markdown).toContain("status: approved");
    expect(markdown).toContain("tags: []");
  });

  it("includes title as first heading", async () => {
    await handleSaveEveningReview(mockPool, { text: "Review body" });

    const markdown = mockR2.putObjectContent.mock.calls[0][3] as string;
    expect(markdown).toContain("# 2026-03-28 — Evening Checkin");
  });

  it("uses provided date for title", async () => {
    await handleSaveEveningReview(mockPool, {
      text: "Review text",
      date: "2026-03-27",
    });

    expect(mockR2.putObjectContent).toHaveBeenCalledWith(
      {},
      "artifacts",
      "Review/2026-03-27 — Evening Checkin.md",
      expect.stringContaining("# 2026-03-27 — Evening Checkin")
    );
  });

  it("overwrites existing file on same date (R2 PUT is idempotent)", async () => {
    await handleSaveEveningReview(mockPool, { text: "First draft" });
    await handleSaveEveningReview(mockPool, { text: "Revised draft" });

    expect(mockR2.putObjectContent).toHaveBeenCalledTimes(2);
    // Both write to same key — R2 PUT overwrites
    const key1 = mockR2.putObjectContent.mock.calls[0][2];
    const key2 = mockR2.putObjectContent.mock.calls[1][2];
    expect(key1).toBe(key2);
  });

  it("rejects empty text", async () => {
    await expect(
      handleSaveEveningReview(mockPool, { text: "" })
    ).rejects.toThrow();
  });

  it("rejects invalid date format", async () => {
    await expect(
      handleSaveEveningReview(mockPool, { text: "Review", date: "March 28" })
    ).rejects.toThrow();
  });
});
