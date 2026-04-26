import { describe, it, expect } from "vitest";
import {
  computeCost,
  formatCost,
  MODEL_PRICING,
} from "../../src/hn/pricing.js";

describe("MODEL_PRICING", () => {
  it("includes claude-opus-4-7 at $5/$25 per MTok", () => {
    expect(MODEL_PRICING["claude-opus-4-7"]).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 25,
    });
  });
});

describe("computeCost", () => {
  it("calculates Opus 4.7 cost for a known token count", () => {
    const result = computeCost("claude-opus-4-7", {
      inputTokens: 100_000,
      outputTokens: 10_000,
    });
    // 100k * $5/M = $0.50 input
    // 10k * $25/M = $0.25 output
    expect(result.inputCostUsd).toBeCloseTo(0.5, 6);
    expect(result.outputCostUsd).toBeCloseTo(0.25, 6);
    expect(result.totalCostUsd).toBeCloseTo(0.75, 6);
  });

  it("calculates zero for zero usage", () => {
    expect(
      computeCost("claude-opus-4-7", { inputTokens: 0, outputTokens: 0 })
    ).toEqual({ inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0 });
  });

  it("throws for an unknown model", () => {
    expect(() =>
      computeCost("claude-imaginary-99", {
        inputTokens: 10,
        outputTokens: 5,
      })
    ).toThrow(/No pricing configured/);
  });
});

describe("formatCost", () => {
  it("formats USD with 4-decimal precision and a leading $", () => {
    expect(formatCost(0.0234)).toBe("$0.0234");
    expect(formatCost(1.5)).toBe("$1.5000");
    expect(formatCost(0)).toBe("$0.0000");
  });
});
