import { describe, test, expect } from "vitest";
import {
  formatEntryDate,
  formatShortDate,
  formatRelativeDate,
} from "$lib/utils/dates";

describe("formatEntryDate", () => {
  test("formats ISO date to human-readable", () => {
    expect(formatEntryDate("2025-11-15T10:30:00.000Z")).toBe(
      "November 15, 2025"
    );
  });

  test("handles midnight UTC", () => {
    expect(formatEntryDate("2025-01-01T00:00:00.000Z")).toBe(
      "January 1, 2025"
    );
  });

  test("handles end of year", () => {
    expect(formatEntryDate("2025-12-31T23:59:59.000Z")).toBe(
      "December 31, 2025"
    );
  });
});

describe("formatShortDate", () => {
  test("formats to short month and day", () => {
    expect(formatShortDate("2025-11-15T10:30:00.000Z")).toBe("Nov 15");
  });
});

describe("formatRelativeDate", () => {
  test("returns 'Today' for today's date", () => {
    const today = new Date().toISOString();
    expect(formatRelativeDate(today)).toBe("Today");
  });

  test("returns 'Yesterday' for yesterday", () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    expect(formatRelativeDate(yesterday)).toBe("Yesterday");
  });

  test("returns days ago for recent dates", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    expect(formatRelativeDate(threeDaysAgo)).toBe("3 days ago");
  });

  test("returns weeks ago", () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    expect(formatRelativeDate(twoWeeksAgo)).toBe("2 weeks ago");
  });
});
