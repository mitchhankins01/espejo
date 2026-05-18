import { describe, it, expect } from "vitest";
import { emptyCard, nextState } from "../../src/fsrs/scheduler.js";

describe("fsrs scheduler", () => {
  const NOW = new Date("2026-05-14T12:00:00Z");

  it("emptyCard returns state='new' with no last_review", () => {
    const card = emptyCard(NOW);
    expect(card.state).toBe("new");
    expect(card.last_review).toBeNull();
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
  });

  it("rating Good (3) advances a new card forward with a future due date", () => {
    const card = emptyCard(NOW);
    const next = nextState(card, 3, NOW);
    expect(next.state_before).toBe("new");
    expect(next.state === "learning" || next.state === "review").toBe(true);
    expect(next.due.getTime()).toBeGreaterThan(NOW.getTime());
    expect(next.stability_before).toBe(0);
    expect(next.stability).toBeGreaterThan(0);
  });

  it("rating Again (1) on a learned card increments lapses", () => {
    const card = emptyCard(NOW);
    const learned = nextState(card, 3, NOW);
    // Push the card forward to "review" first via another Good.
    const later = new Date(learned.due.getTime() + 60_000);
    const reviewing = nextState(
      {
        due: learned.due,
        stability: learned.stability,
        difficulty: learned.difficulty,
        elapsed_days: learned.elapsed_days,
        scheduled_days: learned.scheduled_days,
        reps: learned.reps,
        lapses: learned.lapses,
        state: learned.state,
        last_review: learned.last_review,
      },
      4,
      later
    );
    const lapseTime = new Date(reviewing.due.getTime() + 24 * 60 * 60 * 1000);
    const lapsed = nextState(
      {
        due: reviewing.due,
        stability: reviewing.stability,
        difficulty: reviewing.difficulty,
        elapsed_days: reviewing.elapsed_days,
        scheduled_days: reviewing.scheduled_days,
        reps: reviewing.reps,
        lapses: reviewing.lapses,
        state: reviewing.state,
        last_review: reviewing.last_review,
      },
      1,
      lapseTime
    );
    expect(lapsed.lapses).toBeGreaterThan(reviewing.lapses);
  });

  it("is deterministic for a fixed now+grade+card", () => {
    const card = emptyCard(NOW);
    const a = nextState(card, 3, NOW);
    const b = nextState(card, 3, NOW);
    expect(a.due.getTime()).toBe(b.due.getTime());
    expect(a.stability).toBe(b.stability);
    expect(a.state).toBe(b.state);
  });

  it("defaults `now` to current time when omitted", () => {
    const card = emptyCard();
    const before = Date.now();
    const next = nextState(card, 3);
    const after = Date.now();
    expect(next.due.getTime()).toBeGreaterThan(before - 1000);
    expect(next.due.getTime()).toBeGreaterThan(after - 1000);
  });

  it("learning_steps round-trips so cards graduate out of learning (regression: 2026-05-18 stuck-in-learning bug)", () => {
    // With default ts-fsrs config (learning_steps=['1m','10m'], short_term=true),
    // a Good rating on a new card advances learning_steps 0→1 and stays in
    // learning. The second Good (with learning_steps=1 persisted) should
    // graduate to 'review'. The bug was that scheduler.ts hard-coded
    // learning_steps=0 in toFsrsCard, so every reload reset the counter,
    // trapping cards in `learning` forever with +10m intervals.
    const card = emptyCard(NOW);
    expect(card.learning_steps).toBe(0);

    const step1 = nextState(card, 3, NOW);
    expect(step1.state).toBe("learning");
    expect(step1.learning_steps).toBeGreaterThan(0);

    const t2 = new Date(step1.due.getTime() + 1000);
    const step2 = nextState(
      {
        due: step1.due,
        stability: step1.stability,
        difficulty: step1.difficulty,
        elapsed_days: step1.elapsed_days,
        scheduled_days: step1.scheduled_days,
        reps: step1.reps,
        lapses: step1.lapses,
        state: step1.state,
        last_review: step1.last_review,
        learning_steps: step1.learning_steps,
      },
      3,
      t2
    );
    expect(step2.state).toBe("review");
  });
});
