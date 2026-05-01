---
date: 2026-05-01
topic: mythology-tomos
status: brainstorm
---

# Mythology Tomos — third format for the Espejo book pipeline

## What We're Building

A third tomo format alongside `essay` and `fiction`: **myth** — a Greek (or other mythological)
story retold in Spanish at B1 level, picked because the myth's *shape* resonates with what
Mitch's recent journals and insights have been surfacing. Each myth-tomo has the same
overall structure as existing tomos (1800–2400 words + `## Para llevarte`), split internally
into a **myth retelling section** (~1300 words, third-person literary past) and a
**bridge section** (~500 words, second-person matching current essay voice) that names how
the myth maps to the recent lived material. The same EPUB + email + bilingual pipeline
applies.

Myth-mode is **opportunistic**, not on rotation: the planner scores a curated mythology
corpus against the week's context as part of normal planning, and picks `myth` only when a
corpus entry has genuinely strong fit. Otherwise it falls back to essay/fiction.
Manual override (`--format=myth`, optional `--myth=<name>`) is always available.

## Why This Approach

Considered three structural shapes (myth + bridge / interleaved braid / frame-myth-only),
three source-material approaches (canonical retelling / canon threaded through Mitch's
material / personal myth retold mythologically), three corpus strategies (curated /
free-form / hybrid), and three rotation models (equal-weight / opportunistic / on-demand).

Chosen path:
- **Threaded canon** — the myth is real Greek (or other) mythology, but the planner picks
  *which* myth based on this week's context-gathering. Reuses existing planner mechanics
  cleanly; gives every myth-tomo a genuine mirror function rather than decorative
  Spanish-reading practice.
- **Myth + bridge structure** — clean separation matches the existing tomo body+takeaways
  shape; the myth retelling gives strong indefinido/imperfecto terrain for the active
  grammar focus; the bridge makes the "why this myth this week" legible.
- **Curated corpus** — Mitch's themes are narrow (escape, racha, judge, parts, embodiment,
  return); a curated corpus pointed *at those* gives the planner sharp tools and avoids
  defaulting to Sísifo every time the streak breaks. The corpus file becomes a real
  artifact (Spanish myth summaries) and grows authorially.
- **Opportunistic firing** — myth tomos are highest-effort to land well; rotating one every
  third week guarantees thin matches. Letting the corpus speak (fire only when fit is
  strong) gives the system aesthetic discipline. Bonus: a myth sitting unused in the
  corpus is diagnostic information.

## Key Decisions

- **Source material**: canonical Greek myths threaded through Mitch's lived material
  (option B). Greek-preferred at v1; corpus accepts non-Greek (Norse, Mesoamerican, etc.)
  as they earn their slot.
- **Structure**: myth-retelling-then-bridge (option i). ~1300 words myth + ~500 words
  bridge + 5–8 `## Para llevarte` bullets. Total target 1800–2400 (same as existing).
- **Corpus**: curated `books/myths.jsonl`, one entry per myth with at minimum `name`,
  `culture`, `shape` (one-line theme description), `motifs` (array of keywords),
  optionally `vocabulary_hints` (B1-friendly Spanish phrases that fit the myth's
  register). New myths added explicitly as authorial decisions.
- **Selection**: opportunistic (option Y). Planner runs corpus matching as part of
  context-gathering; picks `myth` format only when fit is strong. Manual flag overrides:
  `--format=myth` (planner picks corpus entry) or `--myth=<name>` (forces a specific
  one).
- **Voice**: myth section in third-person literary past (indefinido/imperfecto-rich).
  Bridge in second-person ("tu semana"), matching the current essay voice.
- **`Para llevarte`**: 5–8 bullets, interleaved — some distill the myth's universal
  teaching, some name what it surfaced about the week. Not segregated.
- **`history.json` schema**: add `myth_name` (string, nullable) for de-duplication.
  Planner excludes myths fired in last N tomos (suggest N=8).
- **`domain` field**: nullable for myth-mode, or set to `mythology`. The myth itself
  replaces the domain axis.
- **Bilingual mode**: same pipeline. The `interleave` pass handles both the myth section
  and the bridge.

## Open Questions (for /ce:plan)

- **Corpus seed list**: which 15–20 myths to seed at v1? Strong candidates given Mitch's
  themes: Sísifo (futile repetition + judgment as relief), Ícaro (judge-led ascent),
  Narciso (mirror-loop), Orfeo (looking back ruins it), Prometeo (gift that becomes
  punishment), Tántalo (proximity without satiation), Dédalo (the engineer-father trap),
  Pandora (curiosity as opening), Perséfone (cyclical return between two worlds),
  Antíope (the part that runs vs. the part that's caught), Hércules' twelve labors
  (each a parts-work vignette), Aracne (the judge punishing excellence), Atlas
  (carrying as identity), Hipnos/Tánatos (sleep and its dark twin), Caronte (the
  threshold figure). Plus a few non-Greek seeds for breadth.
- **Match scoring threshold**: how does the planner judge "fit is strong enough to fire
  myth-mode"? Suggest two-pass: corpus matching produces a top-3 list with reasoning,
  planner picks the best one OR returns "no strong fit" → fall back to essay/fiction.
  Need to decide whether the threshold is a numeric score or an LLM judgment call.
- **`books/style.md` integration**: does myth-mode need its own register section in
  style.md (literary third-person past, mythological vocabulary, *Era una vez*
  conventions), or do we keep the existing style.md as-is and let the writer prompt
  carry the register guidance?
- **Mythology corpus generation**: are the corpus entries hand-written by Mitch, or
  generated by an LLM pass and then edited? Probably the latter for the seed; new
  additions hand-written.
- **Phase-3 review checklist**: what changes for myth-mode? Likely additions: myth
  fidelity (did the retelling honor the canonical shape?), bridge legibility (does the
  resonance land without strain?), register consistency (third-person past in myth,
  second-person in bridge — no slippage). Existing checks (Para llevarte, tilde slips,
  word count, level sanity) carry over.
- **Manual `--myth=<name>` flow**: when forced, does the planner still score this myth
  against the week's context and write a coherent bridge? Or does forced mode skip the
  resonance-check and write the myth straight (risk: bridge feels tacked-on)?
- **Failure mode**: what if the planner judges "no strong fit" but the user invoked
  `--format=myth`? Suggest: surface "no strong fit found in corpus — closest is
  <name>; proceed or pick manually?" rather than silently shipping a thin match.

## Next Steps

→ `/ce:plan` for the implementation plan: corpus seed work, planner changes
(`scripts/book/planner.ts`), writer prompt extensions (`scripts/book/writer.ts`),
`history.json` schema bump, and CLI flag plumbing.
