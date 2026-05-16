// Pure grader for typed Spanish conjugation answers. Case-insensitive,
// whitespace-normalized, accent-sensitive. Returns the FSRS grade + a kind
// tag the flow uses to drive renders and log rows.
//
// The hint-cap transformation (`exact → hint_correct/2`, etc.) lives in the
// flow, not here — `gradeAnswer` is independent of session state.

export type GradeKind = "exact" | "wrong" | "easy";

export interface GradeResult {
  kind: GradeKind;
  grade: 1 | 3 | 4;
}

function collapseSpaces(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function normalize(s: string): string {
  return collapseSpaces(s).toLowerCase();
}

const RA_SE_SIMPLE: Record<string, string> = {
  ra: "se",
  ras: "ses",
  ramos: "semos",
  rais: "seis",
  ran: "sen",
};

const HUBIERA_HUBIESE: Record<string, string> = {
  hubiera: "hubiese",
  hubieras: "hubieses",
  hubiéramos: "hubiésemos",
  hubierais: "hubieseis",
  hubieran: "hubiesen",
};

/**
 * For imperfect_subjunctive and pluperfect_subjunctive, the -se variant is
 * an equally correct answer. Returns the -se equivalent of the canonical
 * -ra form when applicable; null otherwise.
 */
export function raToSe(form: string, tense?: string): string | null {
  if (tense === "imperfect_subjunctive") {
    const m = form.match(/(ra|ras|ramos|rais|ran)$/);
    if (!m) return null;
    return form.slice(0, form.length - m[0].length) + RA_SE_SIMPLE[m[0]];
  }
  if (tense === "pluperfect_subjunctive") {
    const head = form.split(" ")[0];
    if (head in HUBIERA_HUBIESE) {
      return HUBIERA_HUBIESE[head] + form.slice(head.length);
    }
    return null;
  }
  return null;
}

export function gradeAnswer(
  typed: string,
  expected: string,
  tense?: string
): GradeResult {
  if (typed.trim() === "/easy") {
    return { kind: "easy", grade: 4 };
  }
  const tn = normalize(typed);
  const en = normalize(expected);
  if (tn === en) return { kind: "exact", grade: 3 };
  const alt = raToSe(expected, tense);
  if (alt !== null && tn === normalize(alt)) {
    return { kind: "exact", grade: 3 };
  }
  return { kind: "wrong", grade: 1 };
}
