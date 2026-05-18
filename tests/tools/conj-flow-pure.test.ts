import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    timezone: "Europe/Madrid",
    anthropic: { apiKey: "sk-test" },
    telegram: { botToken: "x" },
    models: { anthropicFast: "claude-haiku-4-5-20251001" },
  },
}));
vi.mock("../../src/db/client.js", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

import {
  parseConjArgs,
  formatInterval,
  maskForm,
  renderCardFront,
  renderCardRevealed,
  renderResult,
  renderSessionSummary,
  highlightAnswer,
} from "../../src/telegram/flows/conj.js";
import type { ConjFlowState } from "../../src/telegram/flow-state.js";

describe("parseConjArgs", () => {
  it("returns undefined for empty input", () => {
    expect(parseConjArgs("")).toEqual({ newCap: undefined });
    expect(parseConjArgs("  ")).toEqual({ newCap: undefined });
  });

  it("parses valid integers in range", () => {
    expect(parseConjArgs("30")).toEqual({ newCap: 30 });
    expect(parseConjArgs("1")).toEqual({ newCap: 1 });
    expect(parseConjArgs("100")).toEqual({ newCap: 100 });
  });

  it("rejects out-of-range integers", () => {
    expect("error" in parseConjArgs("0")).toBe(true);
    expect("error" in parseConjArgs("101")).toBe(true);
  });

  it("rejects non-integers and garbage", () => {
    expect("error" in parseConjArgs("foo")).toBe(true);
    expect("error" in parseConjArgs("5.5")).toBe(true);
    expect("error" in parseConjArgs("-3")).toBe(true);
  });
});

describe("formatInterval", () => {
  const NOW = new Date("2026-05-15T12:00:00Z");

  it("1m for due in the past or sub-minute (never returns a leading `<`)", () => {
    // Returning "<1m" would poison Telegram's HTML parser and strip every
    // <b>/<i> in the message. The minimum interval label is "1m".
    expect(formatInterval(new Date(NOW.getTime() - 1000), NOW)).toBe("1m");
    expect(formatInterval(NOW, NOW)).toBe("1m");
  });

  it("returns minute / hour / day labels", () => {
    expect(formatInterval(new Date(NOW.getTime() + 60_000), NOW)).toBe("1m");
    expect(formatInterval(new Date(NOW.getTime() + 60 * 60_000), NOW)).toBe("1h");
    expect(formatInterval(new Date(NOW.getTime() + 24 * 60 * 60_000), NOW)).toBe("1d");
  });

  it("month / year labels", () => {
    expect(
      formatInterval(new Date(NOW.getTime() + 60 * 24 * 60 * 60_000), NOW)
    ).toBe("2mo");
    expect(
      formatInterval(new Date(NOW.getTime() + 400 * 24 * 60 * 60_000), NOW)
    ).toBe("1y");
  });
});

describe("maskForm", () => {
  it("replaces a simple form with ___", () => {
    expect(maskForm("Cuando era joven, viajé.", "era")).toBe(
      "Cuando ___ joven, viajé."
    );
  });

  it("case-insensitive replace", () => {
    expect(maskForm("Era joven y feliz.", "era")).toBe("___ joven y feliz.");
  });

  it("multi-word compound form replace", () => {
    expect(maskForm("Yo he comido hoy.", "he comido")).toBe("Yo ___ hoy.");
  });

  it("imperative_negative strips leading no and renders 'no ___'", () => {
    expect(
      maskForm("No hables tan rápido.", "hables", "imperative_negative")
    ).toBe("no ___ tan rápido.");
  });

  it("returns null when the form has no word-bounded match (no substring fallback)", () => {
    // form 'es' must NOT mask inside 'request' — regression for the
    // `requ___t` bug.
    expect(
      maskForm("A proportional request: 5 seconds.", "es")
    ).toBeNull();
    // 'era' must NOT mask inside 'verdadera'.
    expect(maskForm("Una pregunta verdadera me molesta.", "era")).toBeNull();
  });

  it("accent-adjacent word boundaries still mask", () => {
    expect(maskForm("¿Cómo estás hoy?", "estás")).toBe("¿Cómo ___ hoy?");
  });
});

describe("renderCardFront", () => {
  it("first card: header + command bar BEFORE cloze; no 'Escribe la respuesta' prefix", () => {
    const front = renderCardFront(
      { id: "42", lemma: "ser", tense: "imperfect", person: "yo", expected_form: "era" },
      "Cuando era joven, viajé.",
      ["imperfect_irregular"],
      0,
      12
    );
    expect(front.text).toContain("12 cartas");
    expect(front.text).toContain("___");
    expect(front.text).toContain("ser");
    expect(front.text).toContain("imperfecto");
    // New layout: command bar at top, no "Escribe la respuesta" stub.
    expect(front.text).toContain("/hint · /easy · /done");
    expect(front.text).not.toContain("Escribe la respuesta");
    // Order: header line, command bar, blank line, cloze, identity tag.
    const headerIdx = front.text.indexOf("Hoy:");
    const commandsIdx = front.text.indexOf("/hint");
    const clozeIdx = front.text.indexOf("___");
    expect(headerIdx).toBeLessThan(commandsIdx);
    expect(commandsIdx).toBeLessThan(clozeIdx);
  });

  it("subsequent cards: strip header AND command bar", () => {
    const front = renderCardFront(
      { id: "42", lemma: "ser", tense: "imperfect", person: "yo", expected_form: "era" },
      "Cuando era joven.",
      ["imperfect_irregular"],
      1,
      12
    );
    expect(front.text).not.toContain("cartas");
    expect(front.text).not.toContain("/hint");
    expect(front.text).not.toContain("/done");
    expect(front.text).not.toContain("Escribe la respuesta");
  });

  it("attaches a Show inline-keyboard button when a gloss is available", () => {
    const front = renderCardFront(
      { id: "42", lemma: "ser", tense: "present_indicative", person: "nosotros", expected_form: "somos" },
      "Somos amigos desde hace muchos años.",
      ["present_irregular"],
      0,
      20,
      true
    );
    expect(front.replyMarkup).toBeDefined();
    const kb = front.replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(kb.inline_keyboard[0][0].text).toBe("Show");
    expect(kb.inline_keyboard[0][0].callback_data).toBe("conj:show:42");
  });

  it("does NOT attach the Show button when no gloss exists", () => {
    const front = renderCardFront(
      { id: "42", lemma: "ser", tense: "present_indicative", person: "nosotros", expected_form: "somos" },
      "Somos amigos.",
      ["present_irregular"],
      0,
      20,
      false
    );
    expect(front.replyMarkup).toBeUndefined();
  });

  it("does NOT attach the Show button when row.id is missing (defensive)", () => {
    const front = renderCardFront(
      { lemma: "ser", tense: "present_indicative", person: "nosotros", expected_form: "somos" },
      "Somos amigos.",
      ["present_irregular"],
      0,
      20,
      true
    );
    expect(front.replyMarkup).toBeUndefined();
  });

  it("non-haber present_indicative shows 'presente'", () => {
    const front = renderCardFront(
      {
        id: "1",
        lemma: "ser",
        tense: "present_indicative",
        person: "yo",
        expected_form: "soy",
      },
      "Yo soy profesor de español.",
      ["present_irregular"],
      0,
      20
    );
    expect(front.text).toContain("presente");
  });

  it("present_perfect cell labels as 'pretérito perfecto' naturally (compound tense, no remap needed)", () => {
    // After suspending haber-aux cells, haber forms only appear inside
    // compound tense buckets — those tenses' own labels are already
    // honest: present_perfect → pretérito perfecto.
    const front = renderCardFront(
      {
        id: "1",
        lemma: "comer",
        tense: "present_perfect",
        person: "nosotros",
        expected_form: "hemos comido",
      },
      "Hemos comido en casa esta tarde.",
      "present_perfect",
      0,
      20
    );
    expect(front.text).toContain("pretérito perfecto");
  });
});

describe("renderCardRevealed (Show button result)", () => {
  it("appends the gloss with a 🇬🇧 flag below the cloze + identity", () => {
    const out = renderCardRevealed(
      { lemma: "ser", tense: "present_indicative", person: "nosotros", expected_form: "somos" },
      "Somos amigos desde hace muchos años.",
      "We've been friends for many years."
    );
    expect(out).toContain("___");
    expect(out).toContain("ser · nosotros · presente");
    expect(out).toContain("🇬🇧 We've been friends for many years.");
  });

  it("HTML-escapes the gloss to keep user-supplied translation safe", () => {
    const out = renderCardRevealed(
      { lemma: "ser", tense: "present_indicative", person: "yo", expected_form: "soy" },
      "Soy <script>.",
      "I am <script>."
    );
    expect(out).toContain("I am &lt;script&gt;.");
  });
});

describe("renderResult", () => {
  const NOW = new Date("2026-05-15T12:00:00Z");
  const DUE_4D = new Date(NOW.getTime() + 4 * 24 * 60 * 60_000);

  it("exact renders ✓", () => {
    expect(renderResult("exact", "era", "Cuando era joven.", DUE_4D, NOW)).toContain("✓");
  });

  it("easy renders ⏭", () => {
    expect(renderResult("easy", "era", "Cuando era joven.", DUE_4D, NOW)).toContain("⏭");
  });

  it("wrong renders ✗ with the answer bolded in-context (case preserved)", () => {
    const out = renderResult(
      "wrong",
      "somos",
      "Somos amigos desde hace muchos años.",
      DUE_4D,
      NOW
    );
    expect(out).toContain("✗");
    // Answer should be bolded inline, preserving the original capitalization.
    expect(out).toContain("<b>Somos</b> amigos desde hace muchos años.");
  });

  it("hint_correct labels as hint→hard", () => {
    const out = renderResult("hint_correct", "tuve", "", DUE_4D, NOW);
    expect(out).toContain("hint → hard");
  });

  it("hint_easy labels as hint+easy → hard", () => {
    const out = renderResult("hint_easy", "tuve", "", DUE_4D, NOW);
    expect(out).toContain("hint+easy");
  });

  it("hint_wrong includes hint→again with bolded inline answer", () => {
    const out = renderResult(
      "hint_wrong",
      "tuve",
      "Cuando tuve el perro, era niño.",
      DUE_4D,
      NOW
    );
    expect(out).toContain("hint");
    expect(out).toContain("again");
    expect(out).toContain("Cuando <b>tuve</b> el perro");
  });

  it("result render is gloss-free — gloss now lives on the card via the Show button", () => {
    // Regression: previously renderResult prepended `<i>{gloss}</i>` to every
    // reveal, which pushed the next card down by a line every time.
    const out = renderResult(
      "exact",
      "somos",
      "Somos amigos desde hace muchos años.",
      DUE_4D,
      NOW
    );
    expect(out).not.toContain("<i>");
    expect(out).toBe("✓ somos (good) → next in 4d");
  });
});

describe("highlightAnswer", () => {
  it("bolds the word-bounded match preserving case", () => {
    expect(
      highlightAnswer("Somos amigos desde hace años.", "somos")
    ).toBe("<b>Somos</b> amigos desde hace años.");
  });

  it("matches mid-sentence", () => {
    expect(
      highlightAnswer("Cuando tuve el perro, era niño.", "tuve")
    ).toBe("Cuando <b>tuve</b> el perro, era niño.");
  });

  it("HTML-escapes surrounding text but not the bold tags", () => {
    expect(
      highlightAnswer("<script>tuve</script>", "tuve")
    ).toContain("<b>tuve</b>");
  });

  it("falls back to plain escape when form is not found", () => {
    expect(highlightAnswer("Nothing here.", "xyz")).toBe("Nothing here.");
  });

  it("word-bounded — 'era' does not match inside 'verdadera'", () => {
    expect(highlightAnswer("Una verdadera pena.", "era")).toBe(
      "Una verdadera pena."
    );
  });
});

describe("renderSessionSummary", () => {
  it("groups grade kinds (exact+hint_correct → ✓ etc)", () => {
    const state: ConjFlowState = {
      flow: "conj",
      sessionId: "s",
      startedAt: 0,
      patterns: ["preterite_strong"],
      queue: [],
      queueIndex: 12,
      reviewedCount: 12,
      countsByGradeKind: {
        exact: 7,
        wrong: 2,
        easy: 1,
        hint_correct: 1,
        hint_wrong: 1,
        hint_easy: 0,
      },
      hintCount: 2,
      currentCardId: null,
      currentExpected: null,
      currentTense: null,
      currentPattern: null,
      currentPerson: null,
      currentLemma: null,
      currentSentence: null,
      currentGloss: null,
      currentClozeSource: null,
      hintUsed: false,
    };
    const summary = renderSessionSummary(
      "Listo",
      ["preterite_strong"],
      state,
      { due: 10, stalling: 3, unpromoted: 100 }
    );
    expect(summary).toContain("Listo");
    expect(summary).toContain("8 ✓"); // 7 exact + 1 hint_correct
    expect(summary).toContain("1 ⏭"); // 1 easy + 0 hint_easy
    expect(summary).toContain("3 ✗"); // 2 wrong + 1 hint_wrong
    expect(summary).toContain("2 con pista");
    expect(summary).toContain("10 pendientes");
    expect(summary).toContain("3 atascadas");
    expect(summary).toContain("100 celdas sin promover");
  });
});
