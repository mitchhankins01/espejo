import { describe, expect, it } from "vitest";
import { toolSpecs, validateToolInput } from "../../specs/tools.spec.js";

describe("memory tool specs", () => {
  it("validates remember input", () => {
    const params = validateToolInput("remember", {
      content: "Lives in Barcelona",
      kind: "identity",
    });
    expect(params.kind).toBe("identity");
  });

  it("validates save_chat input", () => {
    const params = validateToolInput("save_chat", {
      messages: "User: I live in Barcelona.",
    });
    expect(params.messages).toContain("Barcelona");
  });

  it("validates recall defaults", () => {
    const params = validateToolInput("recall", { query: "language preferences" });
    expect(params.limit).toBe(10);
  });

  it("validates reflect action enum", () => {
    const params = validateToolInput("reflect", { action: "stats" });
    expect(params.action).toBe("stats");
  });

  it("registers expected names", () => {
    expect(toolSpecs.remember.name).toBe("remember");
    expect(toolSpecs.save_chat.name).toBe("save_chat");
    expect(toolSpecs.recall.name).toBe("recall");
    expect(toolSpecs.reflect.name).toBe("reflect");
  });
});
