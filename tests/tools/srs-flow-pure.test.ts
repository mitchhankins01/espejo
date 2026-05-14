import { describe, it, expect, vi } from "vitest";

// Stub config + db before importing the flow — the flow only pulls these
// transitively for tools we don't call in pure tests.
vi.mock("../../src/config.js", () => ({
  config: {
    timezone: "Europe/Madrid",
    anthropic: { apiKey: "sk-test" },
    telegram: { botToken: "x" },
    models: { anthropicFast: "claude-haiku-4-5-20251001" },
  },
}));
vi.mock("../../src/db/client.js", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

import {
  parseSrsArgs,
  formatInterval,
  renderRatedSummary,
} from "../../src/telegram/flows/srs.js";
import type { VocabReviewRow } from "../../src/db/queries/vocab-reviews.js";

describe("parseSrsArgs", () => {
  it("returns undefined newCap for empty input", () => {
    expect(parseSrsArgs("")).toEqual({ newCap: undefined });
    expect(parseSrsArgs("   ")).toEqual({ newCap: undefined });
  });

  it("parses a valid integer in range", () => {
    expect(parseSrsArgs("30")).toEqual({ newCap: 30 });
    expect(parseSrsArgs("  5  ")).toEqual({ newCap: 5 });
    expect(parseSrsArgs("1")).toEqual({ newCap: 1 });
    expect(parseSrsArgs("100")).toEqual({ newCap: 100 });
  });

  it("rejects out-of-range integers", () => {
    const a = parseSrsArgs("0");
    const b = parseSrsArgs("101");
    expect("error" in a && a.error).toMatch(/Usage/);
    expect("error" in b && b.error).toMatch(/Usage/);
  });

  it("rejects non-integers and garbage", () => {
    expect("error" in parseSrsArgs("foo")).toBe(true);
    expect("error" in parseSrsArgs("5.5")).toBe(true);
    expect("error" in parseSrsArgs("-3")).toBe(true);
  });
});

describe("formatInterval", () => {
  const NOW = new Date("2026-05-14T12:00:00Z");

  it("<1m for due in the past or now", () => {
    expect(formatInterval(new Date(NOW.getTime() - 60_000), NOW)).toBe("<1m");
    expect(formatInterval(NOW, NOW)).toBe("<1m");
    expect(formatInterval(new Date(NOW.getTime() + 30_000), NOW)).toBe("<1m");
  });

  it("minutes for sub-hour intervals", () => {
    expect(formatInterval(new Date(NOW.getTime() + 60_000), NOW)).toBe("1m");
    expect(formatInterval(new Date(NOW.getTime() + 10 * 60_000), NOW)).toBe("10m");
    expect(formatInterval(new Date(NOW.getTime() + 59 * 60_000), NOW)).toBe("59m");
  });

  it("hours for sub-day intervals", () => {
    expect(formatInterval(new Date(NOW.getTime() + 60 * 60_000), NOW)).toBe("1h");
    expect(formatInterval(new Date(NOW.getTime() + 5 * 60 * 60_000), NOW)).toBe(
      "5h"
    );
  });

  it("days for sub-month intervals", () => {
    expect(
      formatInterval(new Date(NOW.getTime() + 24 * 60 * 60_000), NOW)
    ).toBe("1d");
    expect(
      formatInterval(new Date(NOW.getTime() + 10 * 24 * 60 * 60_000), NOW)
    ).toBe("10d");
  });

  it("months for sub-year intervals", () => {
    expect(
      formatInterval(new Date(NOW.getTime() + 60 * 24 * 60 * 60_000), NOW)
    ).toBe("2mo");
  });

  it("years for ≥1y", () => {
    expect(
      formatInterval(new Date(NOW.getTime() + 400 * 24 * 60 * 60_000), NOW)
    ).toBe("1y");
  });
});

describe("renderRatedSummary", () => {
  const NOW = new Date("2026-05-14T12:00:00Z");
  const ROW = { id: "1", stem: "peldaño" } as VocabReviewRow;

  it("renders the rating label and interval", () => {
    const summary = renderRatedSummary(
      ROW,
      3,
      new Date(NOW.getTime() + 10 * 60_000),
      NOW
    );
    expect(summary).toBe("✓ peldaño (good) → next in 10m");
  });

  it("escapes HTML in the stem", () => {
    const row = { ...ROW, stem: "<script>" };
    const summary = renderRatedSummary(
      row,
      1,
      new Date(NOW.getTime() + 60_000),
      NOW
    );
    expect(summary).toBe("✓ &lt;script&gt; (again) → next in 1m");
  });
});
