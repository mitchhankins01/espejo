// Persistent Telegram reply keyboard. Removes the iPhone shift-key-for-"/"
// friction on the flows Mitch actually reaches for often (checkpoint, srs,
// conj). A ReplyKeyboardMarkup, once sent, stays pinned on the client across
// subsequent messages until replaced — so it coexists with the per-message
// inline keyboards srs/conj cards use; we don't re-send it on every reply.
//
// Button label → command mapping is an exact, case-sensitive match (trim
// only). A tap sends the literal capitalized label; natural prose and Whisper
// transcription use lowercase ("let's do conj"), so taps stay disjoint from
// typed/spoken text. The only collision is typing one of these words verbatim
// with its exact capitalization — vanishingly rare for "SRS"/"Conj".

/** The single button shown while a flow or chat thread is active; maps to /done. */
const END_LABEL = "End";

/** Single source of truth: exact button label → slash command name. */
const BUTTON_TO_COMMAND: Readonly<Record<string, string>> = {
  Checkpoint: "checkpoint",
  SRS: "srs",
  Conj: "conj",
  [END_LABEL]: "done",
};

/**
 * Ordered labels for the idle (default) layout — the three "start" buttons.
 * `End` is intentionally excluded: it's its own single-button layout, swapped
 * in while something is active.
 */
export const KEYBOARD_LABELS: readonly string[] = ["Checkpoint", "SRS", "Conj"];

/**
 * Resolve a raw incoming message to the command a keyboard tap maps to, or
 * null when the text isn't an exact button label. Exact equality (trim only,
 * no case-folding, emoji included) keeps taps disjoint from typed/spoken text.
 */
export function resolveButtonLabel(text: string): string | null {
  return BUTTON_TO_COMMAND[text.trim()] ?? null;
}

/**
 * The idle reply keyboard (Checkpoint · SRS · Conj) — shown when nothing is
 * active, i.e. when you can *start* something. Sent on every flow/thread end so
 * the bottom row returns to the three start buttons. `is_persistent` keeps it
 * pinned; `resize_keyboard` shrinks it to a single compact row.
 */
export const DEFAULT_KEYBOARD: Record<string, unknown> = {
  keyboard: [KEYBOARD_LABELS.map((label) => ({ text: label }))],
  is_persistent: true,
  resize_keyboard: true,
};

/**
 * The active-state reply keyboard: a single "End" button (a tap maps to /done,
 * which ends whatever flow is active or resets the chat thread). The structured
 * flows send this on start; it's restored to DEFAULT_KEYBOARD on end.
 */
export const END_KEYBOARD: Record<string, unknown> = {
  keyboard: [[{ text: END_LABEL }]],
  is_persistent: true,
  resize_keyboard: true,
};

/**
 * The End keyboard plus a greyed compose-box hint, sent on every free-chat
 * reply. Even days later, on opening the chat, Mitch sees both the reminder
 * that context is still loaded and the End button to clear it. Cleared the
 * moment /done sends DEFAULT_KEYBOARD. `input_field_placeholder` caps at 64.
 */
export const ACTIVE_THREAD_KEYBOARD: Record<string, unknown> = {
  ...END_KEYBOARD,
  input_field_placeholder: "Active thread — tap End to reset",
};
