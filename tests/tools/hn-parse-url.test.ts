import { describe, it, expect } from "vitest";
import { parseHnUrl } from "../../src/hn/parse-url.js";

describe("parseHnUrl", () => {
  it("parses a canonical https HN item URL", () => {
    expect(parseHnUrl("https://news.ycombinator.com/item?id=47892019")).toEqual({
      itemId: 47892019,
      hnUrl: "https://news.ycombinator.com/item?id=47892019",
    });
  });

  it("parses an http URL", () => {
    expect(parseHnUrl("http://news.ycombinator.com/item?id=42")).toEqual({
      itemId: 42,
      hnUrl: "https://news.ycombinator.com/item?id=42",
    });
  });

  it("accepts a www. subdomain", () => {
    expect(
      parseHnUrl("https://www.news.ycombinator.com/item?id=99").itemId
    ).toBe(99);
  });

  it("accepts a bare numeric id", () => {
    expect(parseHnUrl("12345")).toEqual({
      itemId: 12345,
      hnUrl: "https://news.ycombinator.com/item?id=12345",
    });
  });

  it("trims whitespace", () => {
    expect(parseHnUrl("  47892019\n").itemId).toBe(47892019);
  });

  it("handles extra query params alongside id", () => {
    expect(
      parseHnUrl("https://news.ycombinator.com/item?id=10&p=2").itemId
    ).toBe(10);
  });

  it("rejects an empty string", () => {
    expect(() => parseHnUrl("")).toThrow(/Empty input/);
    expect(() => parseHnUrl("   ")).toThrow(/Empty input/);
  });

  it("rejects a non-HN URL", () => {
    expect(() =>
      parseHnUrl("https://example.com/item?id=42")
    ).toThrow(/Not a Hacker News URL/);
  });

  it("rejects an HN URL missing the id parameter", () => {
    expect(() =>
      parseHnUrl("https://news.ycombinator.com/news")
    ).toThrow(/missing the id parameter/);
  });
});
