import { describe, it, expect } from "vitest";
import { classifyVocabState } from "../../src/db/queries/vocab-reviews.js";

describe("classifyVocabState", () => {
  const NOW = new Date("2026-05-14T00:00:00Z");

  it("returns null for undefined state", () => {
    expect(classifyVocabState(undefined, NOW)).toBeNull();
  });

  it("returns stalling for state='learning'", () => {
    expect(
      classifyVocabState(
        {
          stem: "x",
          state: "learning",
          lapses: 0,
          stability: 0,
          last_review: NOW,
        },
        NOW
      )
    ).toEqual({ tag: "stalling", detail: "lapses=0" });
  });

  it("returns stalling for state='relearning'", () => {
    expect(
      classifyVocabState(
        {
          stem: "x",
          state: "relearning",
          lapses: 3,
          stability: 0,
          last_review: NOW,
        },
        NOW
      )
    ).toEqual({ tag: "stalling", detail: "lapses=3" });
  });

  it("returns stalling for review with ≥2 recent lapses", () => {
    const lastReview = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
    expect(
      classifyVocabState(
        {
          stem: "x",
          state: "review",
          lapses: 2,
          stability: 5,
          last_review: lastReview,
        },
        NOW
      )
    ).toEqual({ tag: "stalling", detail: "lapses=2" });
  });

  it("does NOT stall when last review is older than 30d (lapses age out)", () => {
    const oldReview = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
    expect(
      classifyVocabState(
        {
          stem: "x",
          state: "review",
          lapses: 5,
          stability: 5,
          last_review: oldReview,
        },
        NOW
      )
    ).toBeNull();
  });

  it("returns mastered for review with stability ≥ 30d", () => {
    expect(
      classifyVocabState(
        {
          stem: "x",
          state: "review",
          lapses: 0,
          stability: 30,
          last_review: NOW,
        },
        NOW
      )
    ).toEqual({ tag: "mastered", detail: "stable" });
  });

  it("returns null for review with low lapses + low stability", () => {
    expect(
      classifyVocabState(
        {
          stem: "x",
          state: "review",
          lapses: 1,
          stability: 5,
          last_review: NOW,
        },
        NOW
      )
    ).toBeNull();
  });

  it("returns null for new card with no review history", () => {
    expect(
      classifyVocabState(
        {
          stem: "x",
          state: "new",
          lapses: 0,
          stability: 0,
          last_review: null,
        },
        NOW
      )
    ).toBeNull();
  });

  it("returns null when lapses≥2 but last_review is null", () => {
    expect(
      classifyVocabState(
        {
          stem: "x",
          state: "review",
          lapses: 3,
          stability: 5,
          last_review: null,
        },
        NOW
      )
    ).toBeNull();
  });
});
