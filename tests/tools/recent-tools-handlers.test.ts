import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCheckpoints = vi.hoisted(() => ({
  getRecentCheckpoints: vi.fn(),
}));
const mockWeights = vi.hoisted(() => ({
  listWeights: vi.fn(),
}));
const mockOura = vi.hoisted(() => ({
  getOuraDayContext: vi.fn(),
}));
const mockAgentSessions = vi.hoisted(() => ({
  getRecentAgentPrompts: vi.fn(),
}));
const mockChat = vi.hoisted(() => ({
  getRecentChatPrompts: vi.fn(),
}));
const mockConfig = vi.hoisted(() => ({
  config: { timezone: "Europe/Madrid", github: { owner: "x", repo: "y" } },
}));

vi.mock("../../src/db/queries/checkpoints.js", () => mockCheckpoints);
vi.mock("../../src/db/queries/weights.js", () => mockWeights);
vi.mock("../../src/db/queries/oura.js", () => mockOura);
vi.mock("../../src/db/queries/agent-sessions.js", () => mockAgentSessions);
vi.mock("../../src/db/queries/chat.js", () => mockChat);
vi.mock("../../src/config.js", () => mockConfig);

import { handleGetRecentCheckpoints } from "../../src/tools/get-recent-checkpoints.js";
import { handleGetRecentWeights } from "../../src/tools/get-recent-weights.js";
import { handleGetOuraDayContext } from "../../src/tools/get-oura-day-context.js";
import { handleGetRecentAgentChats } from "../../src/tools/get-recent-agent-chats.js";

const mockPool = {} as never;

beforeEach(() => {
  Object.values(mockCheckpoints).forEach((m) => m.mockReset());
  Object.values(mockWeights).forEach((m) => m.mockReset());
  Object.values(mockOura).forEach((m) => m.mockReset());
  Object.values(mockAgentSessions).forEach((m) => m.mockReset());
  Object.values(mockChat).forEach((m) => m.mockReset());
});

describe("handleGetRecentCheckpoints", () => {
  it("formats rows from the query", async () => {
    mockCheckpoints.getRecentCheckpoints.mockResolvedValueOnce([
      {
        id: 1,
        kind: "substance",
        trigger: "Nic",
        body_signal: "head",
        part_voice: "wants stim",
        resolution: "go",
        payload: {},
        source: "telegram",
        chat_id: null,
        occurred_at: new Date("2026-05-15T16:30:00Z"),
        local_date: "2026-05-15",
        created_at: new Date(),
      },
    ]);
    const result = await handleGetRecentCheckpoints(mockPool, { days: 7 });
    expect(result).toContain("1 checkpoint");
    expect(result).toContain("substance | Nic | head | wants stim | go");
  });

  it("handles empty result", async () => {
    mockCheckpoints.getRecentCheckpoints.mockResolvedValueOnce([]);
    const result = await handleGetRecentCheckpoints(mockPool, { days: 1 });
    expect(result).toContain("No checkpoints");
  });

  it("supports local_date as a Date object", async () => {
    mockCheckpoints.getRecentCheckpoints.mockResolvedValueOnce([
      {
        id: 1,
        kind: "substance",
        trigger: "Weed",
        body_signal: null,
        part_voice: null,
        resolution: null,
        payload: {},
        source: "mcp",
        chat_id: null,
        occurred_at: new Date("2026-05-15T16:30:00Z"),
        local_date: new Date(Date.UTC(2026, 4, 15)),
        created_at: new Date(),
      },
    ]);
    const result = await handleGetRecentCheckpoints(mockPool, { days: 7 });
    expect(result).toMatch(/2026-05-15 \d{2}:\d{2} \| substance \| Weed/);
    expect(result).toContain("—"); // null fallbacks
  });
});

describe("handleGetRecentWeights", () => {
  it("formats weight rows newest-first", async () => {
    mockWeights.listWeights.mockResolvedValueOnce({
      rows: [
        { date: new Date(Date.UTC(2026, 4, 15)), weight_kg: 78.2, created_at: new Date() },
        { date: new Date(Date.UTC(2026, 4, 14)), weight_kg: 78.4, created_at: new Date() },
      ],
      count: 2,
    });
    const result = await handleGetRecentWeights(mockPool, { days: 7 });
    expect(result).toContain("2 measurements");
    expect(result).toContain("2026-05-15: 78.2 kg");
    expect(result).toContain("2026-05-14: 78.4 kg");
  });

  it("reports no measurements when result is empty", async () => {
    mockWeights.listWeights.mockResolvedValueOnce({ rows: [], count: 0 });
    const result = await handleGetRecentWeights(mockPool, { days: 7 });
    expect(result).toContain("No weight measurements");
  });
});

describe("handleGetOuraDayContext", () => {
  it("renders tags, sessions, and bedtime", async () => {
    mockOura.getOuraDayContext.mockResolvedValueOnce({
      tags: [
        {
          start_time: new Date("2026-05-15T20:00:00Z"),
          tag_type_code: "alcohol",
          custom_name: null,
          comment: "glass of wine",
        },
      ],
      sessions: [
        {
          start_time: new Date("2026-05-15T19:00:00Z"),
          type: "meditation",
          mood: "calm",
        },
      ],
      sleep_time: {
        recommendation: "GOOD",
        optimal_bedtime: { start: "23:00", end: "24:00" },
      },
    });
    const result = await handleGetOuraDayContext(mockPool, { date: "2026-05-15" });
    expect(result).toContain("Oura day context for 2026-05-15");
    expect(result).toContain("alcohol — glass of wine");
    expect(result).toContain("meditation (calm)");
    expect(result).toContain("recommendation: GOOD");
  });

  it("falls back gracefully when the day is empty", async () => {
    mockOura.getOuraDayContext.mockResolvedValueOnce({
      tags: [],
      sessions: [],
      sleep_time: null,
    });
    const result = await handleGetOuraDayContext(mockPool, {});
    expect(result).toContain("Tags (0):");
    expect(result).toContain("Sessions (0):");
    expect(result).toContain("(no recommendation)");
  });

  it("uses custom_name when present and shows no-comment tags", async () => {
    mockOura.getOuraDayContext.mockResolvedValueOnce({
      tags: [
        {
          start_time: new Date("2026-05-15T20:00:00Z"),
          tag_type_code: null,
          custom_name: "post-walk",
          comment: null,
        },
      ],
      sessions: [
        { start_time: new Date("2026-05-15T19:00:00Z"), type: null, mood: null },
      ],
      sleep_time: { recommendation: null, optimal_bedtime: null },
    });
    const result = await handleGetOuraDayContext(mockPool, {});
    expect(result).toContain("post-walk");
    expect(result).toContain("session");
    expect(result).toContain("(none)");
  });
});

describe("handleGetRecentAgentChats", () => {
  it("merges agent and chat prompts with truncation", async () => {
    mockAgentSessions.getRecentAgentPrompts.mockResolvedValueOnce([
      {
        started_at: new Date("2026-05-15T09:00:00Z"),
        surface: "claude-code",
        category: "dev",
        text: "fix the bug in the search code please".repeat(20),
      },
    ]);
    mockChat.getRecentChatPrompts.mockResolvedValueOnce([
      {
        created_at: new Date("2026-05-15T10:00:00Z"),
        flow: "chat",
        content: "thinking out loud here",
      },
    ]);
    const result = await handleGetRecentAgentChats(mockPool, { days: 1 });
    expect(result).toContain("Agent sessions");
    expect(result).toContain("[claude-code/dev]");
    expect(result).toContain("Telegram");
    expect(result).toContain("[chat] thinking out loud here");
    expect(result).toContain("…"); // truncation marker
  });

  it("handles both sides empty", async () => {
    mockAgentSessions.getRecentAgentPrompts.mockResolvedValueOnce([]);
    mockChat.getRecentChatPrompts.mockResolvedValueOnce([]);
    const result = await handleGetRecentAgentChats(mockPool, { days: 1 });
    expect(result).toContain("Agent sessions (Claude Code / Codex) — 0 prompts");
    expect(result).toContain("Telegram (all flows) — 0 turns");
  });
});
