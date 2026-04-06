import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EntryRow } from "../../src/db/queries/entries.js";
import type { ArtifactRow } from "../../src/db/queries/artifacts.js";
import type { OuraSummaryRow } from "../../src/db/queries/oura.js";

const mockEntries = vi.hoisted(() => ({
  getEntriesByDateRange: vi.fn(),
}));

const mockArtifacts = vi.hoisted(() => ({
  getRecentReviewArtifacts: vi.fn(),
}));

const mockOura = vi.hoisted(() => ({
  getOuraWeeklyRows: vi.fn(),
}));

const mockWeights = vi.hoisted(() => ({
  listWeights: vi.fn(),
}));

const mockDates = vi.hoisted(() => ({
  todayInTimezone: vi.fn().mockReturnValue("2026-03-28"),
  daysAgoInTimezone: vi.fn().mockImplementation((days: number) => {
    const d = new Date("2026-03-28T12:00:00Z");
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }),
  currentHourInTimezone: vi.fn(),
  todayDateInTimezone: vi.fn(),
  currentTimeLabel: vi.fn(),
}));

vi.mock("../../src/db/queries/entries.js", () => mockEntries);
vi.mock("../../src/db/queries/artifacts.js", () => mockArtifacts);
vi.mock("../../src/db/queries/oura.js", () => mockOura);
vi.mock("../../src/db/queries/weights.js", () => mockWeights);
vi.mock("../../src/utils/dates.js", () => mockDates);
vi.mock("../../src/oura/formatters.js", () => ({
  formatOuraWeekly: vi.fn().mockReturnValue("Sleep 85 | Readiness 82"),
}));
vi.mock("../../src/formatters/entry.js", () => ({
  formatEntry: vi.fn().mockImplementation((e: EntryRow) => `FULL: ${e.text}`),
}));

import { handleEveningReviewPrompt } from "../../src/prompts/evening-review.js";

const mockPool = {} as any;

function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    uuid: "ENTRY-001",
    text: "Woke up feeling good.",
    created_at: new Date("2026-03-28T08:00:00Z"),
    modified_at: null,
    timezone: "Europe/Madrid",
    city: "Barcelona",
    country: "Spain",
    place_name: "Eixample",
    admin_area: "Catalonia",
    latitude: 41.39,
    longitude: 2.17,
    temperature: 18,
    weather_conditions: "Sunny",
    humidity: 60,
    source: "dayone",
    version: 1,
    photo_count: 0,
    video_count: 0,
    audio_count: 0,
    media: [],
    weight_kg: null,
    ...overrides,
  };
}

function makeReview(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "review-001",
    kind: "review",
    title: "2026-03-27 — Evening Checkin",
    body: "**System state**: escalera green, boundaries yellow, attachment green",
    has_embedding: true,
    source: "mcp",
    source_path: null,
    deleted_at: null,
    created_at: new Date("2026-03-27T22:00:00Z"),
    updated_at: new Date("2026-03-27T22:00:00Z"),
    version: 1,
    source_entry_uuids: [],
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(mockEntries).forEach((fn) => fn.mockReset());
  Object.values(mockArtifacts).forEach((fn) => fn.mockReset());
  Object.values(mockOura).forEach((fn) => fn.mockReset());
  Object.values(mockWeights).forEach((fn) => fn.mockReset());
});

describe("handleEveningReviewPrompt", () => {
  it("returns system prompt and context messages", async () => {
    mockEntries.getEntriesByDateRange.mockResolvedValue([makeEntry()]);
    mockArtifacts.getRecentReviewArtifacts.mockResolvedValue([makeReview()]);
    mockOura.getOuraWeeklyRows.mockResolvedValue([]);
    mockWeights.listWeights.mockResolvedValue({ rows: [], count: 0 });

    const result = await handleEveningReviewPrompt(mockPool);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("user");

    // System prompt message
    const systemText = (result.messages[0].content as { text: string }).text;
    expect(systemText).toContain("Dutch auntie");
    expect(systemText).toContain("Escalera");
    expect(systemText).toContain("save_evening_review");
    expect(systemText).toContain("B1 Spanish");

    // Context message
    const contextText = (result.messages[1].content as { text: string }).text;
    expect(contextText).toContain("JOURNAL ENTRIES");
    expect(contextText).toContain("PAST EVENING REVIEWS");
    expect(contextText).toContain("OURA BIOMETRICS");
    expect(contextText).toContain("WEIGHT DATA");
  });

  it("includes full text for all entries (no truncation)", async () => {
    const todayEntry = makeEntry({ text: "Today's entry" });
    const oldEntry = makeEntry({
      text: "A".repeat(500),
      created_at: new Date("2026-03-22T08:00:00Z"),
    });
    mockEntries.getEntriesByDateRange.mockResolvedValue([oldEntry, todayEntry]);
    mockArtifacts.getRecentReviewArtifacts.mockResolvedValue([]);
    mockOura.getOuraWeeklyRows.mockResolvedValue([]);
    mockWeights.listWeights.mockResolvedValue({ rows: [], count: 0 });

    const result = await handleEveningReviewPrompt(mockPool);
    const contextText = (result.messages[1].content as { text: string }).text;

    // formatEntry is mocked to return "FULL: text" — both entries should use it
    expect(contextText).toContain("FULL: Today's entry");
    expect(contextText).toContain(`FULL: ${"A".repeat(500)}`);
    expect(contextText).not.toContain("CONTEXT NOTE");
  });

  it("degrades gracefully when Oura fails", async () => {
    mockEntries.getEntriesByDateRange.mockResolvedValue([]);
    mockArtifacts.getRecentReviewArtifacts.mockResolvedValue([]);
    mockOura.getOuraWeeklyRows.mockRejectedValue(new Error("Oura down"));
    mockWeights.listWeights.mockResolvedValue({ rows: [], count: 0 });

    const result = await handleEveningReviewPrompt(mockPool);
    const contextText = (result.messages[1].content as { text: string }).text;

    expect(contextText).toContain("Oura data unavailable");
    // Should still have other sections
    expect(contextText).toContain("JOURNAL ENTRIES");
  });

  it("degrades gracefully when weight fails", async () => {
    mockEntries.getEntriesByDateRange.mockResolvedValue([]);
    mockArtifacts.getRecentReviewArtifacts.mockResolvedValue([]);
    mockOura.getOuraWeeklyRows.mockResolvedValue([]);
    mockWeights.listWeights.mockRejectedValue(new Error("Weight DB error"));

    const result = await handleEveningReviewPrompt(mockPool);
    const contextText = (result.messages[1].content as { text: string }).text;

    expect(contextText).toContain("Weight data unavailable");
  });

  it("shows no entries message when empty", async () => {
    mockEntries.getEntriesByDateRange.mockResolvedValue([]);
    mockArtifacts.getRecentReviewArtifacts.mockResolvedValue([]);
    mockOura.getOuraWeeklyRows.mockResolvedValue([]);
    mockWeights.listWeights.mockResolvedValue({ rows: [], count: 0 });

    const result = await handleEveningReviewPrompt(mockPool);
    const contextText = (result.messages[1].content as { text: string }).text;

    expect(contextText).toContain("No journal entries found");
    expect(contextText).toContain("No evening reviews found");
  });

  it("formats weight trend with guideline zones", async () => {
    mockEntries.getEntriesByDateRange.mockResolvedValue([]);
    mockArtifacts.getRecentReviewArtifacts.mockResolvedValue([]);
    mockOura.getOuraWeeklyRows.mockResolvedValue([]);
    mockWeights.listWeights.mockResolvedValue({
      rows: [
        { date: new Date("2026-03-25T00:00:00Z"), weight_kg: 73.0, created_at: new Date() },
        { date: new Date("2026-03-28T00:00:00Z"), weight_kg: 76.0, created_at: new Date() },
      ],
      count: 2,
    });

    const result = await handleEveningReviewPrompt(mockPool);
    const contextText = (result.messages[1].content as { text: string }).text;

    expect(contextText).toContain("73.0kg");
    expect(contextText).toContain("ideal");
    expect(contextText).toContain("76.0kg");
    expect(contextText).toContain("DANGER");
  });

  it("includes past review bodies for trend context", async () => {
    mockEntries.getEntriesByDateRange.mockResolvedValue([]);
    mockArtifacts.getRecentReviewArtifacts.mockResolvedValue([makeReview()]);
    mockOura.getOuraWeeklyRows.mockResolvedValue([]);
    mockWeights.listWeights.mockResolvedValue({ rows: [], count: 0 });

    const result = await handleEveningReviewPrompt(mockPool);
    const contextText = (result.messages[1].content as { text: string }).text;

    expect(contextText).toContain("escalera green");
    expect(contextText).toContain("boundaries yellow");
  });

  it("queries correct 7-day date range", async () => {
    mockEntries.getEntriesByDateRange.mockResolvedValue([]);
    mockArtifacts.getRecentReviewArtifacts.mockResolvedValue([]);
    mockOura.getOuraWeeklyRows.mockResolvedValue([]);
    mockWeights.listWeights.mockResolvedValue({ rows: [], count: 0 });

    await handleEveningReviewPrompt(mockPool);

    expect(mockEntries.getEntriesByDateRange).toHaveBeenCalledWith(
      mockPool,
      "2026-03-21", // 7 days ago
      "2026-03-28",
      50
    );
    expect(mockArtifacts.getRecentReviewArtifacts).toHaveBeenCalledWith(
      mockPool,
      "2026-03-21",
      "2026-03-28"
    );
  });
});
