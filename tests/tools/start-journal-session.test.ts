import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getTemplateBySlug: vi.fn(),
  getOuraSummaryByDay: vi.fn(),
  getOuraWeeklyRows: vi.fn(),
  getEntriesByDateRange: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => ({
  config: { timezone: "Europe/Madrid" },
}));

import { handleStartJournalSession } from "../../src/tools/start-journal-session.js";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const mockPool = {} as any;

beforeEach(() => {
  Object.values(mockQueries).forEach((fn) => fn.mockReset());
});

describe("start_journal_session spec", () => {
  it("validates morning input", () => {
    const result = validateToolInput("start_journal_session", { type: "morning" });
    expect(result.type).toBe("morning");
  });

  it("validates evening input with date", () => {
    const result = validateToolInput("start_journal_session", {
      type: "evening",
      date: "2026-03-08",
    });
    expect(result.type).toBe("evening");
    expect(result.date).toBe("2026-03-08");
  });

  it("rejects invalid type", () => {
    expect(() =>
      validateToolInput("start_journal_session", { type: "afternoon" })
    ).toThrow();
  });

  it("rejects missing type", () => {
    expect(() => validateToolInput("start_journal_session", {})).toThrow();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.start_journal_session.name).toBe("start_journal_session");
  });
});

/** Extract text from the first content block targeted at both audiences. */
function getUserText(result: CallToolResult): string {
  const block = result.content.find(
    (c) => c.type === "text" && c.annotations?.audience?.includes("user")
  );
  return block && "text" in block ? block.text : "";
}

/** Extract assistant-only content block (system prompt). */
function getAssistantOnlyText(result: CallToolResult): string | undefined {
  const block = result.content.find(
    (c) =>
      c.type === "text" &&
      c.annotations?.audience?.includes("assistant") &&
      !c.annotations?.audience?.includes("user")
  );
  return block && "text" in block ? block.text : undefined;
}

describe("handleStartJournalSession", () => {
  it("returns morning context with Oura data and audience annotations", async () => {
    mockQueries.getTemplateBySlug.mockResolvedValue({
      id: "t1",
      slug: "morning",
      name: "Morning",
      body: "How did you sleep?",
      system_prompt: "Guide the user warmly...",
      default_tags: ["morning-journal"],
      sort_order: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    mockQueries.getOuraSummaryByDay.mockResolvedValue({
      day: "2026-03-09",
      sleep_score: 85,
      readiness_score: 80,
      activity_score: 75,
      steps: 8000,
      stress: "normal",
      average_hrv: 42,
      average_heart_rate: 60,
      sleep_duration_seconds: 28800,
      deep_sleep_duration_seconds: 7200,
      rem_sleep_duration_seconds: 5400,
      efficiency: 90,
      workout_count: 0,
    });

    const result = await handleStartJournalSession(mockPool, {
      type: "morning",
      date: "2026-03-09",
    });

    // User+assistant content block has template body and context
    const userText = getUserText(result);
    const parsed = JSON.parse(userText);
    expect(parsed.template.body).toBe("How did you sleep?");
    expect(parsed.context.oura).toContain("Sleep 85");
    expect(parsed.date).toBe("2026-03-09");

    // System prompt is assistant-only
    expect(getAssistantOnlyText(result)).toBe("Guide the user warmly...");

    // Verify audience annotations
    expect(result.content).toHaveLength(2);
    const first = result.content[0];
    expect("annotations" in first && first.annotations?.audience).toEqual(["user", "assistant"]);
    const second = result.content[1];
    expect("annotations" in second && second.annotations?.audience).toEqual(["assistant"]);
  });

  it("returns morning context without Oura and omits system_prompt block when null", async () => {
    mockQueries.getTemplateBySlug.mockResolvedValue({
      id: "t1",
      slug: "morning",
      name: "Morning",
      body: "How are you?",
      system_prompt: null,
      default_tags: [],
      sort_order: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    mockQueries.getOuraSummaryByDay.mockResolvedValue(null);

    const result = await handleStartJournalSession(mockPool, {
      type: "morning",
      date: "2026-03-09",
    });

    const parsed = JSON.parse(getUserText(result));
    expect(parsed.context.oura).toBeUndefined();
    // No system_prompt → only one content block
    expect(result.content).toHaveLength(1);
    expect(getAssistantOnlyText(result)).toBeUndefined();
  });

  it("throws when morning template not found", async () => {
    mockQueries.getTemplateBySlug.mockResolvedValue(null);
    mockQueries.getOuraSummaryByDay.mockResolvedValue(null);

    await expect(
      handleStartJournalSession(mockPool, { type: "morning", date: "2026-03-09" })
    ).rejects.toThrow("Morning template not found");
  });

  it("returns evening context with entries and Oura week", async () => {
    mockQueries.getTemplateBySlug.mockResolvedValue({
      id: "t2",
      slug: "evening",
      name: "Evening",
      body: "How was your week?",
      system_prompt: "Conduct structured interview...",
      default_tags: ["evening-review"],
      sort_order: 1,
      created_at: new Date(),
      updated_at: new Date(),
    });
    mockQueries.getOuraWeeklyRows.mockResolvedValue([
      {
        day: "2026-03-09",
        sleep_score: 85,
        readiness_score: 80,
        average_hrv: 42,
        steps: 8000,
      },
    ]);
    mockQueries.getEntriesByDateRange.mockResolvedValue([
      {
        uuid: "e1",
        text: "Had a good day working on the project.",
        created_at: new Date("2026-03-09T10:00:00Z"),
        tags: ["work"],
      },
    ]);

    const result = await handleStartJournalSession(mockPool, {
      type: "evening",
      date: "2026-03-09",
    });

    const parsed = JSON.parse(getUserText(result));
    expect(parsed.template.body).toBe("How was your week?");
    expect(parsed.context.entries_summary).toContain("work");
    expect(parsed.context.entries_summary).toContain("Had a good day");
    expect(parsed.context.oura_week).toContain("Sleep 85");
    expect(parsed.date).toBe("2026-03-09");

    expect(getAssistantOnlyText(result)).toBe("Conduct structured interview...");
  });

  it("throws when evening template not found", async () => {
    mockQueries.getTemplateBySlug.mockResolvedValue(null);
    mockQueries.getOuraWeeklyRows.mockResolvedValue([]);
    mockQueries.getEntriesByDateRange.mockResolvedValue([]);

    await expect(
      handleStartJournalSession(mockPool, { type: "evening", date: "2026-03-09" })
    ).rejects.toThrow("Evening template not found");
  });
});
