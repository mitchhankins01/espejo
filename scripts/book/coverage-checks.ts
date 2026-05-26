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

interface QuestionCategory {
  category: string;
  /** Matches the free-text OPEN QUESTIONS bullet this category covers (drives the unmapped-question guard). */
  questionTest: RegExp;
  /** Matches an inline gloss in the body that exercises this structure. */
  glossTest: RegExp;
}

/**
 * One category per currently-active open question in Tomo.md. `glossTest`
 * matches the ES/EN keywords likely to appear inside the italicized gloss;
 * `questionTest` matches the question bullet itself so `findUnmappedQuestions`
 * can warn loudly when Mitch adds a question with no category here — closing the
 * old silent-pass gap where a new question was simply never checked.
 */
const QUESTION_KEYWORDS: QuestionCategory[] = [
  {
    category: "subjuntivo vs indicativo",
    questionTest: /subjuntivo|indicativo|subjunctive|indicative/i,
    glossTest:
      /\b(subjunctive|subjuntivo|indicative|indicativo|hablara|hablase)\b/i,
  },
  {
    category: "el condicional",
    questionTest: /condicional|conditional|hablar[ií]a|would speak|would have/i,
    glossTest: /\b(conditional|condicional|would speak|would have|hypothetical)\b/i,
  },
  {
    category: "el pluscuamperfecto",
    questionTest: /pluscuamperfecto|pluperfect|past-before-the-past|had spoken/i,
    glossTest:
      /\b(pluperfect|pluscuamperfecto|had spoken|prior past|past-before-the-past)\b/i,
  },
  {
    category: "el imperativo",
    questionTest: /imperativo|imperative|command/i,
    glossTest:
      /\b(imperative|imperativo|command|affirmative command|negative command)\b/i,
  },
  {
    category: "pronouns / se",
    questionTest:
      /pronoun|pronombre|particle|\bse\b|object|reflexive|demonstrative|possessive/i,
    glossTest:
      /\b(pronoun|reflexive|indirect object|direct object|clitic|impersonal "se"|reciprocal|accidental "se")\b/i,
  },
  {
    category: "por vs para",
    questionTest: /\bpor\b[\s\S]*\bpara\b|\bpara\b[\s\S]*\bpor\b/i,
    glossTest: /"por"|"para"|\bpurpose\b|\bdestination\b|by means of|in order to/i,
  },
];

/**
 * Open questions in Tomo.md that map to no category above — their gloss
 * coverage is therefore unverified. Returns [] when every question is covered.
 * Wired into the write path so adding a question without a category warns
 * loudly instead of silently passing.
 */
export function findUnmappedQuestions(questions: string[]): string[] {
  return questions.filter(
    (q) => !QUESTION_KEYWORDS.some((c) => c.questionTest.test(q))
  );
}

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

/** Soft ceiling on gloss length — a gloss is a quick aside, not a mini-lesson. */
export const MAX_GLOSS_WORDS = 12;

/**
 * Glosses whose inner text runs past `maxWords`. Surfaced as a Phase-3 warning
 * so verbose, mini-lesson glosses get tightened — brevity is a soft rule the
 * writer prompt pushes but can't hard-enforce.
 */
export function findLongGlosses(
  body: string,
  maxWords: number = MAX_GLOSS_WORDS
): Array<{ gloss: string; words: number }> {
  return extractGlosses(body)
    .map((gloss) => ({
      gloss,
      words: gloss.split(/\s+/).filter((w) => w.length > 0).length,
    }))
    .filter((g) => g.words > maxWords);
}

export function checkOpenQuestionsCoverage(body: string): CoverageReport {
  const glosses = extractGlosses(body);
  const perQuestion: OpenQuestionCoverage[] = QUESTION_KEYWORDS.map((q) => ({
    question: q.category,
    matches: glosses.filter((g) => q.glossTest.test(g)),
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
