import { describe, it, expect } from "vitest";
import { composeEmail } from "../../src/hn/email.js";

const baseInput = {
  title: "Why Postgres is great",
  markdown: "## Headline facts\n\nPostgres is good.\n\n## The actual signal\n\n1. It works.\n",
  hnUrl: "https://news.ycombinator.com/item?id=12345",
  articleUrl: "https://example.com/postgres-is-great",
  model: "claude-opus-4-7",
  usage: { inputTokens: 12345, outputTokens: 678 },
  cost: { inputCostUsd: 0.06, outputCostUsd: 0.017, totalCostUsd: 0.077 },
};

describe("composeEmail", () => {
  it("subject prefixes 'HN Distill: ' and uses the title", () => {
    const out = composeEmail(baseInput);
    expect(out.subject).toBe("HN Distill: Why Postgres is great");
  });

  it("plain text contains the original markdown verbatim", () => {
    const out = composeEmail(baseInput);
    expect(out.text).toContain("## Headline facts");
    expect(out.text).toContain("1. It works.");
  });

  it("plain text footer lists both URLs and the cost summary", () => {
    const out = composeEmail(baseInput);
    expect(out.text).toContain(`HN thread: ${baseInput.hnUrl}`);
    expect(out.text).toContain(`Original article: ${baseInput.articleUrl}`);
    expect(out.text).toContain("$0.0770");
    expect(out.text).toContain("12345 in / 678 out");
  });

  it("omits 'Original article' when articleUrl is null", () => {
    const out = composeEmail({ ...baseInput, articleUrl: null });
    expect(out.text).not.toContain("Original article");
    expect(out.html).not.toContain("Original article");
  });

  it("HTML body renders headers and the title escaped into the wrapper", () => {
    const out = composeEmail({
      ...baseInput,
      title: "Scripts & <quotes>",
      markdown: "## A header\n\nA paragraph.",
    });
    // Title appears in the H1 with HTML entities escaped
    expect(out.html).toContain("Scripts &amp; &lt;quotes&gt;");
    // Marked rendered the H2
    expect(out.html).toContain("<h2");
    expect(out.html).toContain("A header");
  });

  it("HTML footer contains the cost line with model id", () => {
    const out = composeEmail(baseInput);
    expect(out.html).toContain("$0.0770");
    expect(out.html).toContain("claude-opus-4-7");
  });
});
