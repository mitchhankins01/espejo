import { describe, it, expect, vi } from "vitest";
import {
  buildSpanishPracticeSystemPrompt,
  getEspanolVivoBody,
  ESPANOL_VIVO_PATH,
  EXTRACTION_PROMPT,
} from "../../src/prompts/spanish-practice.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePool(rows: Array<{ body: string }>): any {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

describe("getEspanolVivoBody", () => {
  it("returns the body when the artifact exists", async () => {
    const pool = makePool([{ body: "state machine content" }]);
    const body = await getEspanolVivoBody(pool);
    expect(body).toBe("state machine content");
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [ESPANOL_VIVO_PATH]);
  });

  it("returns null when the artifact is missing", async () => {
    const pool = makePool([]);
    const body = await getEspanolVivoBody(pool);
    expect(body).toBeNull();
  });
});

describe("buildSpanishPracticeSystemPrompt", () => {
  it("injects the state machine body when present", async () => {
    const yamlBody = "level: A2/B1\nfocus:\n  topic: imperfecto vs pretérito\n";
    const pool = makePool([{ body: yamlBody }]);
    const prompt = await buildSpanishPracticeSystemPrompt(pool);
    expect(prompt).toContain("Mitch's Spanish conversation partner");
    expect(prompt).toContain("SESSION CONTRACT");
    expect(prompt).toContain(yamlBody);
    expect(prompt).toContain(ESPANOL_VIVO_PATH);
  });

  it("falls back gracefully when the state file is missing", async () => {
    const pool = makePool([]);
    const prompt = await buildSpanishPracticeSystemPrompt(pool);
    expect(prompt).toContain("State machine file not found");
    expect(prompt).toContain("SESSION CONTRACT");
  });
});

describe("EXTRACTION_PROMPT", () => {
  it("requests JSON output with updated_body and diff_summary keys", () => {
    expect(EXTRACTION_PROMPT).toContain("updated_body");
    expect(EXTRACTION_PROMPT).toContain("diff_summary");
    expect(EXTRACTION_PROMPT).toContain("audit_log");
  });
});
