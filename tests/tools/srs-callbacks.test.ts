import { describe, it, expect } from "vitest";
import {
  parseSrsCallback,
  buildShowPayload,
  buildRatePayload,
} from "../../src/telegram/srs-callbacks.js";

describe("parseSrsCallback", () => {
  it("parses srs:show:<id>", () => {
    expect(parseSrsCallback("srs:show:42")).toEqual({
      kind: "show",
      reviewId: "42",
    });
  });
  it("parses srs:rate:<id>:<rating> for all valid grades", () => {
    for (const g of [1, 2, 3, 4] as const) {
      expect(parseSrsCallback(`srs:rate:42:${g}`)).toEqual({
        kind: "rate",
        reviewId: "42",
        rating: g,
      });
    }
  });
  it("rejects unknown kinds", () => {
    expect(parseSrsCallback("srs:flag:42")).toBeNull();
  });
  it("rejects malformed payloads", () => {
    expect(parseSrsCallback("not-srs")).toBeNull();
    expect(parseSrsCallback("srs:")).toBeNull();
    expect(parseSrsCallback("srs:show")).toBeNull();
    expect(parseSrsCallback("")).toBeNull();
  });
  it("rejects missing rating", () => {
    expect(parseSrsCallback("srs:rate:42")).toBeNull();
  });
  it("rejects rating out of range", () => {
    expect(parseSrsCallback("srs:rate:42:0")).toBeNull();
    expect(parseSrsCallback("srs:rate:42:5")).toBeNull();
    expect(parseSrsCallback("srs:rate:42:x")).toBeNull();
  });
  it("rejects non-numeric review id", () => {
    expect(parseSrsCallback("srs:show:abc")).toBeNull();
    expect(parseSrsCallback("srs:show:")).toBeNull();
  });
  it("rejects extra trailing parts", () => {
    expect(parseSrsCallback("srs:show:42:foo")).toBeNull();
    expect(parseSrsCallback("srs:rate:42:3:foo")).toBeNull();
  });
});

describe("buildShowPayload / buildRatePayload", () => {
  it("round-trips with the parser", () => {
    expect(parseSrsCallback(buildShowPayload("99"))).toEqual({
      kind: "show",
      reviewId: "99",
    });
    expect(parseSrsCallback(buildRatePayload("99", 3))).toEqual({
      kind: "rate",
      reviewId: "99",
      rating: 3,
    });
  });
});
