// In-memory per-chat flow state. Lost on restart by design — orphaned
// follow-ups route back into the chat flow, which asks for clarification.

export type FlowName =
  | "chat"
  | "checkpoint"
  | "srs"
  | "conj";

export interface CheckpointFlowState {
  flow: "checkpoint";
  // One capture step: the flow asks a single combined question, then logs the
  // next message. (Pre-formed `/c trigger. body. want` skips the flow entirely.)
  step: "awaiting_pull";
  data: {
    trigger?: string;
    body_signal?: string;
  };
  startedAt: number;
}

export interface SrsFlowState {
  flow: "srs";
  sessionId: string;
  startedAt: number;
  /** Pre-built queue of review_ids (due first, then up to N new). */
  queue: string[];
  /** Index of the next card to serve. */
  queueIndex: number;
  reviewedCount: number;
  countsByRating: { 1: number; 2: number; 3: number; 4: number };
  lastServedReviewId: string | null;
  lastServedAt: number | null;
}

export interface ConjCountsByGradeKind {
  exact: number;
  wrong: number;
  easy: number;
  hint_correct: number;
  hint_wrong: number;
  hint_easy: number;
}

export interface ConjFlowState {
  flow: "conj";
  sessionId: string;
  startedAt: number;
  /**
   * Ordered unique list of conjugation patterns the queue draws from. A
   * single-pattern session is `[pattern]`; a `/conj 50` session that crosses
   * `present_yo_go → present_irregular → present_stem_eie` lists all three.
   * `patterns[0]` is the lead pattern (drives the kickoff banner).
   */
  patterns: string[];
  queue: string[];
  queueIndex: number;
  reviewedCount: number;
  countsByGradeKind: ConjCountsByGradeKind;
  hintCount: number;
  currentCardId: string | null;
  currentExpected: string | null;
  currentTense: string | null;
  currentPattern: string | null;
  currentPerson: string | null;
  currentLemma: string | null;
  currentSentence: string | null;
  currentGloss: string | null;
  currentClozeSource: "corpus" | "generated" | null;
  hintUsed: boolean;
}

export type FlowState =
  | CheckpointFlowState
  | SrsFlowState
  | ConjFlowState;

const flows = new Map<string, FlowState>();

export function getFlow(chatId: string): FlowState | undefined {
  return flows.get(chatId);
}

export function setFlow(chatId: string, state: FlowState): void {
  flows.set(chatId, state);
}

export function clearFlow(chatId: string): FlowState | undefined {
  const existing = flows.get(chatId);
  flows.delete(chatId);
  return existing;
}

export function isFlowActive(chatId: string, flow: FlowName): boolean {
  return flows.get(chatId)?.flow === flow;
}

/** Visible for testing only. */
export function clearAllFlows(): void {
  flows.clear();
}
