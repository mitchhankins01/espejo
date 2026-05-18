// Thin wrapper around ts-fsrs. Single replacement target if the library majors.
//
// We persist Card fields verbatim in `vocab_reviews`, so our boundary types
// mirror the library's `Card` shape (Date / number / enum strings).

import {
  Rating,
  State,
  createEmptyCard,
  fsrs,
  type Card as FsrsCard,
  type Grade as FsrsGrade,
} from "ts-fsrs";

export type CardStateName = "new" | "learning" | "review" | "relearning";
export type Grade = 1 | 2 | 3 | 4;

export interface CardState {
  due: Date;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: CardStateName;
  last_review: Date | null;
  // ts-fsrs short-term step index. 0/1 while the card walks through the
  // configured learning_steps (default ['1m','10m']); reset to 0 when the card
  // graduates to 'review'. Must persist or the card never graduates — Good at
  // step 0 advances to step 1 in memory; if we drop it on save and reload as 0,
  // the card is forever stuck in the +10m short-term loop.
  learning_steps: number;
}

export interface NextCardState extends CardState {
  state_before: CardStateName;
  stability_before: number;
  difficulty_before: number;
}

const SCHEDULER = fsrs();

const STATE_TO_NAME: Record<number, CardStateName> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

const NAME_TO_STATE: Record<CardStateName, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

function toFsrsCard(input: CardState): FsrsCard {
  return {
    due: input.due,
    stability: input.stability,
    difficulty: input.difficulty,
    elapsed_days: input.elapsed_days,
    scheduled_days: input.scheduled_days,
    learning_steps: input.learning_steps,
    reps: input.reps,
    lapses: input.lapses,
    state: NAME_TO_STATE[input.state],
    last_review: input.last_review ?? undefined,
  };
}

function fromFsrsCard(card: FsrsCard): CardState {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: STATE_TO_NAME[card.state],
    last_review: card.last_review ?? null,
    learning_steps: card.learning_steps,
  };
}

export function emptyCard(now: Date = new Date()): CardState {
  return fromFsrsCard(createEmptyCard(now));
}

const GRADE_TO_RATING: Record<Grade, FsrsGrade> = {
  1: Rating.Again,
  2: Rating.Hard,
  3: Rating.Good,
  4: Rating.Easy,
};

export function nextState(
  card: CardState,
  rating: Grade,
  now: Date = new Date()
): NextCardState {
  const result = SCHEDULER.next(toFsrsCard(card), now, GRADE_TO_RATING[rating]);
  const after = fromFsrsCard(result.card);
  return {
    ...after,
    state_before: card.state,
    stability_before: card.stability,
    difficulty_before: card.difficulty,
  };
}
