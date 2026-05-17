import { describe, it, expect } from "vitest";
import {
  parseConjCallback,
  buildConjShowPayload,
} from "../../src/telegram/conj-callbacks.js";

describe("parseConjCallback", () => {
  it("parses conj:show:<id>", () => {
    expect(parseConjCallback("conj:show:42")).toEqual({
      kind: "show",
      reviewId: "42",
    });
  });

  it("rejects unknown prefix", () => {
    expect(parseConjCallback("srs:show:42")).toBeNull();
    expect(parseConjCallback("show:42")).toBeNull();
  });

  it("rejects unknown kind", () => {
    expect(parseConjCallback("conj:hide:42")).toBeNull();
  });

  it("rejects non-numeric reviewId", () => {
    expect(parseConjCallback("conj:show:abc")).toBeNull();
    expect(parseConjCallback("conj:show:")).toBeNull();
  });

  it("rejects malformed parts (wrong length)", () => {
    expect(parseConjCallback("conj:show:42:extra")).toBeNull();
    expect(parseConjCallback("conj:show")).toBeNull();
  });
});

describe("buildConjShowPayload", () => {
  it("round-trips with parseConjCallback", () => {
    const payload = buildConjShowPayload("99");
    const parsed = parseConjCallback(payload);
    expect(parsed).toEqual({ kind: "show", reviewId: "99" });
  });
});
