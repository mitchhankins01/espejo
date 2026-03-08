import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  findOrCreateDailyLogArtifact: vi.fn(),
  appendToDailyLog: vi.fn(),
  markCheckinResponded: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);

vi.mock("../../src/utils/dates.js", () => ({
  todayDateInTimezone: vi.fn(() => "2026-03-08"),
  currentTimeLabel: vi.fn(() => "Morning (9:15)"),
}));

import {
  processCheckinSummary,
  createOpenAISummaryClient,
  type SummaryLlmClient,
} from "../../src/checkins/summary.js";

const mockPool = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockQueries.findOrCreateDailyLogArtifact.mockResolvedValue({
    id: "artifact-123",
    body: "",
  });
  mockQueries.appendToDailyLog.mockResolvedValue(undefined);
  mockQueries.markCheckinResponded.mockResolvedValue(undefined);
});

describe("processCheckinSummary", () => {
  const stubClient: SummaryLlmClient = {
    summarize: vi.fn().mockResolvedValue("Summary of conversation."),
  };

  it("returns null for empty messages", async () => {
    const result = await processCheckinSummary(mockPool, stubClient, 1, [], "Europe/Madrid");
    expect(result).toBeNull();
  });

  it("returns null when summary is empty", async () => {
    const emptyClient: SummaryLlmClient = {
      summarize: vi.fn().mockResolvedValue(""),
    };
    const result = await processCheckinSummary(mockPool, emptyClient, 1, ["hello"], "Europe/Madrid");
    expect(result).toBeNull();
  });

  it("creates daily log artifact and appends section", async () => {
    const result = await processCheckinSummary(
      mockPool,
      stubClient,
      42,
      ["user: hello", "bot: hi"],
      "Europe/Madrid"
    );

    expect(result).not.toBeNull();
    expect(result!.artifactId).toBe("artifact-123");
    expect(result!.section).toContain("Morning (9:15)");
    expect(result!.section).toContain("Summary of conversation.");

    expect(mockQueries.findOrCreateDailyLogArtifact).toHaveBeenCalledWith(
      mockPool,
      "2026-03-08",
      ["daily-log"]
    );
    expect(mockQueries.appendToDailyLog).toHaveBeenCalledWith(
      mockPool,
      "artifact-123",
      expect.stringContaining("Summary of conversation.")
    );
    expect(mockQueries.markCheckinResponded).toHaveBeenCalledWith(mockPool, 42, "artifact-123");
  });
});

describe("createOpenAISummaryClient", () => {
  it("calls openai chat completions and returns trimmed content", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "  summarized text  " } }],
    });
    const fakeOpenai = { chat: { completions: { create: mockCreate } } };
    const client = createOpenAISummaryClient(fakeOpenai);

    const result = await client.summarize(["msg1", "msg2"]);

    expect(result).toBe("summarized text");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        max_tokens: 300,
      })
    );
  });

  it("returns empty string when no content", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null } }],
    });
    const fakeOpenai = { chat: { completions: { create: mockCreate } } };
    const client = createOpenAISummaryClient(fakeOpenai);

    const result = await client.summarize(["msg"]);
    expect(result).toBe("");
  });
});
