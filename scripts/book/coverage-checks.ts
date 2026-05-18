/**
 * Post-write sanity checks for a freshly-written tomo.
 *
 * Run after the writer pass; print results to stdout. These are warnings, not
 * blockers — Mitch's Phase-3 review remains the source of truth. The goal is
 * to surface common failure modes (open-question coverage gaps, tilde slips)
 * so manual review can be targeted.
 */

export interface OpenQuestionCoverage {
  question: string;
  matches: string[];
}

export interface CoverageReport {
  totalGlosses: number;
  glosses: string[];
  perQuestion: OpenQuestionCoverage[];
  missingQuestions: string[];
}

/**
 * Categorized keywords for each currently-active open question in Tomo.md.
 * Each category lists ES + EN keywords likely to appear inside an italicized
 * parenthetical gloss explaining that structure. Update if Mitch changes the
 * OPEN QUESTIONS block in `Artifacts/Prompt/Spanish/Tomo.md`.
 */
const QUESTION_KEYWORDS: Array<{ category: string; test: RegExp }> = [
  {
    category: "subjuntivo vs indicativo",
    test: /\b(subjunctive|subjuntivo|indicative|indicativo)\b/i,
  },
  {
    category: "hubo vs había",
    test: /\b(hubo|hab[ií]a|completed event|ongoing state|preterite|preterit)\b/i,
  },
  {
    category: "iba vs era",
    test: /\b(\biba\b|\bera\b|used to|habitual|imperfect)\b/i,
  },
  {
    category: "pronouns / se",
    test:
      /\b(pronoun|reflexive|indirect object|direct object|clitic|impersonal "se"|reciprocal|accidental "se")\b/i,
  },
  {
    category: "despacio vs lento",
    test: /\b(despacio|lento|slowly|slow)\b/i,
  },
];

/**
 * Extract every `(*italic*)` parenthetical gloss from the body. Returns the
 * inner text of each match (without the surrounding `(* … *)`).
 */
export function extractGlosses(body: string): string[] {
  const re = /\(\*([^()*]+?)\*\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

export function checkOpenQuestionsCoverage(body: string): CoverageReport {
  const glosses = extractGlosses(body);
  const perQuestion: OpenQuestionCoverage[] = QUESTION_KEYWORDS.map((q) => ({
    question: q.category,
    matches: glosses.filter((g) => q.test.test(g)),
  }));
  const missingQuestions = perQuestion
    .filter((q) => q.matches.length === 0)
    .map((q) => q.question);
  return {
    totalGlosses: glosses.length,
    glosses,
    perQuestion,
    missingQuestions,
  };
}

interface TildeProbe {
  wrong: RegExp;
  right: string;
}

/**
 * High-confidence tilde-missing offenders. Limited to words where the
 * unaccented form has no valid Spanish meaning in body prose, so the regex
 * yields no false positives. `mas`/`como`/`mi`/`tu`/`si` are deliberately
 * excluded because they have valid unaccented readings.
 */
const TILDE_PROBES: TildeProbe[] = [
  { wrong: /\btambien\b/gi, right: "también" },
  { wrong: /\baqui\b/gi, right: "aquí" },
  { wrong: /\basi\b/gi, right: "así" },
  { wrong: /\bdramaticamente\b/gi, right: "dramáticamente" },
  { wrong: /\bunicamente\b/gi, right: "únicamente" },
  { wrong: /\bfacilmente\b/gi, right: "fácilmente" },
  { wrong: /\brapidamente\b/gi, right: "rápidamente" },
  { wrong: /\bpracticamente\b/gi, right: "prácticamente" },
  { wrong: /\bbasicamente\b/gi, right: "básicamente" },
  { wrong: /\btipicamente\b/gi, right: "típicamente" },
  { wrong: /\bautomaticamente\b/gi, right: "automáticamente" },
];

export interface TildeReport {
  hits: Array<{ word: string; correction: string; count: number }>;
}

export function checkTildes(body: string): TildeReport {
  const hits: TildeReport["hits"] = [];
  for (const probe of TILDE_PROBES) {
    const matches = body.match(probe.wrong);
    if (matches && matches.length > 0) {
      hits.push({
        word: matches[0],
        correction: probe.right,
        count: matches.length,
      });
    }
  }
  return { hits };
}
