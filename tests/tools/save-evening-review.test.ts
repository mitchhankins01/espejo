import { describe, it, expect, vi, beforeEach } from "vitest";

const mockR2 = vi.hoisted(() => {
  const tpl = "---\nkind: review\ntags: []\n---\n# {{title}}\n\n{{body}}\n";
  return {
    MOCK_TEMPLATE: tpl,
    createClient: vi.fn().mockReturnValue({}),
    putObjectContent: vi.fn().mockResolvedValue(undefined),
    getObjectContent: vi.fn().mockResolvedValue(tpl),
  };
});

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
  mockR2.getObjectContent.mockReset().mockResolvedValue(mockR2.MOCK_TEMPLATE);
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

  it("fetches template from R2", async () => {
    await handleSaveEveningReview(mockPool, { text: "Review body" });

    expect(mockR2.getObjectContent).toHaveBeenCalledWith(
      {},
      "artifacts",
      "Templates/Review.md"
    );
  });

  it("applies template with title and body", async () => {
    await handleSaveEveningReview(mockPool, { text: "Review body" });

    const markdown = mockR2.putObjectContent.mock.calls[0][3] as string;
    expect(markdown).toContain("kind: review");
    expect(markdown).toContain("# 2026-03-28 — Evening Checkin");
    expect(markdown).toContain("Review body");
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

  it("falls back to hardcoded template when R2 fetch fails", async () => {
    mockR2.getObjectContent.mockRejectedValue(new Error("Not found"));

    await handleSaveEveningReview(mockPool, { text: "Review body" });

    const markdown = mockR2.putObjectContent.mock.calls[0][3] as string;
    expect(markdown).toContain("kind: review");
    expect(markdown).toContain("# 2026-03-28 — Evening Checkin");
    expect(markdown).toContain("Review body");
  });

  it("overwrites existing file on same date (R2 PUT is idempotent)", async () => {
    await handleSaveEveningReview(mockPool, { text: "First draft" });
    await handleSaveEveningReview(mockPool, { text: "Revised draft" });

    expect(mockR2.putObjectContent).toHaveBeenCalledTimes(2);
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

  it("replaces {{date}} placeholder in template", async () => {
    mockR2.getObjectContent.mockResolvedValue(
      "---\nkind: review\n---\n# {{title}}\nDate: {{date}}\n\n{{body}}\n"
    );

    await handleSaveEveningReview(mockPool, { text: "Body" });

    const markdown = mockR2.putObjectContent.mock.calls[0][3] as string;
    expect(markdown).toContain("Date: 2026-03-28");
  });
});
