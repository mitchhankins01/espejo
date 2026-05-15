import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("get_recent_checkpoints spec", () => {
  it("defaults days to 7", () => {
    const result = validateToolInput("get_recent_checkpoints", {});
    expect(result.days).toBe(7);
  });
  it("accepts a custom day count", () => {
    expect(validateToolInput("get_recent_checkpoints", { days: 1 }).days).toBe(1);
    expect(validateToolInput("get_recent_checkpoints", { days: 30 }).days).toBe(30);
  });
  it("rejects out-of-range day counts", () => {
    expect(() => validateToolInput("get_recent_checkpoints", { days: 0 })).toThrow();
    expect(() => validateToolInput("get_recent_checkpoints", { days: 31 })).toThrow();
  });
  it("has the expected tool name", () => {
    expect(toolSpecs.get_recent_checkpoints.name).toBe("get_recent_checkpoints");
  });
});

describe("get_recent_weights spec", () => {
  it("defaults days to 7", () => {
    expect(validateToolInput("get_recent_weights", {}).days).toBe(7);
  });
  it("rejects out-of-range day counts", () => {
    expect(() => validateToolInput("get_recent_weights", { days: 0 })).toThrow();
    expect(() => validateToolInput("get_recent_weights", { days: 91 })).toThrow();
  });
  it("has the expected tool name", () => {
    expect(toolSpecs.get_recent_weights.name).toBe("get_recent_weights");
  });
});

describe("get_oura_day_context spec", () => {
  it("accepts empty params", () => {
    expect(validateToolInput("get_oura_day_context", {})).toEqual({});
  });
  it("accepts an explicit date", () => {
    const result = validateToolInput("get_oura_day_context", { date: "2026-05-14" });
    expect(result.date).toBe("2026-05-14");
  });
  it("rejects a malformed date", () => {
    expect(() =>
      validateToolInput("get_oura_day_context", { date: "May 14, 2026" })
    ).toThrow();
  });
});

describe("get_recent_agent_chats spec", () => {
  it("defaults days to 1", () => {
    expect(validateToolInput("get_recent_agent_chats", {}).days).toBe(1);
  });
  it("caps days at 7", () => {
    expect(() => validateToolInput("get_recent_agent_chats", { days: 8 })).toThrow();
  });
});

describe("get_recent_commits spec", () => {
  it("defaults limit to 30", () => {
    expect(validateToolInput("get_recent_commits", {}).limit).toBe(30);
  });
  it("accepts since_iso + limit", () => {
    const result = validateToolInput("get_recent_commits", {
      since_iso: "2026-05-14T00:00:00Z",
      limit: 50,
    });
    expect(result.since_iso).toBe("2026-05-14T00:00:00Z");
    expect(result.limit).toBe(50);
  });
  it("rejects limit above 100", () => {
    expect(() => validateToolInput("get_recent_commits", { limit: 101 })).toThrow();
  });
});
