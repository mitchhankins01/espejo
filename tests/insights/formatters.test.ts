import { describe, it, expect } from "vitest";
import { formatInsightNotification } from "../../src/insights/formatters.js";
import type { InsightCandidate } from "../../src/insights/analyzers.js";

describe("formatInsightNotification", () => {
  it("formats temporal echo with similarity and previews", () => {
    const insight: InsightCandidate = {
      type: "temporal_echo",
      contentHash: "abc123",
      title: "Temporal echo from 2023",
      body: "Felt overwhelmed by work stress...",
      relevance: 0.87,
      metadata: {
        current_uuid: "uuid-today",
        echo_uuid: "uuid-2023",
        echo_year: 2023,
        similarity: 0.87,
        current_preview: "Work pressure is building again...",
      },
    };

    const text = formatInsightNotification(insight);
    expect(text).toContain("<b>Temporal echo from 2023</b>");
    expect(text).toContain("Felt overwhelmed by work stress...");
    expect(text).toContain("Today you wrote:");
    expect(text).toContain("Work pressure is building again...");
    expect(text).toContain("87%");
  });

  it("formats temporal echo without current_preview", () => {
    const insight: InsightCandidate = {
      type: "temporal_echo",
      contentHash: "abc",
      title: "Temporal echo from 2022",
      body: "Some old entry...",
      relevance: 0.80,
      metadata: { echo_year: 2022, similarity: 0.80 },
    };

    const text = formatInsightNotification(insight);
    expect(text).toContain("<b>Temporal echo from 2022</b>");
    expect(text).not.toContain("Today you wrote:");
  });

  it("formats biometric correlation", () => {
    const insight: InsightCandidate = {
      type: "biometric_correlation",
      contentHash: "def456",
      title: "Sleep score is low (55)",
      body: "Couldn't sleep last night...",
      relevance: 0.7,
      metadata: { day: "2026-03-08" },
    };

    const text = formatInsightNotification(insight);
    expect(text).toContain("<b>Sleep score is low (55)</b>");
    expect(text).toContain("Journal entries from around that time:");
    expect(text).toContain("Couldn't sleep last night...");
  });

  it("formats stale todo with next step", () => {
    const insight: InsightCandidate = {
      type: "stale_todo",
      contentHash: "ghi789",
      title: "Stale todo: Fix taxes",
      body: "Next step: Call accountant\nStale for 14 days.",
      relevance: 0.5,
      metadata: { todo_id: "t1", days_stale: 14, important: false, urgent: false },
    };

    const text = formatInsightNotification(insight);
    expect(text).toContain("<b>Stale todo: Fix taxes</b>");
    expect(text).toContain("Next step: Call accountant");
    expect(text).not.toContain("important");
  });

  it("formats stale todo marked important", () => {
    const insight: InsightCandidate = {
      type: "stale_todo",
      contentHash: "jkl012",
      title: "Stale todo: Spanish visa",
      body: "No next step defined. Stale for 21 days.",
      relevance: 0.8,
      metadata: { todo_id: "t2", days_stale: 21, important: true, urgent: false },
    };

    const text = formatInsightNotification(insight);
    expect(text).toContain("This is marked as important.");
    expect(text).toContain("Consider breaking it into a smaller next step");
  });

  it("escapes HTML in body text", () => {
    const insight: InsightCandidate = {
      type: "temporal_echo",
      contentHash: "esc",
      title: "Temporal echo from 2023",
      body: "Used <script>alert('xss')</script> in entry",
      relevance: 0.8,
      metadata: { similarity: 0.8 },
    };

    const text = formatInsightNotification(insight);
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("truncates long body text", () => {
    const longBody = "A".repeat(300);
    const insight: InsightCandidate = {
      type: "temporal_echo",
      contentHash: "trunc",
      title: "Temporal echo from 2023",
      body: longBody,
      relevance: 0.8,
      metadata: { similarity: 0.8 },
    };

    const text = formatInsightNotification(insight);
    expect(text.length).toBeLessThan(longBody.length + 200);
    expect(text).toContain("…");
  });

  it("formats oura_notable negative insight", () => {
    const insight: InsightCandidate = {
      type: "oura_notable",
      contentHash: "oura1",
      title: "Sleep score drop: 42",
      body: "Baseline: 78 ± 5",
      relevance: 0.9,
      metadata: { pattern: "outlier", metric: "sleep_score", positive: false },
    };

    const text = formatInsightNotification(insight);
    expect(text).toContain("📉");
    expect(text).toContain("<b>Sleep score drop: 42</b>");
    expect(text).toContain("Baseline: 78 ± 5");
  });

  it("formats oura_notable positive insight", () => {
    const insight: InsightCandidate = {
      type: "oura_notable",
      contentHash: "oura2",
      title: "HRV spike: 120 ms",
      body: "Baseline: 67 ± 26 ms",
      relevance: 0.8,
      metadata: { pattern: "outlier", metric: "hrv", positive: true },
    };

    const text = formatInsightNotification(insight);
    expect(text).toContain("📈");
    expect(text).toContain("<b>HRV spike: 120 ms</b>");
  });
});
