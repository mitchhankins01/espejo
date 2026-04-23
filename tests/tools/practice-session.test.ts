import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetMessagesSince,
  mockUpsertObsidianArtifact,
  mockGetEspanolVivoBody,
  mockCreateClient,
  mockPutObjectContent,
  mockAnthropicCreate,
} = vi.hoisted(() => ({
  mockGetMessagesSince: vi.fn(),
  mockUpsertObsidianArtifact: vi.fn().mockResolvedValue("artifact-id"),
  mockGetEspanolVivoBody: vi.fn(),
  mockCreateClient: vi.fn().mockReturnValue({ r2: true }),
  mockPutObjectContent: vi.fn().mockResolvedValue(undefined),
  mockAnthropicCreate: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({ pool: {} }));

vi.mock("../../src/db/queries/chat.js", () => ({
  getMessagesSince: mockGetMessagesSince,
}));

vi.mock("../../src/db/queries/obsidian.js", () => ({
  upsertObsidianArtifact: mockUpsertObsidianArtifact,
}));

vi.mock("../../src/prompts/spanish-practice.js", () => ({
  ESPANOL_VIVO_PATH: "Project/Español Vivo.md",
  EXTRACTION_PROMPT: "EXTRACT",
  getEspanolVivoBody: mockGetEspanolVivoBody,
}));

vi.mock("../../src/storage/r2.js", () => ({
  createClient: mockCreateClient,
  putObjectContent: mockPutObjectContent,
}));

vi.mock("../../src/telegram/agent/constants.js", () => ({
  getAnthropic: () => ({
    messages: { create: mockAnthropicCreate },
  }),
}));

vi.mock("../../src/config.js", () => ({
  config: { anthropic: { model: "claude-sonnet-4-6" } },
}));

import {
  startPracticeSession,
  endPracticeSession,
  isPracticeSessionActive,
  getPracticeSession,
  runPracticeExtraction,
} from "../../src/telegram/practice-session.js";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockGetMessagesSince.mockReset();
  mockGetEspanolVivoBody.mockReset();
  mockPutObjectContent.mockReset().mockResolvedValue(undefined);
  mockUpsertObsidianArtifact.mockReset().mockResolvedValue("artifact-id");
  mockAnthropicCreate.mockReset();
  // Clean out any leftover sessions from previous tests
  endPracticeSession("99");
  endPracticeSession("100");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("session state", () => {
  it("tracks an active session", () => {
    expect(isPracticeSessionActive("99")).toBe(false);
    const session = startPracticeSession("99");
    expect(session.sessionId).toBeTruthy();
    expect(isPracticeSessionActive("99")).toBe(true);
    expect(getPracticeSession("99")).toEqual(session);
  });

  it("ends a session and returns the session record", () => {
    startPracticeSession("99");
    const ended = endPracticeSession("99");
    expect(ended).not.toBeNull();
    expect(isPracticeSessionActive("99")).toBe(false);
  });

  it("endPracticeSession returns null when no session is active", () => {
    expect(endPracticeSession("never-started")).toBeNull();
  });

  it("getPracticeSession returns null when no session is active", () => {
    expect(getPracticeSession("never-started")).toBeNull();
  });
});

describe("runPracticeExtraction", () => {
  const session = { sessionId: "s1", startedAt: new Date("2026-04-23T10:00:00Z") };

  function mockMessages(rows: Array<{ role: string; content: string }>): void {
    mockGetMessagesSince.mockResolvedValue(
      rows.map((r, i) => ({
        id: i + 1,
        chat_id: "100",
        external_message_id: null,
        role: r.role,
        content: r.content,
        tool_call_id: null,
        compacted_at: null,
        created_at: new Date(),
      }))
    );
  }

  function mockClaudeJsonReply(obj: { updated_body: string; diff_summary: string }): void {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(obj) }],
    });
  }

  it("returns early when no messages in the session", async () => {
    mockMessages([]);
    const result = await runPracticeExtraction("100", session);
    expect(result.messageCount).toBe(0);
    expect(result.wrotePersisted).toBe(false);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("returns error state when the state file is missing", async () => {
    mockMessages([{ role: "user", content: "hola" }]);
    mockGetEspanolVivoBody.mockResolvedValue(null);

    const result = await runPracticeExtraction("100", session);
    expect(result.wrotePersisted).toBe(false);
    expect(result.diffSummary).toContain("Could not find");
  });

  it("writes updated state to R2 and Postgres on success", async () => {
    mockMessages([
      { role: "user", content: "he siento cansado" },
      { role: "assistant", content: "(*me* siento — 'he' es auxiliar). ¿El cuerpo cómo lo siente?" },
    ]);
    mockGetEspanolVivoBody.mockResolvedValue("# Español Vivo\n\n## Practice Log\n\n|Fecha|Tipo|Notas|\n|---|---|---|");
    mockClaudeJsonReply({
      updated_body: "# Español Vivo\n\n## Practice Log\n\n| 2026-04-23 | LLM | he siento → me siento |\n## Audit Log\n- 2026-04-23 10:30 — s1 — added row",
      diff_summary: "- Added practice log row\n- Added audit line",
    });

    const result = await runPracticeExtraction("100", session);
    expect(result.wrotePersisted).toBe(true);
    expect(result.messageCount).toBe(2);
    expect(mockPutObjectContent).toHaveBeenCalledWith(
      { r2: true },
      "artifacts",
      "Project/Español Vivo.md",
      expect.stringContaining("Audit Log")
    );
    expect(mockUpsertObsidianArtifact).toHaveBeenCalled();
  });

  it("handles unparseable JSON from the model", async () => {
    mockMessages([{ role: "user", content: "hola" }]);
    mockGetEspanolVivoBody.mockResolvedValue("state");
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "not json at all" }],
    });

    const result = await runPracticeExtraction("100", session);
    expect(result.wrotePersisted).toBe(false);
    expect(result.diffSummary).toContain("unparseable");
    expect(mockPutObjectContent).not.toHaveBeenCalled();
  });

  it("strips markdown code fences around JSON", async () => {
    mockMessages([{ role: "user", content: "hola" }]);
    mockGetEspanolVivoBody.mockResolvedValue("state");
    mockAnthropicCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "```json\n" + JSON.stringify({ updated_body: "new", diff_summary: "ok" }) + "\n```",
        },
      ],
    });

    const result = await runPracticeExtraction("100", session);
    expect(result.wrotePersisted).toBe(true);
  });

  it("reports a non-destructive failure when R2 write fails", async () => {
    mockMessages([{ role: "user", content: "hola" }]);
    mockGetEspanolVivoBody.mockResolvedValue("state");
    mockClaudeJsonReply({ updated_body: "x", diff_summary: "y" });
    mockPutObjectContent.mockRejectedValueOnce(new Error("R2 auth failed"));

    const result = await runPracticeExtraction("100", session);
    expect(result.wrotePersisted).toBe(false);
    expect(result.diffSummary).toContain("R2 write failed");
  });

  it("continues successfully even if Postgres mirror update fails", async () => {
    mockMessages([{ role: "user", content: "hola" }]);
    mockGetEspanolVivoBody.mockResolvedValue("state");
    mockClaudeJsonReply({ updated_body: "new body", diff_summary: "summary" });
    mockUpsertObsidianArtifact.mockRejectedValueOnce(new Error("PG down"));

    const result = await runPracticeExtraction("100", session);
    expect(result.wrotePersisted).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("rejects json with missing or non-string keys", async () => {
    mockMessages([{ role: "user", content: "hola" }]);
    mockGetEspanolVivoBody.mockResolvedValue("state");
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ updated_body: 123, diff_summary: "x" }) }],
    });
    const result = await runPracticeExtraction("100", session);
    expect(result.wrotePersisted).toBe(false);
    expect(result.diffSummary).toContain("unparseable");
  });
});
