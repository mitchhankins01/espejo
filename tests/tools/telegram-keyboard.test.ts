import { describe, it, expect } from "vitest";
import {
  KEYBOARD_LABELS,
  DEFAULT_KEYBOARD,
  resolveButtonLabel,
} from "../../src/telegram/keyboard.js";

describe("telegram keyboard", () => {
  it("every button label starts with an emoji", () => {
    // The emoji prefix is the safety property: it makes a tap impossible to
    // confuse with typed or Whisper-transcribed text. Enforce it, don't trust
    // convention. \p{Extended_Pictographic} covers the emoji we use.
    for (const label of KEYBOARD_LABELS) {
      expect(label, `label "${label}" must start with an emoji`).toMatch(
        /^\p{Extended_Pictographic}/u
      );
    }
  });

  it("resolves each exact label to its command", () => {
    expect(resolveButtonLabel("🎯 Checkpoint")).toBe("checkpoint");
    expect(resolveButtonLabel("🧠 SRS")).toBe("srs");
    expect(resolveButtonLabel("🔤 Conj")).toBe("conj");
  });

  it("tolerates surrounding whitespace from the client", () => {
    expect(resolveButtonLabel("  🎯 Checkpoint  ")).toBe("checkpoint");
  });

  it("returns null for natural text that merely contains a command word", () => {
    // No emoji prefix → not a tap. This is the disjointness the design relies on.
    expect(resolveButtonLabel("checkpoint")).toBeNull();
    expect(resolveButtonLabel("Checkpoint")).toBeNull();
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
});
