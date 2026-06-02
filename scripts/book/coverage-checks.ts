/**
 * Post-write sanity checks for a freshly-written tomo.
 *
 * Run after the writer pass; print results to stdout. These are warnings, not
 * blockers — Mitch's Phase-3 review remains the source of truth. The inline-gloss
 * / open-question coverage checks were retired along with that system; the literal
 * bilingual translation now carries the teaching load. What remains is the
 * high-confidence tilde-slip scan.
 */

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
