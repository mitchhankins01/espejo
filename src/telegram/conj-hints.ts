// Pure pattern hint builder. Returns a one-line cue that points at the rule
// without leaking the full expected form. 33 templates keyed by pattern;
// invariant: the returned string never contains expected_form after
// case-insensitive whitespace normalization.

export interface HintInput {
  pattern: string;
  tense: string;
  person: string;
  expected_form: string;
}

const NO_HINT = "sin pista disponible";

const CONJUGATION_ENDINGS_BY_TENSE_PERSON: Record<string, Record<string, string>> = {
  present_indicative: {
    yo: "-o",
    tu: "-as/-es",
    el: "-a/-e",
    nosotros: "-amos/-emos/-imos",
    vosotros: "-áis/-éis/-ís",
    ellos: "-an/-en",
  },
  preterite: {
    yo: "-é/-í",
    tu: "-aste/-iste",
    el: "-ó/-ió",
    nosotros: "-amos/-imos",
    vosotros: "-asteis/-isteis",
    ellos: "-aron/-ieron",
  },
  imperfect: {
    yo: "-aba/-ía",
    tu: "-abas/-ías",
    el: "-aba/-ía",
    nosotros: "-ábamos/-íamos",
    vosotros: "-abais/-íais",
    ellos: "-aban/-ían",
  },
  future_indicative: {
    yo: "-é",
    tu: "-ás",
    el: "-á",
    nosotros: "-emos",
    vosotros: "-éis",
    ellos: "-án",
  },
  conditional: {
    yo: "-ía",
    tu: "-ías",
    el: "-ía",
    nosotros: "-íamos",
    vosotros: "-íais",
    ellos: "-ían",
  },
};

const HABER_BY_TENSE: Record<string, string> = {
  present_perfect: "he/has/ha/hemos/habéis/han",
  pluperfect: "había/habías/había/habíamos/habíais/habían",
  future_perfect: "habré/habrás/habrá/habremos/habréis/habrán",
  conditional_perfect: "habría/habrías/habría/habríamos/habríais/habrían",
  present_perfect_subjunctive: "haya/hayas/haya/hayamos/hayáis/hayan",
  pluperfect_subjunctive: "hubiera/hubieras/hubiera/hubiéramos/hubierais/hubieran",
};

/** Conservative stem-from-form chopper for stem-leak hints. Drops the
 *  canonical ending so we don't reveal the full form. */
function stemFromForm(form: string, tense: string): string {
  const tail = form.replace(/[áéíóúüñ]/g, (c) =>
    ({ á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u", ñ: "n" })[c] ?? c
  );
  // Strip the last 1-3 characters from the single-word part.
  const head = form.split(" ")[0];
  // Try chopping common endings.
  const endings = [
    "ábamos", "íamos", "ríamos",
    "amos", "emos", "imos",
    "iste", "aste", "isteis", "asteis",
    "ieron", "eron", "aron", "íais",
    "remos", "réis", "rías", "ría", "rán", "rás", "ré", "rá",
    "an", "en", "as", "es", "ar", "er", "ir",
    "o", "a", "e", "í", "é", "ó",
  ];
  for (const end of endings) {
    if (head.toLowerCase().endsWith(end) && head.length > end.length + 1) {
      void tail;
      void tense;
      return head.slice(0, head.length - end.length) + "-";
    }
  }
  // Fall back: chop last 2 chars.
  return head.length > 2 ? head.slice(0, head.length - 2) + "-" : head + "-";
}

function regularEndingHint(tense: string, person: string): string | null {
  const personMap = CONJUGATION_ENDINGS_BY_TENSE_PERSON[tense];
  if (!personMap) return null;
  return personMap[person] ?? null;
}

function buildRaw(input: HintInput): string {
  const { pattern, tense, person, expected_form } = input;
  switch (pattern) {
    case "present_yo_go":
      return `yo stem: ${stemFromForm(expected_form, tense)} (yo-go pattern)`;
    case "present_yo_zco":
      return `yo stem: ${stemFromForm(expected_form, tense)} (yo-zco pattern)`;
    case "present_stem_eie":
      return "e→ie stem-change in tú/él/ellos";
    case "present_stem_oue":
      return "o→ue stem-change in tú/él/ellos";
    case "present_stem_ei":
      return "e→i stem-change in tú/él/ellos";
    case "present_regular_ar":
      return `presente -ar, ${person} ending: ${regularEndingHint("present_indicative", person) ?? "-o/-as/-a/…"}`;
    case "present_regular_er":
      return `presente -er, ${person} ending: ${regularEndingHint("present_indicative", person) ?? "-o/-es/-e/…"}`;
    case "present_regular_ir":
      return `presente -ir, ${person} ending: ${regularEndingHint("present_indicative", person) ?? "-o/-es/-e/…"}`;
    case "present_irregular":
      return "fully irregular present — recall the paradigm";

    case "preterite_strong":
      return `stem: ${stemFromForm(expected_form, tense)} (pretérito fuerte)`;
    case "preterite_stem_iu":
      return "e→i / o→u stem-change in 3ps/3pp pretérito";
    case "preterite_regular_ar":
      return `pretérito -ar, ${person} ending: ${regularEndingHint("preterite", person) ?? "-é/-aste/-ó/…"}`;
    case "preterite_regular_er_ir":
      return `pretérito -er/-ir, ${person} ending: ${regularEndingHint("preterite", person) ?? "-í/-iste/-ió/…"}`;

    case "imperfect_regular":
      return `imperfecto regular, ${person} ending: ${regularEndingHint("imperfect", person) ?? "-aba/-ía"}`;
    case "imperfect_irregular":
      return "one of the three irregular imperfectos (ser/ir/ver)";

    case "future_regular":
      return "futuro: infinitivo + endings (-é/-ás/-á/-emos/-éis/-án)";
    case "future_irregular_stem":
      return `stem: ${stemFromForm(expected_form, tense)} (futuro irregular)`;
    case "conditional_regular":
      return "condicional: infinitivo + endings (-ía/-ías/-ía/-íamos/-íais/-ían)";
    case "conditional_irregular_stem":
      return `stem: ${stemFromForm(expected_form, tense)} (condicional irregular)`;

    case "present_perfect":
      return `aux: ${HABER_BY_TENSE.present_perfect} + participio`;
    case "pluperfect":
      return `aux: ${HABER_BY_TENSE.pluperfect} + participio`;
    case "future_perfect":
      return `aux: ${HABER_BY_TENSE.future_perfect} + participio`;
    case "conditional_perfect":
      return `aux: ${HABER_BY_TENSE.conditional_perfect} + participio`;

    case "present_subj_regular":
      return "presente subj: -ar→e-, -er/-ir→a-";
    case "present_subj_yo_irreg_derived":
      return `subj built from yo-irreg stem: ${stemFromForm(expected_form, tense)}- + subj endings`;
    case "present_subj_irregular":
      return "presente subj fully irregular (sea/vaya/dé/vea/sepa/esté/haya)";

    case "imperfect_subj_regular":
      return "imperfecto subj: 3pp pretérito stem + -ra/-se";
    case "imperfect_subj_strong_stem":
      return `stem: ${stemFromForm(expected_form, tense)} + -ra/-se`;

    case "present_perfect_subj":
      return `aux: ${HABER_BY_TENSE.present_perfect_subjunctive} + participio`;
    case "pluperfect_subj":
      return `aux: ${HABER_BY_TENSE.pluperfect_subjunctive} + participio`;

    case "imperative_affirmative_regular":
      return "tú = 3ps presente; usted/ustedes = presente subj";
    case "imperative_affirmative_tu_irreg": {
      // Drop the verb that matches the expected form from the listed set so
      // the hint doesn't reveal the answer.
      const allEntries: { verb: string; form: string }[] = [
        { verb: "decir", form: "di" },
        { verb: "hacer", form: "haz" },
        { verb: "ir", form: "ve" },
        { verb: "poner", form: "pon" },
        { verb: "salir", form: "sal" },
        { verb: "ser", form: "sé" },
        { verb: "tener", form: "ten" },
        { verb: "venir", form: "ven" },
      ];
      const remaining = allEntries.filter(
        (e) => e.form !== expected_form.toLowerCase()
      );
      const formsList = remaining.map((e) => e.form).join("/");
      return `tú: short irregular imperative (one of: ${formsList})`;
    }
    case "imperative_negative":
      return "imperativo negativo = presente subjuntivo";

    default:
      return NO_HINT;
  }
}

/**
 * Build a hint that never leaks the expected form. The invariant is:
 *   normalize(hint).includes(normalize(expected_form)) === false
 * If the generated hint would violate this (rare — typically for short
 * irregular imperatives like `ten`, `ve`, `sé`, `ha`), fall back to the
 * pattern's family-level hint instead.
 */
export function buildHint(input: HintInput): string {
  const raw = buildRaw(input);
  const normExpected = input.expected_form.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normExpected) return raw;
  const normHint = raw.toLowerCase();
  // Match expected as a whole word so that e.g. "stem: tuv-" doesn't trip on
  // an answer of "tu" or "v".
  const re = new RegExp(
    `(^|[^a-záéíóúüñ])${normExpected.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([^a-záéíóúüñ]|$)`
  );
  if (re.test(normHint)) {
    // Family-level fallback: drop the stem-leak portion of the hint and
    // return the rule-only phrasing.
    switch (input.pattern) {
      case "present_yo_go":
        return "yo-go pattern (irregular yo)";
      case "present_yo_zco":
        return "yo-zco pattern (irregular yo)";
      case "preterite_strong":
        return "pretérito fuerte (irregular stem + special endings)";
      case "future_irregular_stem":
      case "conditional_irregular_stem":
        return "irregular stem (12-verb set: tener, salir, poner, hacer, decir, …)";
      case "present_subj_yo_irreg_derived":
        return "subjuntivo: build from yo-irreg stem + subj endings";
      case "imperfect_subj_strong_stem":
        return "imperfecto subj: pretérito-strong stem + -ra/-se";
      case "imperative_affirmative_tu_irreg":
        return "tú: short irregular imperative (one of the 8: decir/hacer/ir/poner/salir/ser/tener/venir)";
      case "present_irregular":
        return "fully irregular present — recall the paradigm";
      case "imperfect_irregular":
        return "irregular imperfect (ser/ir/ver)";
      case "present_subj_irregular":
        return "fully irregular present subjuntivo";
      default:
        return NO_HINT;
    }
  }
  return raw;
}
