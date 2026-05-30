import { describe, it, expect } from "vitest";
import {
  KEYBOARD_LABELS,
  DEFAULT_KEYBOARD,
  ACTIVE_THREAD_KEYBOARD,
  resolveButtonLabel,
} from "../../src/telegram/keyboard.js";

describe("telegram keyboard", () => {
  it("resolves each exact label to its command", () => {
    expect(resolveButtonLabel("Checkpoint")).toBe("checkpoint");
    expect(resolveButtonLabel("SRS")).toBe("srs");
    expect(resolveButtonLabel("Conj")).toBe("conj");
  });

  it("tolerates surrounding whitespace from the client", () => {
    expect(resolveButtonLabel("  Checkpoint  ")).toBe("checkpoint");
  });

  it("returns null for natural text, case-sensitively disjoint from taps", () => {
    // Match is exact + case-sensitive: lowercase prose never resolves, so a
    // tap (capitalized label) stays disjoint from how these words appear in
    // natural text or Whisper transcription.
    expect(resolveButtonLabel("checkpoint")).toBeNull();
    expect(resolveButtonLabel("let's do an srs round")).toBeNull();
    expect(resolveButtonLabel("conj")).toBeNull();
    expect(resolveButtonLabel("")).toBeNull();
  });

  it("exposes a single compact row matching the labels", () => {
    expect(DEFAULT_KEYBOARD.is_persistent).toBe(true);
    expect(DEFAULT_KEYBOARD.resize_keyboard).toBe(true);
    expect(DEFAULT_KEYBOARD.keyboard).toEqual([
      KEYBOARD_LABELS.map((text) => ({ text })),
    ]);
  });

  it("active-thread keyboard adds a compose-box hint and stays ≤64 chars", () => {
    // Default carries no placeholder so /done can clear the hint.
    expect(DEFAULT_KEYBOARD.input_field_placeholder).toBeUndefined();
    const hint = ACTIVE_THREAD_KEYBOARD.input_field_placeholder as string;
    expect(hint).toBeTruthy();
    expect(hint.length).toBeLessThanOrEqual(64);
    expect(ACTIVE_THREAD_KEYBOARD.keyboard).toEqual(DEFAULT_KEYBOARD.keyboard);
  });
});
