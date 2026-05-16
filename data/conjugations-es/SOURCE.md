# data/conjugations-es

Vendored Spanish conjugation data, derived from [`bretttolbert/verbecc`](https://github.com/bretttolbert/verbecc).

`verbs.json` is a flat array of conjugation cells:

```json
[
  {
    "lemma": "hablar",
    "tense": "present_indicative",
    "person": "yo",
    "form": "hablo",
    "template": "habl:ar"
  },
  ...
]
```

The fifteen tenses are the v1 conjugation-flow scope (see
`specs/2026-05-15-conjugation-flow.md`):

- `present_indicative`, `preterite`, `imperfect`, `future_indicative`, `conditional`
- `present_perfect`, `pluperfect`, `future_perfect`, `conditional_perfect`
- `present_subjunctive`, `imperfect_subjunctive`
- `present_perfect_subjunctive`, `pluperfect_subjunctive`
- `imperative_affirmative`, `imperative_negative`

Persons are the six Spain-Spanish persons: `yo`, `tu`, `el`, `nosotros`,
`vosotros`, `ellos`. Imperative tenses omit `yo` (no yo imperative in Spanish).

To rebuild from a fresh verbecc dump: run a one-off script to walk verbecc's
`verbs-es.xml` and `conjugations-es.xml`, expand each lemma against its
template, normalize raw forms (strip subject pronouns and reflexive clitics),
and emit `verbs.json`. Then run `pnpm import:conjugations` to load it into
Postgres.

Until a larger dump is committed, the file ships with a representative
~30-verb subset covering at least one verb per pattern bucket. The shape is
authoritative — both the import script and tests rely on it.
