// Pure pattern classifier — maps a (lemma, tense, person, form) cell to one of
// the 33 conjugation pattern buckets. Used by scripts/import-conjugations.ts at
// import time and unit-tested in isolation.

export type Tense =
  | "present_indicative"
  | "preterite"
  | "imperfect"
  | "future_indicative"
  | "conditional"
  | "present_perfect"
  | "pluperfect"
  | "future_perfect"
  | "conditional_perfect"
  | "present_subjunctive"
  | "imperfect_subjunctive"
  | "present_perfect_subjunctive"
  | "pluperfect_subjunctive"
  | "imperative_affirmative"
  | "imperative_negative";

export type Person = "yo" | "tu" | "el" | "nosotros" | "vosotros" | "ellos";

export type Pattern =
  | "present_regular_ar"
  | "present_regular_er"
  | "present_regular_ir"
  | "present_stem_eie"
  | "present_stem_oue"
  | "present_stem_ei"
  | "present_yo_go"
  | "present_yo_zco"
  | "present_irregular"
  | "preterite_regular_ar"
  | "preterite_regular_er_ir"
  | "preterite_strong"
  | "preterite_stem_iu"
  | "imperfect_regular"
  | "imperfect_irregular"
  | "future_regular"
  | "future_irregular_stem"
  | "conditional_regular"
  | "conditional_irregular_stem"
  | "present_perfect"
  | "pluperfect"
  | "future_perfect"
  | "conditional_perfect"
  | "present_subj_regular"
  | "present_subj_yo_irreg_derived"
  | "present_subj_irregular"
  | "imperfect_subj_regular"
  | "imperfect_subj_strong_stem"
  | "present_perfect_subj"
  | "pluperfect_subj"
  | "imperative_affirmative_regular"
  | "imperative_affirmative_tu_irreg"
  | "imperative_negative";

export interface ClassifyInput {
  lemma: string;
  tense: Tense;
  person: Person;
  form: string;
  template?: string | null;
}

// Hardcoded "fully irregular" sets — verbecc tags them inconsistently across
// tenses, so we list them here for stable bucketing.
const PRESENT_IRREGULAR = new Set([
  "ser",
  "estar",
  "ir",
  "haber",
  "dar",
  "saber",
  "ver",
]);

const IMPERFECT_IRREGULAR = new Set(["ser", "ir", "ver"]);

const PRESENT_SUBJ_IRREGULAR = new Set([
  "ser",
  "estar",
  "ir",
  "haber",
  "dar",
  "ver",
  "saber",
]);

// 8-verb shortened tú imperative set.
const IMPERATIVE_TU_IRREG = new Set([
  "decir",
  "hacer",
  "ir",
  "poner",
  "salir",
  "ser",
  "tener",
  "venir",
]);

// Verbs whose yo present is -go (1ps only).
const YO_GO = new Set([
  "tener",
  "venir",
  "poner",
  "salir",
  "hacer",
  "decir",
  "traer",
  "caer",
  "oír",
  "valer",
  "asir",
]);

// Verbs whose yo present is -zco (1ps only). Detected by ending too.
const YO_ZCO_SUFFIX = ["ecer", "ocer", "ducir", "acer"]; // parecer, conocer, conducir, agradecer (ends in -ecer)

// Stem-changing patterns by lemma (the most common verbs, listed explicitly).
// Person-scoped: only fires for tú/él/ellos in present indicative. We collapse
// nosotros/vosotros back to the regular -ar/-er/-ir pattern.
const STEM_EIE = new Set([
  "pensar",
  "entender",
  "cerrar",
  "comenzar",
  "empezar",
  "querer",
  "perder",
  "sentar",
  "negar",
  "despertar",
  "encender",
  "atender",
  "defender",
  "advertir",
  "sentir",
  "preferir",
  "mentir",
  "convertir",
  "tener", // tienes — note: yo handled by YO_GO
  "venir", // vienes — note: yo handled by YO_GO
  "decir", // dices — note: yo handled by YO_GO
]);

const STEM_OUE = new Set([
  "poder",
  "encontrar",
  "recordar",
  "dormir",
  "morir",
  "volver",
  "mover",
  "contar",
  "costar",
  "mostrar",
  "soñar",
  "resolver",
  "almorzar",
  "probar",
  "aprobar",
  "rogar",
  "colgar",
  "soler",
  "doler",
  "morder",
  "torcer",
]);

const STEM_EI = new Set([
  "pedir",
  "servir",
  "repetir",
  "seguir",
  "conseguir",
  "vestir",
  "medir",
  "elegir",
  "reír",
  "freír",
  "competir",
  "concebir",
  "corregir",
  "despedir",
  "impedir",
  "perseguir",
  "rendir",
]);

// Preterite "strong" stem verbs (irregular preterite stems + endings).
const PRETERITE_STRONG = new Set([
  "tener",
  "estar",
  "andar",
  "saber",
  "haber",
  "poder",
  "poner",
  "querer",
  "venir",
  "hacer",
  "decir",
  "traer",
  "conducir",
  "producir",
  "traducir",
  "reducir",
  "introducir",
  "ser",
  "ir",
  "dar",
  "ver",
]);

// Preterite stem i/u verbs (3rd-person only). Only -ir e→i and -ir o→u verbs.
const PRETERITE_STEM_IU = new Set([
  "pedir",
  "servir",
  "repetir",
  "seguir",
  "vestir",
  "medir",
  "elegir",
  "freír",
  "reír",
  "competir",
  "corregir",
  "dormir",
  "morir",
  "sentir",
  "preferir",
  "mentir",
  "convertir",
  "advertir",
  "consentir",
  "divertir",
]);

// Future/conditional irregular-stem verbs (12).
const FUTURE_IRREG_STEM = new Set([
  "tener",
  "venir",
  "poner",
  "salir",
  "valer",
  "poder",
  "querer",
  "saber",
  "haber",
  "hacer",
  "decir",
  "caber",
]);

function endsWithAny(lemma: string, suffixes: string[]): boolean {
  return suffixes.some((s) => lemma.endsWith(s));
}

function infinitiveClass(lemma: string): "ar" | "er" | "ir" {
  if (lemma.endsWith("ar")) return "ar";
  if (lemma.endsWith("er")) return "er";
  return "ir";
}

function classifyPresentIndicative(
  lemma: string,
  person: Person
): Pattern {
  // yo gets special treatment first.
  if (person === "yo") {
    if (PRESENT_IRREGULAR.has(lemma)) return "present_irregular";
    if (YO_GO.has(lemma)) return "present_yo_go";
    if (endsWithAny(lemma, YO_ZCO_SUFFIX)) return "present_yo_zco";
    // Stem-changing verbs are regular in yo (-o), so fall through to regular.
    return `present_regular_${infinitiveClass(lemma)}` as Pattern;
  }
  // Other persons.
  if (PRESENT_IRREGULAR.has(lemma)) return "present_irregular";
  if (person === "nosotros" || person === "vosotros") {
    // Stems don't change in nos/vos; -zco doesn't either.
    return `present_regular_${infinitiveClass(lemma)}` as Pattern;
  }
  // tú / él / ellos: stem-changing verbs fire here.
  if (STEM_EIE.has(lemma)) return "present_stem_eie";
  if (STEM_OUE.has(lemma)) return "present_stem_oue";
  if (STEM_EI.has(lemma)) return "present_stem_ei";
  return `present_regular_${infinitiveClass(lemma)}` as Pattern;
}

function classifyPreterite(lemma: string, person: Person): Pattern {
  if (PRETERITE_STRONG.has(lemma)) return "preterite_strong";
  // 3ps / 3pp stem-change for e→i, o→u in -ir verbs.
  if (
    (person === "el" || person === "ellos") &&
    PRETERITE_STEM_IU.has(lemma)
  ) {
    return "preterite_stem_iu";
  }
  if (infinitiveClass(lemma) === "ar") return "preterite_regular_ar";
  return "preterite_regular_er_ir";
}

function classifyImperfect(lemma: string): Pattern {
  if (IMPERFECT_IRREGULAR.has(lemma)) return "imperfect_irregular";
  return "imperfect_regular";
}

function classifyFuture(lemma: string): Pattern {
  if (FUTURE_IRREG_STEM.has(lemma)) return "future_irregular_stem";
  return "future_regular";
}

function classifyConditional(lemma: string): Pattern {
  if (FUTURE_IRREG_STEM.has(lemma)) return "conditional_irregular_stem";
  return "conditional_regular";
}

function classifyPresentSubj(lemma: string): Pattern {
  if (PRESENT_SUBJ_IRREGULAR.has(lemma)) return "present_subj_irregular";
  // Subjuntivo derived from yo-irreg stem (yo-go, yo-zco) — same root behavior.
  if (YO_GO.has(lemma) || endsWithAny(lemma, YO_ZCO_SUFFIX)) {
    return "present_subj_yo_irreg_derived";
  }
  return "present_subj_regular";
}

function classifyImperfectSubj(lemma: string): Pattern {
  if (PRETERITE_STRONG.has(lemma)) return "imperfect_subj_strong_stem";
  return "imperfect_subj_regular";
}

function classifyImperativeAffirmative(
  lemma: string,
  person: Person
): Pattern {
  if (person === "tu" && IMPERATIVE_TU_IRREG.has(lemma)) {
    return "imperative_affirmative_tu_irreg";
  }
  return "imperative_affirmative_regular";
}

export function classifyPattern(input: ClassifyInput): Pattern {
  const { lemma, tense, person } = input;
  switch (tense) {
    case "present_indicative":
      return classifyPresentIndicative(lemma, person);
    case "preterite":
      return classifyPreterite(lemma, person);
    case "imperfect":
      return classifyImperfect(lemma);
    case "future_indicative":
      return classifyFuture(lemma);
    case "conditional":
      return classifyConditional(lemma);
    case "present_perfect":
      return "present_perfect";
    case "pluperfect":
      return "pluperfect";
    case "future_perfect":
      return "future_perfect";
    case "conditional_perfect":
      return "conditional_perfect";
    case "present_subjunctive":
      return classifyPresentSubj(lemma);
    case "imperfect_subjunctive":
      return classifyImperfectSubj(lemma);
    case "present_perfect_subjunctive":
      return "present_perfect_subj";
    case "pluperfect_subjunctive":
      return "pluperfect_subj";
    case "imperative_affirmative":
      return classifyImperativeAffirmative(lemma, person);
    case "imperative_negative":
      return "imperative_negative";
  }
}
