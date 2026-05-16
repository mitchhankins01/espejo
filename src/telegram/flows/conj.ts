import { randomUUID } from "crypto";
import type pg from "pg";
import { sendTelegramMessage } from "../client.js";
import { insertChatMessage } from "../../db/queries/chat.js";
import { logUsage } from "../../db/queries/usage.js";
import {
  pickPatternForSession,
  buildConjugationQueue,
  serveConjugationCard,
  rateConjugationCard,
  getConjugationReviewById,
  getConjugationSessionCounts,
  cacheGeneratedSentence,
  type ConjugationReviewRow,
  type GradeKind,
  type ClozeSource,
} from "../../db/queries/conjugation-reviews.js";
import { findClozeSentence } from "../../db/queries/cloze-source.js";
import { gradeAnswer } from "../../fsrs/conj-grading.js";
import { generateClozeSentence } from "../../llm/cloze-gen.js";
import { nextState, type Grade } from "../../fsrs/scheduler.js";
import { buildHint } from "../conj-hints.js";
import {
  clearFlow,
  getFlow,
  setFlow,
  type ConjFlowState,
} from "../flow-state.js";

const FLOW_NAME = "conj";
const CONJ_DEFAULT_CAP = 20;
const CONJ_MIN_CAP = 1;
const CONJ_MAX_CAP = 100;
const SAMPLE_MAX_LEN = 140;

const FLOW_LABEL: Record<string, string> = {
  checkpoint: "checkpoint",
  practice: "practice",
  "vault-prompt": "vault-prompt",
  chat: "chat",
  srs: "srs",
  conj: "conj",
};

const TENSE_LABEL_ES: Record<string, string> = {
  present_indicative: "presente",
  preterite: "pretérito",
  imperfect: "imperfecto",
  future_indicative: "futuro",
  conditional: "condicional",
  present_perfect: "pretérito perfecto",
  pluperfect: "pluscuamperfecto",
  future_perfect: "futuro perfecto",
  conditional_perfect: "condicional perfecto",
  present_subjunctive: "presente de subjuntivo",
  imperfect_subjunctive: "imperfecto de subjuntivo",
  present_perfect_subjunctive: "pretérito perfecto de subjuntivo",
  pluperfect_subjunctive: "pluscuamperfecto de subjuntivo",
  imperative_affirmative: "imperativo afirmativo",
  imperative_negative: "imperativo negativo",
};

const PERSON_TAG: Record<string, string> = {
  yo: "1ps",
  tu: "2ps",
  el: "3ps",
  nosotros: "1pp",
  vosotros: "2pp",
  ellos: "3pp",
};

const PATTERN_LABEL_ES: Record<string, string> = {
  present_regular_ar: "presente · regular -ar",
  present_regular_er: "presente · regular -er",
  present_regular_ir: "presente · regular -ir",
  present_stem_eie: "presente · cambio e→ie",
  present_stem_oue: "presente · cambio o→ue",
  present_stem_ei: "presente · cambio e→i",
  present_yo_go: "presente · yo irregular -go",
  present_yo_zco: "presente · yo irregular -zco",
  present_irregular: "presente · irregular",
  preterite_regular_ar: "pretérito · regular -ar",
  preterite_regular_er_ir: "pretérito · regular -er/-ir",
  preterite_strong: "pretérito · cambio fuerte",
  preterite_stem_iu: "pretérito · cambio e→i / o→u",
  imperfect_regular: "imperfecto · regular",
  imperfect_irregular: "imperfecto · irregular",
  future_regular: "futuro · regular",
  future_irregular_stem: "futuro · raíz irregular",
  conditional_regular: "condicional · regular",
  conditional_irregular_stem: "condicional · raíz irregular",
  present_perfect: "pretérito perfecto",
  pluperfect: "pluscuamperfecto",
  future_perfect: "futuro perfecto",
  conditional_perfect: "condicional perfecto",
  present_subj_regular: "presente subj · regular",
  present_subj_yo_irreg_derived: "presente subj · raíz yo irregular",
  present_subj_irregular: "presente subj · irregular",
  imperfect_subj_regular: "imperfecto subj · regular",
  imperfect_subj_strong_stem: "imperfecto subj · raíz fuerte",
  present_perfect_subj: "pretérito perfecto subj",
  pluperfect_subj: "pluscuamperfecto subj",
  imperative_affirmative_regular: "imperativo afirmativo · regular",
  imperative_affirmative_tu_irreg: "imperativo afirmativo · tú irregular",
  imperative_negative: "imperativo negativo",
};

function flowLabel(name: string): string {
  return FLOW_LABEL[name] ?? name;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function parseConjArgs(
  argText: string
): { newCap: number | undefined } | { error: string } {
  const trimmed = argText.trim();
  if (!trimmed) return { newCap: undefined };
  const n = Number(trimmed);
  if (
    !Number.isInteger(n) ||
    n < CONJ_MIN_CAP ||
    n > CONJ_MAX_CAP
  ) {
    return {
      error: `Usage: /conj [${CONJ_MIN_CAP}-${CONJ_MAX_CAP}]. Got "${argText.trim()}".`,
    };
  }
  return { newCap: n };
}

function patternLabel(pattern: string): string {
  return PATTERN_LABEL_ES[pattern] ?? pattern;
}

function tenseLabel(tense: string): string {
  return TENSE_LABEL_ES[tense] ?? tense;
}

function personTag(person: string): string {
  return PERSON_TAG[person] ?? person;
}

export function formatInterval(due: Date, now: Date = new Date()): string {
  const ms = Math.max(0, due.getTime() - now.getTime());
  const minutes = ms / 60_000;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

/**
 * Replace the inflected form in the sentence with a single `___` cloze.
 * Accent-/case-insensitive, single match per sentence. For
 * `imperative_negative`, strips the leading `no ` so the renderer can add it
 * back outside the blank.
 */
export function maskForm(
  sentence: string,
  form: string,
  tense?: string
): string {
  const isImpNeg = tense === "imperative_negative";
  const escapedForm = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = isImpNeg
    ? `\\bno\\s+${escapedForm}\\b`
    : `\\b${escapedForm}\\b`;
  const re = new RegExp(pattern, "i");
  const replaced = sentence.replace(re, isImpNeg ? "no ___" : "___");
  if (replaced !== sentence) return replaced;
  // Fallback: case-insensitive substring replace if word-boundary failed
  // (forms with leading/trailing punctuation already absorbed by \b).
  const lcSentence = sentence.toLowerCase();
  const idx = lcSentence.indexOf(form.toLowerCase());
  if (idx === -1) return sentence;
  const before = sentence.slice(0, idx);
  const after = sentence.slice(idx + form.length);
  return before + "___" + after;
}

export function renderCardFront(
  row: { lemma: string; tense: string; person: string; expected_form: string },
  sentence: string,
  pattern: string,
  cardIndex: number,
  totalCards: number
): { text: string } {
  const masked = maskForm(sentence, row.expected_form, row.tense);
  const head =
    cardIndex === 0
      ? `🇪🇸 Hoy: ${patternLabel(pattern)}. ${totalCards} cartas.\n\n`
      : "";
  const text =
    `${head}${escapeHtml(masked)}\n` +
    `<i>${escapeHtml(row.lemma)} · ${personTag(row.person)} · ${tenseLabel(row.tense)}</i>\n\n` +
    `Escribe la respuesta · /hint · /easy · /done`;
  return { text };
}

/**
 * Bold the answer in-context within the un-masked sentence so the user can
 * see exactly where the form lives. Preserves the case as it appears in the
 * sentence (e.g. `Somos` at the start, not `somos`). HTML-escapes everything
 * around the matched span so user-provided sentence text can't inject markup.
 */
export function highlightAnswer(sentence: string, form: string): string {
  const escapedForm = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b(${escapedForm})\\b`, "i");
  const match = sentence.match(re);
  if (!match || match.index === undefined) {
    return escapeHtml(sentence);
  }
  const before = sentence.slice(0, match.index);
  const matched = sentence.slice(match.index, match.index + match[0].length);
  const after = sentence.slice(match.index + match[0].length);
  return (
    escapeHtml(before) +
    "<b>" +
    escapeHtml(matched) +
    "</b>" +
    escapeHtml(after)
  );
}

export function renderResult(
  gradeKind: GradeKind,
  expected: string,
  maskedFilled: string,
  due: Date,
  now: Date = new Date()
): string {
  const interval = formatInterval(due, now);
  switch (gradeKind) {
    case "exact":
      return `✓ ${escapeHtml(expected)} (good) → next in ${interval}`;
    case "hint_correct":
      return `✓ ${escapeHtml(expected)} (hint → hard) → next in ${interval}`;
    case "easy":
      return `⏭ ${escapeHtml(expected)} (easy → next in ${interval})`;
    case "hint_easy":
      return `⏭ ${escapeHtml(expected)} (hint+easy → hard → next in ${interval})`;
    case "wrong":
      return (
        `✗ Expected: <b>${escapeHtml(expected)}</b>\n` +
        `${highlightAnswer(maskedFilled, expected)}\n` +
        `(again → next in ${interval})`
      );
    case "hint_wrong":
      return (
        `✗ Expected: <b>${escapeHtml(expected)}</b>\n` +
        `${highlightAnswer(maskedFilled, expected)}\n` +
        `(hint → again → next in ${interval})`
      );
  }
}

export function renderSessionSummary(
  prefix: "Listo" | "Stopped",
  pattern: string,
  state: ConjFlowState,
  counts: { due: number; stalling: number; unpromoted: number }
): string {
  const c = state.countsByGradeKind;
  const correct = c.exact + c.hint_correct;
  const skip = c.easy + c.hint_easy;
  const wrong = c.wrong + c.hint_wrong;
  const withHint = c.hint_correct + c.hint_wrong + c.hint_easy;
  return (
    `${prefix}. Patrón: ${patternLabel(pattern)}.\n` +
    `${state.reviewedCount} revisadas — ${correct} ✓ · ${skip} ⏭ · ${wrong} ✗ · ${withHint} con pista.\n` +
    `${counts.due} pendientes (otros patrones), ${counts.stalling} atascadas, ${counts.unpromoted} celdas sin promover.`
  );
}

function truncateSentence(s: string): string {
  if (s.length <= SAMPLE_MAX_LEN) return s;
  return s.slice(0, SAMPLE_MAX_LEN - 1).trimEnd() + "…";
}

interface ConjDeps {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
}

async function persistAssistant(
  pool: pg.Pool,
  chatId: string,
  content: string
): Promise<void> {
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content,
    flow: FLOW_NAME,
  });
}

async function persistUser(
  pool: pg.Pool,
  chatId: string,
  externalMessageId: string | null,
  content: string
): Promise<void> {
  await insertChatMessage(pool, {
    chatId,
    externalMessageId,
    role: "user",
    content,
    flow: FLOW_NAME,
  });
}

async function resolveClozeSentence(
  deps: ConjDeps,
  row: ConjugationReviewRow
): Promise<{ sentence: string; source: ClozeSource }> {
  const hit = await findClozeSentence(deps.pool, {
    lemma: row.lemma,
    lang: "es",
    form: row.expected_form,
    tense: row.tense,
    reps: row.reps,
  });
  if (hit) {
    return { sentence: truncateSentence(hit.sentence), source: "corpus" };
  }
  if (row.generated_sentence) {
    return { sentence: row.generated_sentence, source: "generated" };
  }
  const generated = await generateClozeSentence({
    lemma: row.lemma,
    tense: row.tense,
    person: row.person,
    form: row.expected_form,
  });
  await cacheGeneratedSentence(
    deps.pool,
    row.id,
    generated.sentence,
    generated.form
  );
  logUsage(deps.pool, {
    source: "telegram",
    surface: "flow",
    action: "conj.cloze-gen",
    actor: deps.chatId,
    args: {
      lemma: row.lemma,
      tense: row.tense,
      person: row.person,
      form: row.expected_form,
    },
    ok: true,
  });
  return { sentence: generated.sentence, source: "generated" };
}

async function serveNextCard(
  deps: ConjDeps,
  state: ConjFlowState
): Promise<void> {
  const nextId = state.queue[state.queueIndex];
  if (nextId === undefined) {
    await endSessionWithSummary(deps, state, "Listo");
    return;
  }
  const row = await getConjugationReviewById(deps.pool, nextId);
  if (!row) {
    state.queueIndex += 1;
    setFlow(deps.chatId, state);
    await serveNextCard(deps, state);
    return;
  }
  await serveConjugationCard(deps.pool, {
    id: row.id,
    sessionId: state.sessionId,
    chatId: deps.chatId,
  });

  let sentence: string;
  let source: ClozeSource;
  try {
    const resolved = await resolveClozeSentence(deps, row);
    sentence = resolved.sentence;
    source = resolved.source;
  } catch (err) {
    console.error(
      `[conj] cloze resolution failed for review ${row.id}:`,
      err instanceof Error ? err.message : err
    );
    // Last-ditch fallback: use a person-cue-only minimal frame so the user
    // can still play. Mark as generated for telemetry honesty.
    sentence = `(${row.lemma}) — ${row.expected_form}`;
    // Re-mask: we don't want to show the answer, so build a generic.
    sentence = `(sin contexto) — ${row.expected_form}`;
    source = "generated";
  }

  state.currentCardId = row.id;
  state.currentExpected = row.expected_form;
  state.currentTense = row.tense;
  state.currentPattern = row.pattern;
  state.currentPerson = row.person;
  state.currentLemma = row.lemma;
  state.currentSentence = sentence;
  state.currentClozeSource = source;
  state.hintUsed = false;
  setFlow(deps.chatId, state);

  const front = renderCardFront(
    row,
    sentence,
    state.pattern,
    state.queueIndex,
    state.queue.length
  );
  await sendTelegramMessage(deps.chatId, front.text);
  await persistAssistant(deps.pool, deps.chatId, front.text);

  logUsage(deps.pool, {
    source: "telegram",
    surface: "flow",
    action: "conj.serve",
    actor: deps.chatId,
    args: {
      reviewId: row.id,
      lemma: row.lemma,
      tense: row.tense,
      person: row.person,
      pattern: row.pattern,
      frequencyRank: row.frequency_rank,
      clozeSource: source,
    },
    ok: true,
  });
}

async function endSessionWithSummary(
  deps: ConjDeps,
  state: ConjFlowState,
  prefix: "Listo" | "Stopped"
): Promise<void> {
  const counts = await getConjugationSessionCounts(deps.pool);
  const summary = renderSessionSummary(prefix, state.pattern, state, counts);
  await sendTelegramMessage(deps.chatId, summary);
  await persistAssistant(deps.pool, deps.chatId, summary);
  logUsage(deps.pool, {
    source: "telegram",
    surface: "flow",
    action: "conj.done",
    actor: deps.chatId,
    args: {
      reviewedCount: state.reviewedCount,
      pattern: state.pattern,
      hintCount: state.hintCount,
    },
    ok: true,
  });
  clearFlow(deps.chatId);
}

export async function startConjFlow(
  deps: ConjDeps & { argText?: string }
): Promise<void> {
  const { pool, chatId, externalMessageId, argText } = deps;
  const rawCommand = `/conj${argText ? ` ${argText}` : ""}`;

  const active = getFlow(chatId);
  if (active) {
    const reply = `Termina /done primero — tienes flow ${flowLabel(active.flow)} activa.`;
    await persistUser(pool, chatId, externalMessageId, rawCommand);
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "conj.start",
      actor: chatId,
      args: { reason: "soft_block", activeFlow: active.flow },
      ok: true,
    });
    return;
  }

  await persistUser(pool, chatId, externalMessageId, rawCommand);

  const parsed = parseConjArgs(argText ?? "");
  if ("error" in parsed) {
    await sendTelegramMessage(chatId, parsed.error);
    await persistAssistant(pool, chatId, parsed.error);
    return;
  }
  const cap = parsed.newCap ?? CONJ_DEFAULT_CAP;

  const pattern = await pickPatternForSession(pool);
  if (!pattern) {
    const reply = "Cola vacía. Corre `pnpm import:conjugations` y reintenta.";
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "conj.start",
      actor: chatId,
      args: { reason: "no_candidates", cap },
      ok: true,
    });
    return;
  }

  const queue = await buildConjugationQueue(pool, pattern, cap);
  if (queue.length === 0) {
    const reply = "Cola vacía. Corre `pnpm import:conjugations` y reintenta.";
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "conj.start",
      actor: chatId,
      args: { reason: "empty_queue", cap, pattern },
      ok: true,
    });
    return;
  }

  const state: ConjFlowState = {
    flow: "conj",
    sessionId: randomUUID(),
    startedAt: Date.now(),
    pattern,
    queue,
    queueIndex: 0,
    reviewedCount: 0,
    countsByGradeKind: {
      exact: 0,
      wrong: 0,
      easy: 0,
      hint_correct: 0,
      hint_wrong: 0,
      hint_easy: 0,
    },
    hintCount: 0,
    currentCardId: null,
    currentExpected: null,
    currentTense: null,
    currentPattern: null,
    currentPerson: null,
    currentLemma: null,
    currentSentence: null,
    currentClozeSource: null,
    hintUsed: false,
  };
  setFlow(chatId, state);

  logUsage(pool, {
    source: "telegram",
    surface: "flow",
    action: "conj.start",
    actor: chatId,
    args: { pattern, cap, queueSize: queue.length },
    ok: true,
  });

  await serveNextCard(deps, state);
}

export async function continueConjFlow(
  deps: ConjDeps & { text: string }
): Promise<void> {
  const { pool, chatId, externalMessageId, text } = deps;
  const state = getFlow(chatId);
  if (state?.flow !== "conj") return;

  await persistUser(pool, chatId, externalMessageId, text);

  if (!state.currentCardId || !state.currentExpected || !state.currentTense) {
    const reply = "Card desincronizada. /done y vuelve a empezar.";
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    clearFlow(chatId);
    return;
  }

  const trimmed = text.trim();

  if (trimmed === "/hint") {
    if (state.hintUsed) {
      const reply = "Ya tienes una pista. Escribe la respuesta o /done.";
      await sendTelegramMessage(chatId, reply);
      await persistAssistant(pool, chatId, reply);
      return;
    }
    const hint = buildHint({
      pattern: state.currentPattern ?? state.pattern,
      tense: state.currentTense,
      person: state.currentPerson ?? "yo",
      expected_form: state.currentExpected,
    });
    state.hintUsed = true;
    state.hintCount += 1;
    setFlow(chatId, state);
    const reply = `💡 Pista — ${hint}`;
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "conj.hint",
      actor: chatId,
      args: {
        reviewId: state.currentCardId,
        lemma: state.currentLemma,
        tense: state.currentTense,
        person: state.currentPerson,
        pattern: state.currentPattern,
      },
      ok: true,
    });
    return;
  }

  // Unknown slash other than /easy or /hint (end-flow aliases are already
  // intercepted by the router): tell the user how to play and keep card open.
  if (
    trimmed.startsWith("/") &&
    trimmed !== "/easy"
  ) {
    const reply = "Escribe la respuesta, /hint, /easy o /done.";
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    return;
  }

  const grade = gradeAnswer(text, state.currentExpected, state.currentTense);
  const wasHintUsed = state.hintUsed;

  let gradeKind: GradeKind;
  let rating: Grade;
  if (wasHintUsed) {
    if (grade.kind === "easy") {
      gradeKind = "hint_easy";
      rating = 2;
    } else if (grade.kind === "exact") {
      gradeKind = "hint_correct";
      rating = 2;
    } else {
      gradeKind = "hint_wrong";
      rating = 1;
    }
  } else {
    gradeKind = grade.kind;
    rating = grade.grade;
  }

  const row = await getConjugationReviewById(pool, state.currentCardId);
  if (!row) {
    const reply = "Card vencida. /done.";
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "conj.race",
      actor: chatId,
      args: { reviewId: state.currentCardId, where: "continue" },
      ok: true,
    });
    clearFlow(chatId);
    return;
  }

  if (
    row.current_session_id !== state.sessionId ||
    row.current_session_rated_at !== null
  ) {
    const reply = "Card vencida. /done.";
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "conj.race",
      actor: chatId,
      args: { reviewId: row.id, where: "rate" },
      ok: true,
    });
    clearFlow(chatId);
    return;
  }

  const cardBefore = {
    due: row.due,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    last_review: row.last_review,
  };
  const next = nextState(cardBefore, rating);

  const typedAnswer =
    grade.kind === "easy"
      ? null
      : text;

  const ok = await rateConjugationCard(pool, {
    id: row.id,
    sessionId: state.sessionId,
    rating,
    gradeKind,
    typedAnswer,
    hintUsed: wasHintUsed,
    clozeSource: state.currentClozeSource ?? "corpus",
    next,
    chatId,
  });
  if (!ok) {
    const reply = "Card vencida. /done.";
    await sendTelegramMessage(chatId, reply);
    await persistAssistant(pool, chatId, reply);
    logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "conj.race",
      actor: chatId,
      args: { reviewId: row.id, where: "rate" },
      ok: true,
    });
    clearFlow(chatId);
    return;
  }

  state.reviewedCount += 1;
  state.countsByGradeKind[gradeKind] += 1;
  // Build a "filled" rendering for wrong-answer renders — re-mask then
  // re-insert expected for context.
  const filled = (state.currentSentence ?? "").replace(
    /___/g,
    state.currentExpected
  );

  state.hintUsed = false;
  state.currentCardId = null;
  state.currentExpected = null;
  state.currentTense = null;
  state.currentPattern = null;
  state.currentPerson = null;
  state.currentLemma = null;
  state.currentSentence = null;
  state.currentClozeSource = null;
  state.queueIndex += 1;
  setFlow(chatId, state);

  const resultText = renderResult(
    gradeKind,
    row.expected_form,
    filled,
    next.due
  );
  await sendTelegramMessage(chatId, resultText);
  await persistAssistant(pool, chatId, resultText);

  logUsage(pool, {
    source: "telegram",
    surface: "flow",
    action: "conj.rate",
    actor: chatId,
    args: {
      reviewId: row.id,
      lemma: row.lemma,
      tense: row.tense,
      person: row.person,
      gradeKind,
      grade: rating,
      hintUsed: wasHintUsed,
      clozeSource: state.currentClozeSource,
    },
    ok: true,
  });

  await serveNextCard(deps, state);
}

export async function endConjFlow(deps: ConjDeps): Promise<{ ended: boolean }> {
  const state = getFlow(deps.chatId);
  if (state?.flow !== "conj") return { ended: false };
  await persistUser(deps.pool, deps.chatId, deps.externalMessageId, "/done");
  await endSessionWithSummary(deps, state, "Stopped");
  return { ended: true };
}
