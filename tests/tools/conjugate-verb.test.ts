import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getVerbConjugations: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);

import { handleConjugateVerb } from "../../src/tools/conjugate-verb.js";

const mockPool = {} as any;

beforeEach(() => {
  mockQueries.getVerbConjugations.mockReset();
});

describe("handleConjugateVerb", () => {
  it("returns formatted conjugations when found", async () => {
    mockQueries.getVerbConjugations.mockResolvedValue([
      {
        id: 1,
        infinitive: "tener",
        infinitive_english: "to have",
        mood: "Indicativo",
        tense: "Presente",
        verb_english: "I have",
        form_1s: "tengo",
        form_2s: "tienes",
        form_3s: "tiene",
        form_1p: "tenemos",
        form_2p: "tenéis",
        form_3p: "tienen",
        gerund: "teniendo",
        past_participle: "tenido",
        is_irregular: true,
        source: "jehle",
        created_at: new Date(),
      },
    ]);

    const result = await handleConjugateVerb(mockPool, {
      verb: "tener",
      mood: "Indicativo",
      tense: "Presente",
    });

    expect(mockQueries.getVerbConjugations).toHaveBeenCalledWith(mockPool, {
      verb: "tener",
      mood: "Indicativo",
      tense: "Presente",
      limit: 20,
    });
    expect(result).toContain("Conjugations for tener");
    expect(result).toContain("yo: tengo");
    expect(result).toContain("irregular");
  });

  it("returns not found message when no rows match", async () => {
    mockQueries.getVerbConjugations.mockResolvedValue([]);

    const result = await handleConjugateVerb(mockPool, {
      verb: "inventar",
    });
    expect(result).toContain('No conjugations found for "inventar"');
  });

  it("formats regular rows without optional filters", async () => {
    mockQueries.getVerbConjugations.mockResolvedValue([
      {
        id: 2,
        infinitive: "hablar",
        infinitive_english: "to speak",
        mood: "Indicativo",
        tense: "Presente",
        verb_english: "I speak",
        form_1s: null,
        form_2s: null,
        form_3s: null,
        form_1p: null,
        form_2p: null,
        form_3p: null,
        gerund: null,
        past_participle: null,
        is_irregular: false,
        source: "jehle",
        created_at: new Date(),
      },
    ]);

    const result = await handleConjugateVerb(mockPool, {
      verb: "hablar",
    });

    expect(result).toContain("Conjugations for hablar");
    expect(result).toContain("yo: —");
    expect(result).not.toContain("irregular");
  });

  it("rejects missing verb", async () => {
    await expect(handleConjugateVerb(mockPool, {})).rejects.toThrow();
  });
});
