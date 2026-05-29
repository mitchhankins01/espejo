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

/** Single source of truth: exact button label → slash command name. */
const BUTTON_TO_COMMAND: Readonly<Record<string, string>> = {
  Checkpoint: "checkpoint",
  SRS: "srs",
  Conj: "conj",
};

/** Ordered button labels (drives both the markup and the invariant test). */
export const KEYBOARD_LABELS: readonly string[] = Object.keys(BUTTON_TO_COMMAND);

/**
 * Resolve a raw incoming message to the command a keyboard tap maps to, or
 * null when the text isn't an exact button label. Exact equality (trim only,
 * no case-folding, emoji included) keeps taps disjoint from typed/spoken text.
 */
export function resolveButtonLabel(text: string): string | null {
  return BUTTON_TO_COMMAND[text.trim()] ?? null;
}

/**
 * The persistent reply keyboard. `is_persistent` keeps it pinned;
 * `resize_keyboard` shrinks it to a single compact row.
 */
export const DEFAULT_KEYBOARD: Record<string, unknown> = {
  keyboard: [KEYBOARD_LABELS.map((label) => ({ text: label }))],
  is_persistent: true,
  resize_keyboard: true,
};
