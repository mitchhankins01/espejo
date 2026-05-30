import { describe, it, expect } from "vitest";
import {
  KEYBOARD_LABELS,
  DEFAULT_KEYBOARD,
  END_KEYBOARD,
  ACTIVE_THREAD_KEYBOARD,
  resolveButtonLabel,
} from "../../src/telegram/keyboard.js";

describe("telegram keyboard", () => {
  it("resolves each exact label to its command", () => {
    expect(resolveButtonLabel("Checkpoint")).toBe("checkpoint");
    expect(resolveButtonLabel("SRS")).toBe("srs");
    expect(resolveButtonLabel("Conj")).toBe("conj");
    // End is not in the idle layout but still resolves — a tap ends the flow.
    expect(resolveButtonLabel("End")).toBe("done");
  });

  it("keeps End out of the idle layout", () => {
    expect(KEYBOARD_LABELS).toEqual(["Checkpoint", "SRS", "Conj"]);
    expect(KEYBOARD_LABELS).not.toContain("End");
  });

  it("End keyboard is a single button mapping to /done", () => {
    expect(END_KEYBOARD.keyboard).toEqual([[{ text: "End" }]]);
    expect(END_KEYBOARD.is_persistent).toBe(true);
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

  it("active-thread keyboard is the End button plus a ≤64-char hint", () => {
    // Default/End carry no placeholder so /done can clear the hint.
    expect(DEFAULT_KEYBOARD.input_field_placeholder).toBeUndefined();
    expect(END_KEYBOARD.input_field_placeholder).toBeUndefined();
    const hint = ACTIVE_THREAD_KEYBOARD.input_field_placeholder as string;
    expect(hint).toBeTruthy();
    expect(hint.length).toBeLessThanOrEqual(64);
    // Same single-End layout as END_KEYBOARD, just with the hint added.
    expect(ACTIVE_THREAD_KEYBOARD.keyboard).toEqual(END_KEYBOARD.keyboard);
  });
});
