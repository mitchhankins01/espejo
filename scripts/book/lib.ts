/**
 * Shared machinery for the tomo pipeline. The pipeline is three phase scripts —
 * `scripts/plan-tomo.ts` (menu), `scripts/write-tomo.ts` (draft → verify →
 * bilingual → EPUB), `scripts/publish-tomo.ts` (send to Kindle) — and this lib.
 * Everything cross-phase lives here: model registry + LLM wrapper, plan/history
 * state, DB context gathering, bilingual interleave, EPUB build, Kindle send,
 * and small utils. The prompts that define each phase's behavior live in the
 * phase scripts themselves so each reads top-to-bottom.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type { ModelMessage } from "ai";
import { EPub } from "epub-gen-memory";
import { marked } from "marked";
import { config } from "../../src/config.js";
import { chat, embedTextSimple, type LlmProvider } from "../../src/llm/index.js";
import { pool } from "../../src/db/client.js";
import { sendEmail } from "../../src/email/send.js";

// ---------------------------------------------------------------------------
// Paths + tuning constants
// ---------------------------------------------------------------------------

export const TOMOS_DIR = "books/tomos";
export const BUILD_DIR = "books/build";
export const PLAN_PATH = "books/next-plan.json";
export const HISTORY_PATH = "books/history.json";
/** The vault prompt doc that carries the hand-edited SERIES QUEUE block. */
export const TOMO_PROMPT_PATH = "Artifacts/Prompt/Spanish/Tomo.md";

/** Tomos written in parallel per `--pick` batch (provider rate-limit friendly). */
export const WRITE_CONCURRENCY = 2;
/** Parallel ES→EN chunks in the bilingual pass. */
const CHUNK_CONCURRENCY = 6;

export function paddedTomo(n: number): string {
  return String(n).padStart(4, "0");
}

export function tomoMdPath(n: number): string {
  return `${TOMOS_DIR}/${paddedTomo(n)}.md`;
}

export function tomoBilingualPath(n: number): string {
  return `${TOMOS_DIR}/${paddedTomo(n)}-bilingual.md`;
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

/**
 * Write JSON atomically (temp file + rename) so a reader can never observe a
 * half-written or stale file. The plan-only/pick race that showed a stale menu
 * came from reading `next-plan.json` mid-write — rename is atomic on the same fs.
 */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

/** Run `fn` over `items` with a concurrency cap; never rejects — inspect statuses. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Strict variant: like mapWithConcurrency but throws the first failure. */
export async function mapWithConcurrencyStrict<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const settled = await mapWithConcurrency(items, limit, fn);
  const firstError = settled.find((r) => r.status === "rejected");
  if (firstError) throw (firstError as PromiseRejectedResult).reason;
  return settled.map((r) => (r as PromiseFulfilledResult<R>).value);
}

/**
 * Extract the first {...} JSON object from model output. LLMs wrap JSON in
 * prose/fences often enough that every JSON-returning call needs this.
 * Throws with the raw text when there's no object or it doesn't parse.
 */
export function extractJsonObject<T>(text: string): T {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("model returned no JSON object. Raw output:\n" + text);
  }
  return JSON.parse(match[0]) as T;
}

export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

export function errorMessage(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split("\n")[0];
}

// ---------------------------------------------------------------------------
// Model registry — the single source of book model ids
// ---------------------------------------------------------------------------

/**
 * Every book model id, resolved from env exactly once. The Anthropic tier ids
 * live in src/config (shared with the rest of the app); the non-Anthropic book
 * models are pipeline-local.
 *
 * The dedup council keeps its own copy in `scripts/dedup/council-models.json`
 * because it runs as plain `.mjs` and can't import this TS — if a flagship id
 * changes, update both (see the council-config-consolidation note in memory).
 */
export const BOOK_MODELS = {
  anthropic: config.models.bookWriter,
  anthropicFast: config.models.anthropicFast,
  openai: process.env.OPENAI_BOOK_MODEL || "gpt-5.5",
  openaiFast: process.env.OPENAI_BOOK_FAST_MODEL || "gpt-5-mini",
  // Both served by Fireworks (provider "fireworks") — the direct DeepSeek API
  // and OpenRouter were retired 2026-07-02 for multi-minute latencies.
  deepseek:
    process.env.DEEPSEEK_BOOK_MODEL ||
    "accounts/fireworks/models/deepseek-v4-pro",
  glm: process.env.GLM_BOOK_MODEL || "accounts/fireworks/models/glm-5p2",
} as const;

export interface BookLeg {
  provider: LlmProvider;
  model: string;
  /** Human display name — shown on the plan menu and stamped on the EPUB first page. */
  label: string;
  /**
   * Soft legs are skipped (with a warning) when their provider is unavailable at
   * preflight, instead of aborting the whole run. Policy: DeepSeek is the proven
   * core leg and stays hard; every other provider is soft so a single flaky or
   * unfunded account can't block a run.
   */
  soft?: boolean;
}

/**
 * The author legs for the model-comparison planner. Each leg produces
 * `CANDIDATES_PER_LEG` menu candidates, and a `--pick`'d candidate is WRITTEN
 * by its originating leg so finished tomos can be compared per model.
 */
export const PLANNER_LEGS: BookLeg[] = [
  { provider: "fireworks", model: BOOK_MODELS.deepseek, label: "DeepSeek" },
  { provider: "anthropic", model: BOOK_MODELS.anthropic, label: "Claude", soft: true },
  { provider: "openai", model: BOOK_MODELS.openai, label: "GPT", soft: true },
  { provider: "fireworks", model: BOOK_MODELS.glm, label: "GLM", soft: true },
];

export const CANDIDATES_PER_LEG = 2;

/** A human-readable "who wrote this" string, e.g. "DeepSeek (deepseek-v4-pro)". */
export function legByline(leg: { label: string; model: string }): string {
  return `${leg.label} (${leg.model})`;
}

/**
 * Provider for the pipeline's mechanical calls — verify, bilingual interleave,
 * current-state. Default "fireworks" (DeepSeek model, cost-effective, fast
 * serving). Override with BOOK_LLM_PROVIDER=anthropic (highest quality) or
 * =openai.
 *
 * This does NOT change who authors candidates — author legs are pinned per-leg
 * in PLANNER_LEGS. It only routes the model id the mechanical calls pass
 * through bookChat: BOOK_MODELS.anthropic for the verify tier,
 * BOOK_MODELS.anthropicFast for cheap calls.
 */
const BOOK_PROVIDER: LlmProvider = ((): LlmProvider => {
  switch (process.env.BOOK_LLM_PROVIDER?.toLowerCase()) {
    case "openai":
      return "openai";
    case "anthropic":
      return "anthropic";
    default:
      return "fireworks";
  }
})();

/**
 * Resolve the (provider, model) pair for a given anthropic-tier model id.
 * On the anthropic path this is a pass-through. On the fireworks path both
 * tiers collapse to the single DeepSeek model (no cheap mini tier). On the
 * openai path the fast tier (anthropicFast) maps to the mini model, everything
 * else (the writer/verify tier) maps to the writer model.
 */
function resolveModel(model: string): { provider: LlmProvider; model: string } {
  if (BOOK_PROVIDER === "anthropic") return { provider: "anthropic", model };
  if (BOOK_PROVIDER === "fireworks") {
    return { provider: "fireworks", model: BOOK_MODELS.deepseek };
  }
  const isFast = model === BOOK_MODELS.anthropicFast;
  return {
    provider: "openai",
    model: isFast ? BOOK_MODELS.openaiFast : BOOK_MODELS.openai,
  };
}

/** The leg the mechanical (verify/bilingual/current-state) calls resolve to. */
export function mechanicalLeg(): BookLeg {
  const { provider, model } = resolveModel(BOOK_MODELS.anthropicFast);
  return { provider, model, label: "mechanical" };
}

// ---------------------------------------------------------------------------
// LLM wrapper — every tomo LLM call goes through bookChat
// ---------------------------------------------------------------------------

const CHARS_PER_TOK = 4;
const TOK_INTERVAL = 500;
const CHARS_INTERVAL = TOK_INTERVAL * CHARS_PER_TOK;

export interface BookChatParams {
  /** Model id — e.g. BOOK_MODELS.anthropic (writer/verify tier) or anthropicFast (mechanical). */
  model: string;
  /**
   * Explicit provider override. When set, the (provider, model) pair is used
   * verbatim and the BOOK_LLM_PROVIDER tier-mapping is bypassed — this is how
   * the model-comparison planner/writer target a specific author leg
   * regardless of the global route.
   */
  provider?: LlmProvider;
  system: string;
  messages: ModelMessage[];
  maxTokens: number;
  /** 0 for deterministic classifiers; omit otherwise. Anthropic-only (others reject it). */
  temperature?: number;
  /**
   * gpt-5 family output-length dial (low|medium|high). Applied ONLY on the
   * openai provider — it's the first-class length control (gpt-5.5 defaults to
   * ~high and runs long). DeepSeek reaches the same SDK but doesn't honor it.
   */
  verbosity?: "low" | "medium" | "high";
  /** Ephemeral system caching. Default true (no-op below the provider's cache minimum). */
  cacheSystem?: boolean;
  /** Label for the progress/done log line. */
  label: string;
  /** Print the streaming token-rate progress line. Default false (long calls only). */
  progress?: boolean;
}

export interface BookChatResult {
  text: string;
  /** Provider finish reason — "stop"/"end_turn" = complete, "length" = hit maxTokens (truncated). */
  finishReason: string;
  outputTokens: number;
}

/**
 * Run one non-tool generation through the shared wrapper; return text +
 * metadata. `finishReason` lets callers detect truncation (a book cut off at
 * the token ceiling otherwise passes a naive word-count check, then ships
 * mid-sentence to the Kindle).
 */
export async function bookChatMeta(p: BookChatParams): Promise<BookChatResult> {
  const start = Date.now();
  let reported = 0;

  const { provider, model } = p.provider
    ? { provider: p.provider, model: p.model }
    : resolveModel(p.model);
  // GPT-5 and DeepSeek reasoning models reject any non-default temperature, so
  // drop it on every non-anthropic path (callers that set it want determinism,
  // not a specific value; default temp is acceptable for those one-offs).
  const temperature = provider === "anthropic" ? p.temperature : undefined;
  // textVerbosity is an OpenAI-only output-length control. Scope it to the
  // openai provider so it never reaches DeepSeek (same SDK, rejects the param).
  const providerOptions =
    provider === "openai" && p.verbosity
      ? { openai: { textVerbosity: p.verbosity } }
      : undefined;

  const res = await chat({
    provider,
    model,
    system: p.system,
    messages: p.messages,
    maxTokens: p.maxTokens,
    temperature,
    providerOptions,
    cacheSystem: p.cacheSystem ?? true,
    onTextDelta: p.progress
      ? (snapshot: string): void => {
          const chars = snapshot.length;
          while (chars - reported >= CHARS_INTERVAL) {
            reported += CHARS_INTERVAL;
            console.log(
              `      [${p.label}] +${TOK_INTERVAL} tok (~${Math.round(chars / CHARS_PER_TOK)} total, ${formatElapsed(Date.now() - start)} elapsed)`
            );
          }
        }
      : undefined,
  });

  const tok = res.usage.outputTokens ?? Math.round(res.text.length / CHARS_PER_TOK);
  console.log(
    `      [${p.label}] done — ${tok} output tok, ${res.finishReason}, ${formatElapsed(Date.now() - start)}`
  );
  return { text: res.text, finishReason: res.finishReason, outputTokens: tok };
}

/** Convenience wrapper: run one generation and return only its text. */
export async function bookChat(p: BookChatParams): Promise<string> {
  return (await bookChatMeta(p)).text;
}

/**
 * Fail-fast preflight: one minimal call per leg before an expensive fan-out.
 * Catches an exhausted credit balance or a rejected model param in ~2s.
 * Hard legs that are down THROW (abort the run); soft legs are skipped with a
 * warning so a flaky provider can't block the proven core. Returns live legs.
 */
export async function preflightLegs(legs: BookLeg[]): Promise<BookLeg[]> {
  const results = await Promise.allSettled(
    legs.map((leg) =>
      bookChat({
        provider: leg.provider,
        model: leg.model,
        system: "ping",
        messages: [{ role: "user", content: "ping" }],
        // Reasoning models spend the budget on reasoning tokens; a tiny ceiling
        // yields an empty/length reply that still returns 200 (callable).
        maxTokens: 32,
        label: `preflight:${leg.label}`,
      })
    )
  );

  const live: BookLeg[] = [];
  const hardDown: string[] = [];
  results.forEach((r, i) => {
    const leg = legs[i];
    if (r.status === "fulfilled") {
      live.push(leg);
      return;
    }
    const msg = errorMessage(r.reason);
    if (leg.soft) {
      console.warn(
        `[preflight] soft leg ${legByline(leg)} unavailable — skipping it this run (${msg})`
      );
    } else {
      hardDown.push(`  ✗ ${legByline(leg)} — ${msg}`);
    }
  });

  if (hardDown.length > 0) {
    throw new Error(
      `[preflight] ${hardDown.length} required leg(s) not callable:\n${hardDown.join("\n")}\n` +
        "  Top up the dead provider(s) and re-run. " +
        "Anthropic: console.anthropic.com → Plans & Billing · " +
        "OpenAI: platform.openai.com → Billing · " +
        "Fireworks: fireworks.ai → Billing."
    );
  }
  console.log(`[preflight] live legs: ${live.map((l) => l.label).join(", ")}`);
  return live;
}

// ---------------------------------------------------------------------------
// Candidate + plan file (shared contract between plan-tomo and write-tomo)
// ---------------------------------------------------------------------------

export const DOMAINS = [
  "neuroscience",
  "cognition",
  "cognitive science",
  "psychology",
  "philosophy",
  "hermeticism",
  "physics",
  "psychedelics",
  "ai",
] as const;

export type Domain = (typeof DOMAINS)[number];

// Single format since the "flow" format was retired — every tomo is an anchored
// essay. Kept as a field for history/epub compatibility.
export type TomoFormat = "essay";

export interface Candidate {
  id: number;
  format: TomoFormat;
  domain: Domain;
  topic: string;
  /** ONE specific domain mechanism the tomo teaches in depth (not a domain label). */
  mechanism_to_teach: string;
  angle: string;
  title: string;
  source_refs: string[];
  take: string;
  /** Set when the candidate engages an active series-queue vein (named by the planner). */
  series_vein?: string;
  /** Author leg that produced (and will write) this candidate. */
  provider?: LlmProvider;
  model?: string;
  /** Human label for the author leg, e.g. "DeepSeek" — shown on the menu + first page. */
  leg?: string;
  /** Plan-time overlap vs. recent tomos: max cosine similarity + which tomo. */
  overlap?: { score: number; against: string };
}

export interface SavedPlan {
  tomo_n: number;
  saved_at: string;
  candidates: Candidate[];
}

export async function savePlan(tomoN: number, candidates: Candidate[]): Promise<void> {
  const payload: SavedPlan = {
    tomo_n: tomoN,
    saved_at: new Date().toISOString(),
    candidates,
  };
  await atomicWriteJson(PLAN_PATH, payload);
}

/** Load the saved plan if it matches the expected next tomo number; else discard it. */
export async function loadSavedPlan(expectedTomoN: number): Promise<Candidate[] | null> {
  if (!existsSync(PLAN_PATH)) return null;
  const raw = await readFile(PLAN_PATH, "utf-8");
  const saved = JSON.parse(raw) as SavedPlan;
  if (saved.tomo_n !== expectedTomoN) {
    console.warn(
      `      stale ${PLAN_PATH} (saved for tomo ${saved.tomo_n}, next is ${expectedTomoN}) — ignoring`
    );
    await unlink(PLAN_PATH).catch(() => {});
    return null;
  }
  if (!Array.isArray(saved.candidates) || saved.candidates.length === 0) {
    console.warn(`      ${PLAN_PATH} has no candidates left — ignoring`);
    await unlink(PLAN_PATH).catch(() => {});
    return null;
  }
  return saved.candidates;
}

/** After a batch, drop successfully-written ids and point the plan at the next number. */
export async function updatePlanAfterBatch(
  writtenIds: number[],
  nextTomoN: number
): Promise<void> {
  if (!existsSync(PLAN_PATH)) return;
  const raw = await readFile(PLAN_PATH, "utf-8");
  const saved = JSON.parse(raw) as SavedPlan;
  const written = new Set(writtenIds);
  const remaining = saved.candidates.filter((c) => !written.has(c.id));
  if (remaining.length === 0) {
    await unlink(PLAN_PATH).catch(() => {});
    return;
  }
  await atomicWriteJson(PLAN_PATH, {
    tomo_n: nextTomoN,
    saved_at: saved.saved_at,
    candidates: remaining,
  } satisfies SavedPlan);
}

export async function clearSavedPlan(): Promise<void> {
  if (existsSync(PLAN_PATH)) await unlink(PLAN_PATH).catch(() => {});
}

// ---------------------------------------------------------------------------
// History (books/history.json)
// ---------------------------------------------------------------------------

// "flow"/"myth"/"fiction" are legacy values present in older history rows. New
// tomos write only "essay". Keep the broader union so old rows parse.
export type HistoryTomoFormat = "essay" | "flow" | "myth" | "fiction";

// Legacy domains appear in older history rows but are no longer valid choices.
type LegacyTomoDomain = "robotics" | "technology" | "mythology";
export type TomoDomain = Domain | LegacyTomoDomain;

export interface TomoRecord {
  n: number;
  title: string;
  format?: HistoryTomoFormat;
  domain: TomoDomain;
  topic: string;
  source_uuids: string[];
  date: string;
  word_count: number;
  /** Structural mold the writer was assigned (rotation memory for variety). */
  structure?: string;
  word_count_myth?: number;
  word_count_bridge?: number;
  series_seed?: boolean;
  bilingual?: boolean;
  myth_name?: string;
  shared_with_julia?: string;
  /** Author leg of the model-comparison flow: display label, provider, model id. */
  leg?: string;
  provider?: string;
  model?: string;
}

export async function readHistory(): Promise<TomoRecord[]> {
  if (!existsSync(HISTORY_PATH)) return [];
  const raw = await readFile(HISTORY_PATH, "utf-8");
  return JSON.parse(raw) as TomoRecord[];
}

// History writes are read-modify-write; the atomic rename prevents a concurrent
// reader from seeing a torn file. Callers still serialize appends within a batch
// (two concurrent PROCESSES can still lose an append — don't run two --pick
// batches at once).
export async function appendHistory(r: TomoRecord): Promise<void> {
  const h = await readHistory();
  h.push(r);
  await atomicWriteJson(HISTORY_PATH, h);
}

export async function updateHistory(n: number, patch: Partial<TomoRecord>): Promise<void> {
  const h = await readHistory();
  const idx = h.findIndex((r) => r.n === n);
  if (idx < 0) throw new Error(`updateHistory: tomo ${n} not in history`);
  h[idx] = { ...h[idx], ...patch };
  await atomicWriteJson(HISTORY_PATH, h);
}

export function nextTomoNumber(h: TomoRecord[]): number {
  if (h.length === 0) return 1;
  return Math.max(...h.map((r) => r.n)) + 1;
}

export function recentSourceUuids(h: TomoRecord[], n = 30): Set<string> {
  const out = new Set<string>();
  for (const tomo of h.slice(-n)) {
    for (const u of tomo.source_uuids) out.add(u);
  }
  return out;
}

export interface TomoSummary {
  n: number;
  title: string;
  topic: string;
  domain: string;
  structure?: string;
}

export function recentTomoSummaries(h: TomoRecord[], n = 30): TomoSummary[] {
  return h.slice(-n).map((r) => ({
    n: r.n,
    title: r.title,
    topic: r.topic,
    domain: r.domain,
    structure: r.structure,
  }));
}

// ---------------------------------------------------------------------------
// Context gathering (prod DB: entries + Reviews)
//
// Insights and tenets were deprecated as tomo sources on 2026-07-02 — the
// pipeline anchors on Reviews (evening/weekly/monthly/therapy syntheses) plus
// raw journal entries, nothing else.
// ---------------------------------------------------------------------------

export interface ContextItem {
  uuid: string;
  // "insight" never comes out of gatherContext/gatherLongArcContext anymore;
  // it survives only for fetchContextByUuid on saved plans that predate the
  // Reviews switch.
  kind: "entry" | "review" | "insight";
  date: string;
  title: string | null;
  text: string;
}

const MIN_ENTRY_CHARS = 120;
const LONG_ARC_DAYS = 365;

function sinceDateIso(daysBack: number): string {
  return new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
}

interface EntryRow {
  uuid: string;
  created_at: Date;
  text: string;
}

interface ArtifactRow {
  id: string;
  kind: ContextItem["kind"];
  title: string;
  body: string;
  updated_at: Date;
}

function entryItem(r: EntryRow): ContextItem {
  return {
    uuid: r.uuid,
    kind: "entry",
    date: r.created_at.toISOString().slice(0, 10),
    title: null,
    text: r.text,
  };
}

function artifactItem(r: ArtifactRow): ContextItem {
  return {
    uuid: r.id,
    kind: r.kind,
    date: r.updated_at.toISOString().slice(0, 10),
    title: r.title,
    text: r.body,
  };
}

export async function gatherContext(
  excludeUuids: Set<string>,
  daysBack = 14
): Promise<ContextItem[]> {
  const sinceDate = sinceDateIso(daysBack);
  const [entries, reviews] = await Promise.all([
    pool.query(
      `SELECT uuid, created_at, text
       FROM entries
       WHERE created_at >= $1
         AND char_length(text) >= $2
       ORDER BY created_at DESC`,
      [sinceDate, MIN_ENTRY_CHARS]
    ),
    pool.query(
      `SELECT id, kind, title, body, updated_at
       FROM knowledge_artifacts
       WHERE kind = 'review'
         AND deleted_at IS NULL
         AND (source_path IS NULL OR source_path NOT LIKE '%Pending/%')
         AND updated_at >= $1
       ORDER BY updated_at DESC`,
      [sinceDate]
    ),
  ]);

  // The history exclusion window applies to ENTRIES only. A Review is dense —
  // one weekly can anchor ten different tomos — so being picked once must not
  // bench it for 30 tomos; angle-level repetition is the overlap score's job.
  return [
    ...(entries.rows as EntryRow[]).filter((r) => !excludeUuids.has(r.uuid)).map(entryItem),
    ...(reviews.rows as ArtifactRow[]).map(artifactItem),
  ];
}

export async function gatherLongArcContext(
  excludeRecentUuids: Set<string>,
  daysBack = LONG_ARC_DAYS
): Promise<ContextItem[]> {
  const artifacts = await pool.query(
    `SELECT id, kind, title, body, updated_at
     FROM knowledge_artifacts
     WHERE kind = 'review'
       AND deleted_at IS NULL
       AND (source_path IS NULL OR source_path NOT LIKE '%Pending/%')
       AND updated_at >= $1
     ORDER BY updated_at DESC`,
    [sinceDateIso(daysBack)]
  );
  // excludeRecentUuids only dedupes vs the recent block; the history exclusion
  // window deliberately does NOT apply to Reviews (see gatherContext).
  return (artifacts.rows as ArtifactRow[])
    .filter((r) => !excludeRecentUuids.has(r.id))
    .map(artifactItem);
}

export async function fetchContextByUuid(uuids: string[]): Promise<ContextItem[]> {
  if (uuids.length === 0) return [];
  const [entries, artifacts] = await Promise.all([
    pool.query(
      `SELECT uuid, created_at, text FROM entries WHERE uuid = ANY($1::text[])`,
      [uuids]
    ),
    // Any kind on purpose — saved plans may reference artifacts (including
    // legacy insights) that the gather functions no longer source.
    pool.query(
      `SELECT id, kind, title, body, updated_at
       FROM knowledge_artifacts
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [uuids]
    ),
  ]);
  return [
    ...(entries.rows as EntryRow[]).map(entryItem),
    ...(artifacts.rows as ArtifactRow[]).map(artifactItem),
  ];
}

/**
 * Recent raw journal entries (all languages), most-recent first, for the
 * post-draft verifier's ground-truth window. Unlike gatherContext this applies
 * no exclusion set and no artifact join — the verifier wants the unfiltered
 * recent record so it can catch staleness (e.g. a breakup the source Review
 * predates) and unsupported specifics.
 */
export async function fetchRecentEntries(
  daysBack = 21
): Promise<{ date: string; text: string }[]> {
  const res = await pool.query(
    `SELECT created_at, text
       FROM entries
      WHERE created_at >= $1
        AND char_length(text) >= $2
      ORDER BY created_at DESC`,
    [sinceDateIso(daysBack), MIN_ENTRY_CHARS]
  );
  return (res.rows as EntryRow[]).map((r) => ({
    date: r.created_at.toISOString().slice(0, 10),
    text: r.text,
  }));
}

/** Render context items the way the planner/writer/verifier prompts expect. */
export function renderContextItems(items: ContextItem[], maxChars: number): string {
  if (items.length === 0) return "(none)";
  return items
    .map((c) => {
      const head = `[${c.kind}:${c.uuid}] ${c.date}${c.title ? " — " + c.title : ""}`;
      return `${head}\n${c.text.slice(0, maxChars)}`;
    })
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Current-state ground truth (staleness guard)
// ---------------------------------------------------------------------------

const CURRENT_STATE_SYSTEM = `You read a few weeks of one person's (Mitch's) raw journal entries and produce a SHORT "current state" snapshot — the ground truth a months-old Review would get wrong. Downstream this overrides stale framing, so accuracy and recency matter more than completeness.

Output compact markdown, this shape:

## People
- **<name>** — <current | ended <date if stated> | unclear>. <one clause of status: dating, broke up, friend, etc.>

## Threads
- <live situation — work, health, location, a recurring craving/struggle — with status>

Hard rules:
- ONLY state what the entries support. If the entries don't establish a person's current status, either omit them or mark "unclear" — never guess.
- A relationship the entries show as ENDED must be marked ended (with the date if given), NOT carried forward as live. This is the single most important job: catch breakups, moves, job changes, resolved cravings.
- Most-recent signal wins when entries conflict.
- Be terse — facts, not prose. No preamble, no "based on the entries". 12 lines max.
- If there genuinely isn't enough to say, output exactly: (insufficient recent signal)`;

/**
 * Derive the current-state block from recent journal entries via one cheap
 * call. It's a soft prior for the planner/writer; the verifier (which reads
 * the raw entries directly) is the hard backstop. Returns "" on too few
 * entries or an empty/"insufficient" model result.
 */
export async function deriveCurrentState(daysBack = 30): Promise<string> {
  const entries = await fetchRecentEntries(daysBack);
  if (entries.length < 3) return "";

  const corpus = entries
    .map((e) => `[${e.date}]\n${e.text.slice(0, 1500)}`)
    .join("\n\n---\n\n");

  const text = await bookChat({
    model: BOOK_MODELS.anthropicFast,
    system: CURRENT_STATE_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Recent journal entries (last ${daysBack} days, newest first). Produce the current-state snapshot.\n\n${corpus}`,
      },
    ],
    // The mechanical route defaults to DeepSeek (a reasoning model) whose
    // thinking tokens bill against this same cap — at 700 it spent the whole
    // budget reasoning and returned empty text, silently disabling the
    // staleness guard (observed 2026-07-02). The snapshot itself stays ≤12
    // lines; the headroom is for reasoning.
    maxTokens: 4000,
    temperature: 0,
    label: "current-state",
  });

  const trimmed = text.trim();
  if (!trimmed || /^\(insufficient recent signal\)$/i.test(trimmed)) return "";
  return trimmed;
}

/** The current-state framing block shared by the planner and writer prompts. */
export function formatCurrentStateBlock(currentState: string): string[] {
  if (!currentState.trim()) return [];
  return [
    "# Current state — ground truth (derived from the reader's most recent journal entries)",
    "Who is current vs. past and the live status of each thread, distilled from the reader's latest entries. Because it is built from newer data than the source material, it OVERRIDES stale framing there: if a source describes a relationship or need as live but this block says it has ended, write it in the past tense.",
    "",
    currentState.trim(),
    "",
  ];
}

// ---------------------------------------------------------------------------
// Prompt-doc marker blocks (SERIES QUEUE)
// ---------------------------------------------------------------------------

/**
 * Return the text between `<!-- BEGIN <name>` and `<!-- END <name>`, excluding
 * the marker lines themselves. The match is prefix-based, so the markers may
 * carry a trailing comment. Returns "" when either marker is missing.
 */
export function extractMarkedBlock(text: string, name: string): string {
  const start = text.indexOf(`<!-- BEGIN ${name}`);
  const end = text.indexOf(`<!-- END ${name}`);
  if (start === -1 || end === -1 || end < start) return "";
  const blockStart = text.indexOf("\n", start) + 1;
  return text.slice(blockStart, end);
}

/** Read the SERIES QUEUE block Mitch hand-edits inside the Tomo prompt doc. */
export async function readSeriesQueue(path: string = TOMO_PROMPT_PATH): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return "";
  }
  return extractMarkedBlock(text, "SERIES QUEUE").trim();
}

// ---------------------------------------------------------------------------
// Tilde-slip scan (post-write sanity check; warnings, not blockers)
// ---------------------------------------------------------------------------

/**
 * High-confidence tilde-missing offenders. Limited to words where the
 * unaccented form has no valid Spanish meaning in body prose, so the regex
 * yields no false positives. `mas`/`como`/`mi`/`tu`/`si` are deliberately
 * excluded because they have valid unaccented readings.
 */
const TILDE_PROBES: Array<{ wrong: RegExp; right: string }> = [
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
      hits.push({ word: matches[0], correction: probe.right, count: matches.length });
    }
  }
  return { hits };
}

// ---------------------------------------------------------------------------
// Tomo markdown structure
// ---------------------------------------------------------------------------

export interface TomoParts {
  title: string;
  body: string;
  takeaways: string;
  nota: string;
}

export function splitTomo(markdown: string): TomoParts {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const withoutTitle = markdown.replace(/^#\s+.+\n?/, "");

  // Raw Spanish source uses "## Para llevarte"; the bilingual pass renames the
  // section to English-only "## Takeaways". splitTomo runs on both, so match
  // either. "## Reader notes" is a retired section still on disk in old tomos.
  const takeawaysIdx = withoutTitle.search(/^##\s+(?:Para llevarte|Takeaways)\s*$/m);
  const notaIdx = withoutTitle.search(/^##\s+Reader notes\s*$/m);

  if (takeawaysIdx === -1 && notaIdx === -1) {
    return { title, body: withoutTitle.trim(), takeaways: "", nota: "" };
  }
  if (takeawaysIdx === -1) {
    return {
      title,
      body: withoutTitle.slice(0, notaIdx).trim(),
      takeaways: "",
      nota: withoutTitle.slice(notaIdx).trim(),
    };
  }
  if (notaIdx === -1) {
    return {
      title,
      body: withoutTitle.slice(0, takeawaysIdx).trim(),
      takeaways: withoutTitle.slice(takeawaysIdx).trim(),
      nota: "",
    };
  }
  return {
    title,
    body: withoutTitle.slice(0, takeawaysIdx).trim(),
    takeaways: withoutTitle.slice(takeawaysIdx, notaIdx).trim(),
    nota: withoutTitle.slice(notaIdx).trim(),
  };
}

/** Spanish body words, excluding the title, headings, and "## Para llevarte". */
export function countWords(markdown: string): number {
  const stripped = splitTomo(markdown).body.replace(/^##\s.+$/gm, "").trim();
  if (stripped.length === 0) return 0;
  return stripped.split(/\s+/).filter((w) => w.length > 0).length;
}

// ---------------------------------------------------------------------------
// Bilingual interleave (faithful, readable ES↔EN)
// ---------------------------------------------------------------------------

const BILINGUAL_SYSTEM = `You are producing a FAITHFUL, READABLE bilingual study version of a Spanish text for a fluent reader. Each Spanish sentence is paired with an English line that stays close to the Spanish — so the reader can map one to the other — but reads like careful, natural English a person would actually write.

For every Spanish sentence, output the Spanish sentence on its own line, then on the NEXT line its English translation wrapped in single asterisks for italics. The two lines form one pair; separate pairs with a blank line.

The English is FAITHFUL but READABLE — close to the source, never mechanical:
- Track the Spanish closely: keep its clause order, emphasis, and register where natural English tolerates it. But when literal order would be awkward, reorder for readable English. Readability wins over mirroring word order.
- Translate meaning, not tokens. Do NOT surface grammatical mechanics with bracket-glosses or hyphenated word-for-word renderings. Examples:
  - "Llevo años haciéndolo" → "I've been doing it for years" (NOT "I carry years doing it").
  - "Quiero que vengas" → "I want you to come" (NOT "I want [that] you come").
  - "Se me cayó el vaso" → "I dropped the glass" / "The glass slipped from my hands" (NOT "[itself] to-me it-fell").
  - "No lo hice por miedo, sino por amor" → "I didn't do it out of fear, but out of love".
- Keep por/para and similar distinctions only when they change the meaning and natural English would carry the distinction anyway ("because of you" vs "for you") — don't contort the sentence to flag grammar.
- Render idioms with their natural English equivalent, not a literal calque.
- The result must read as fluent, faithful English: no brackets, no hyphenated literal compounds, no salad. Smooth to natural English while keeping the meaning and feel of the Spanish.

Rules:
- Headings ("# ..." and "## ...") are kept EXACTLY as written, Spanish only, on their own line. Do NOT translate them, do NOT add an English line after them. (In particular "## Para llevarte" must survive verbatim.)
- Body paragraphs: split into sentences; each Spanish sentence becomes a pair (ES line, italic EN line), pairs separated by a blank line.
- Bullets ("- ..."): keep the "- " prefix on the Spanish line; put the italic English on the next line indented by two spaces ("  *...*"). Separate bullets with a blank line.
- Treat short interjections, fragments, and quoted speech as their own sentence pairs.
- Output pure markdown. No preamble, no commentary, no closing note. Process the input block by block in order.

Example body pairs:

El mapa vive en tu cabeza.
*The map lives in your head.*

No lo hice por miedo, sino por amor.
*I didn't do it out of fear, but out of love.*

Example heading (unchanged, no English line):

## Para llevarte

Example bullet:

- El cerebro no percibe la realidad directamente.
  *The brain does not perceive reality directly.*`;

// The "## Para llevarte" takeaways are rendered English-only (renamed
// "## Takeaways") so the reader can confirm they understood the book without
// the Spanish carrying them.
const TAKEAWAYS_SYSTEM = `You translate the takeaways section of a Spanish essay into natural English so a learner can check their comprehension.

Input is a "## Para llevarte" heading followed by Spanish bullet points.

Output:
- First line: exactly "## Takeaways" (translate the heading to this).
- Then a blank line.
- Then one English bullet per input bullet, each starting with "- ".
- Natural, idiomatic, fluent English — convey the meaning clearly. This is a comprehension check, NOT a literal/structural gloss. Do not include the Spanish, do not add asterisks/italics.
- Preserve the order and count of the bullets. No preamble, no commentary.`;

const CHUNK_WORD_BUDGET = 800;

/** Split markdown into chunks of whole blocks under a word budget, preserving order. */
export function chunkMarkdown(markdown: string, wordBudget = CHUNK_WORD_BUDGET): string[] {
  const blocks = markdown.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  const wc = (s: string): number => s.split(/\s+/).filter((w) => w.length > 0).length;
  for (const block of blocks) {
    const bw = wc(block);
    if (current.length > 0 && words + bw > wordBudget) {
      chunks.push(current.join("\n\n"));
      current = [];
      words = 0;
    }
    current.push(block);
    words += bw;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks;
}

/**
 * Guarantee every English translation line is wrapped in `*...*` italics. The
 * bilingual model occasionally drops the asterisks for a whole chunk (observed
 * in tomos 0064 and 0066), which renders the English as plain text on the
 * Kindle. The output format is strict ES/EN pairs separated by blank lines, so
 * within each non-heading block the English lines sit at odd indices. We
 * re-wrap any that the model left bare. Deterministic — no extra LLM call.
 */
export function ensureItalics(bilingualBody: string): string {
  return bilingualBody
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      // Headings stay verbatim, no English line beneath them.
      if (/^#{1,6}\s/.test(lines[0].trim())) return block;
      // Only normalize clean ES/EN pair blocks (even line count). Odd-length
      // blocks don't pair cleanly, so leave them rather than mis-wrap a line.
      if (lines.length === 0 || lines.length % 2 !== 0) return block;
      return lines.map((line, i) => (i % 2 === 1 ? wrapItalic(line) : line)).join("\n");
    })
    .join("\n\n");
}

/** Wrap a single English line in `*...*`, preserving indent; no-op if already italic or empty. */
function wrapItalic(line: string): string {
  const trailing = line.match(/\s*$/)?.[0] ?? "";
  const trimmed = line.replace(/\s+$/, "");
  const indentMatch = trimmed.match(/^(\s*)(.*)$/);
  const indent = indentMatch?.[1] ?? "";
  const content = indentMatch?.[2] ?? "";
  if (content === "") return line;
  if (content.startsWith("*") && content.endsWith("*") && content.length >= 2) return line;
  return `${indent}*${content}*${trailing}`;
}

/**
 * Interleave a Spanish tomo with faithful English. Done in chunks: the output
 * is ~2x the input (ES + EN for every sentence), so a whole book in one call
 * would blow the token ceiling and truncate mid-book. Chunks are
 * order-independent → translated in parallel and reassembled in order.
 */
export async function interleave(markdown: string): Promise<string> {
  // Split the Spanish "## Para llevarte" takeaways off the body: the body gets
  // the ES/EN interleave; the takeaways become English-only.
  const takeawaysIdx = markdown.search(/^##\s+Para llevarte\s*$/m);
  const bodyMarkdown =
    takeawaysIdx === -1 ? markdown : markdown.slice(0, takeawaysIdx).trimEnd();
  const takeawaysMarkdown =
    takeawaysIdx === -1 ? "" : markdown.slice(takeawaysIdx).trim();

  const chunks = chunkMarkdown(bodyMarkdown);
  console.log(
    `      [bilingual] ${chunks.length} chunk(s), up to ${CHUNK_CONCURRENCY} in parallel`
  );
  const translated = await mapWithConcurrencyStrict(
    chunks,
    CHUNK_CONCURRENCY,
    async (chunk, i) => {
      // The bilingual output is ~2x the input. Reasoning models bill their
      // reasoning tokens against this same ceiling: the gpt-5 fast tier
      // truncated 800-word chunks at a 4000 cap (tomos 0068-0071), and
      // deepseek-v4-pro tipped an 800-word chunk over an 8000 cap on a denser
      // tomo (0082). Give it writer-level headroom AND fail loud on truncation
      // — a dropped tail used to ship silently because finishReason was ignored.
      const { text, finishReason } = await bookChatMeta({
        model: BOOK_MODELS.anthropicFast,
        system: BILINGUAL_SYSTEM,
        messages: [{ role: "user", content: chunk }],
        maxTokens: 16000,
        label: `bilingual.${i + 1}/${chunks.length}`,
      });
      if (finishReason === "length") {
        throw new Error(
          `bilingual chunk ${i + 1}/${chunks.length} hit the token ceiling (truncated). ` +
            `Lower CHUNK_WORD_BUDGET or raise maxTokens — refusing to ship a partial interleave.`
        );
      }
      return text.trim();
    }
  );
  const body = ensureItalics(translated.join("\n\n"));

  if (!takeawaysMarkdown) return body + "\n";
  const takeaways = await bookChat({
    model: BOOK_MODELS.anthropicFast,
    system: TAKEAWAYS_SYSTEM,
    messages: [{ role: "user", content: takeawaysMarkdown }],
    // Reasoning headroom for the DeepSeek mechanical route (same failure class
    // as current-state/verify: thinking tokens bill against this cap).
    maxTokens: 6000,
    label: "bilingual.takeaways",
  });
  return `${body}\n\n${takeaways.trim()}\n`;
}

// ---------------------------------------------------------------------------
// EPUB build + Kindle send
// ---------------------------------------------------------------------------

const SERIES_NAME = "Espejo";

export interface EpubOptions {
  tomoNum: number;
  title: string;
  markdown: string;
  outPath: string;
  /** Author byline for the model-comparison flow, e.g. "DeepSeek (deepseek-v4-pro)". */
  model?: string;
}

export async function buildEpub(opts: EpubOptions): Promise<void> {
  const { tomoNum, title, markdown, outPath, model } = opts;

  const { body, takeaways } = splitTomo(markdown);
  // `breaks: true` turns a single newline into a <br>, so each bilingual pair
  // (Spanish line + English line) renders as two visible lines on the Kindle
  // instead of collapsing into one run-on paragraph.
  const parsedBody = await marked.parse(body, { breaks: true });
  // Stamp the author model on the first page (model-comparison flow).
  const bylineHtml = model
    ? `<p style="font-style:italic;opacity:0.7">Escrito por ${escapeHtml(model)}</p>\n`
    : "";
  const bodyHtml = bylineHtml + parsedBody;

  // Strip the section heading line — the chapter title supplies it. The
  // bilingual pass renames "## Para llevarte" to English "## Takeaways"; match
  // either so direct (non-bilingual) builds still work.
  const takeawaysBody = takeaways
    .replace(/^##\s+(?:Para llevarte|Takeaways)\s*\n?/m, "")
    .trim();
  const takeawaysHtml = takeawaysBody
    ? await marked.parse(takeawaysBody, { breaks: true })
    : "";

  const padded = paddedTomo(tomoNum);
  const chapters = [{ title, content: bodyHtml }];
  if (takeawaysHtml) chapters.push({ title: "Takeaways", content: takeawaysHtml });
  // Trailing colophon chapter — gives Kindle a definite "next page" target so
  // swiping past the last takeaway triggers the end-of-book read marker instead
  // of stalling at 100%.
  chapters.push({ title: "Fin", content: colophonHtml(tomoNum, title) });

  const epub = new EPub(
    {
      title: `${SERIES_NAME} — Tomo ${padded} — ${title}`,
      author: SERIES_NAME,
      lang: "es",
      description: `Tomo ${tomoNum} — ${title}`,
      tocTitle: "Índice",
      contentOPF: opfTemplate(tomoNum),
    },
    chapters
  );

  const buffer = await epub.genEpub();
  await mkdir(BUILD_DIR, { recursive: true });
  await writeFile(outPath, buffer);
}

export function tomoFilename(tomoNum: number, title: string): string {
  return `Espejo Tomo ${paddedTomo(tomoNum)} - ${slugify(title)}.epub`;
}

export async function sendToKindle(params: {
  epubPath: string;
  filename: string;
  subject: string;
}): Promise<void> {
  await sendEmail({
    to: config.gmail.kindleEmail,
    subject: params.subject,
    text: params.subject,
    attachments: [
      {
        filename: params.filename,
        path: params.epubPath,
        contentType: "application/epub+zip",
      },
    ],
  });
}

function colophonHtml(tomoNum: number, title: string): string {
  return [
    `<div style="text-align: center; margin-top: 40%;">`,
    `<p style="font-size: 1.4em; letter-spacing: 0.2em;">~ Fin ~</p>`,
    `<p style="margin-top: 2em; font-style: italic;">${SERIES_NAME} · Tomo ${paddedTomo(tomoNum)}</p>`,
    `<p style="font-style: italic;">${escapeHtml(title)}</p>`,
    `</div>`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
}

// Custom OPF template, derived from epub-gen-memory's epub3 default with
// Calibre-style series metadata + EPUB3 belongs-to-collection injected so
// Kindle groups personal-doc tomos into a single series collection.
function opfTemplate(tomoNum: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf"
         version="3.0"
         unique-identifier="BookId"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:dcterms="http://purl.org/dc/terms/"
         xml:lang="en"
         xmlns:media="http://www.idpf.org/epub/vocab/overlays/#"
         prefix="ibooks: http://vocabulary.itunes.apple.com/rdf/ibooks/vocabulary-extensions-1.0/">

    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"
              xmlns:opf="http://www.idpf.org/2007/opf">

        <dc:identifier id="BookId"><%= id %></dc:identifier>
        <meta refines="#BookId" property="identifier-type" scheme="onix:codelist5">22</meta>
        <meta property="dcterms:identifier" id="meta-identifier">BookId</meta>
        <dc:title><%= title %></dc:title>
        <meta property="dcterms:title" id="meta-title"><%= title %></meta>
        <dc:description><%= description %></dc:description>
        <dc:language><%= lang %></dc:language>
        <meta property="dcterms:language" id="meta-language"><%= lang %></meta>
        <meta property="dcterms:modified"><%= (new Date()).toISOString().split(".")[0]+ "Z" %></meta>
        <dc:creator id="creator"><%= author.join(",") %></dc:creator>
        <meta refines="#creator" property="file-as"><%= author.join(",") %></meta>
        <meta property="dcterms:publisher"><%= publisher %></meta>
        <dc:publisher><%= publisher %></dc:publisher>
        <meta property="dcterms:date"><%= date %></meta>
        <dc:date><%= date %></dc:date>
        <meta property="dcterms:rights">All rights reserved</meta>
        <dc:rights>Copyright &#x00A9; <%= (new Date()).getFullYear() %> by <%= publisher %></dc:rights>
        <% if(cover) { %>
        <meta name="cover" content="image_cover"/>
        <% } %>
        <meta name="generator" content="epub-gen" />
        <meta property="ibooks:specified-fonts">true</meta>

        <meta property="belongs-to-collection" id="series-id">${SERIES_NAME}</meta>
        <meta refines="#series-id" property="collection-type">series</meta>
        <meta refines="#series-id" property="group-position">${tomoNum}</meta>
        <meta name="calibre:series" content="${SERIES_NAME}"/>
        <meta name="calibre:series_index" content="${tomoNum}"/>

    </metadata>

    <manifest>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
        <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav" />
        <item id="css" href="style.css" media-type="text/css" />

        <% if(cover) { %>
        <item id="image_cover" href="cover.<%= cover.extension %>" media-type="<%= cover.mediaType %>" />
        <% } %>

        <% images.forEach(function(image, index){ %>
        <item id="image_<%= index %>" href="images/<%= image.id %>.<%= image.extension %>" media-type="<%= image.mediaType %>" />
        <% }) %>

        <% content.forEach(function(content, index){ %>
        <item id="content_<%= index %>_<%= content.id %>" href="<%= content.filename %>" media-type="application/xhtml+xml" />
        <% }) %>

        <% fonts.forEach(function(font, index){%>
        <item id="font_<%= index%>" href="fonts/<%= font.filename %>" media-type="<%= font.mediaType %>" />
        <%})%>
    </manifest>

    <spine toc="ncx">
        <% content.forEach(function(content, index){ %>
            <% if(content.beforeToc){ %>
                <itemref idref="content_<%= index %>_<%= content.id %>"/>
            <% } %>
        <% }) %>
        <itemref idref="toc" />
        <% content.forEach(function(content, index){ %>
            <% if(!content.beforeToc){ %>
                <itemref idref="content_<%= index %>_<%= content.id %>"/>
            <% } %>
        <% }) %>
    </spine>
    <guide>
        <reference type="text" title="Table of Content" href="toc.xhtml"/>
    </guide>
</package>`;
}

// ---------------------------------------------------------------------------
// Embedding overlap (plan-time anti-repetition scoring)
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embed many short texts with a concurrency cap (text-embedding-3-small). */
export async function embedManyTexts(texts: string[]): Promise<number[][]> {
  return mapWithConcurrencyStrict(texts, 8, (t) => embedTextSimple(t));
}
