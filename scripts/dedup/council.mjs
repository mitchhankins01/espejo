#!/usr/bin/env node
/**
 * Dedup Stage 2 — council fan-out. Runs Claude Opus, Gemini 2.5 Pro, and
 * GPT-5.5 (codex) in parallel on /tmp/dedup-plan.json, writes per-leg JSON
 * arrays to /tmp/council/dedup/<stamp>/.
 *
 * Usage:
 *   pnpm dedup:council [--plan /tmp/dedup-plan.json] [--include-ollama]
 *
 * Output:
 *   /tmp/council/dedup/<stamp>/{claude,gemini,gpt}.parsed.json
 *   /tmp/council/dedup/<stamp>/manifest.json   (paths + leg statuses)
 *   stdout: the manifest path (used by dedup:synth)
 *
 * Bakes in 2026-04-26 fixes:
 *   - GPT chunking (12 items per call) — codex truncates output past ~12 items
 *   - Strip ```json fences from Gemini
 *   - Strip trailing "Confidence: …" line from all legs before JSON.parse
 *   - Read GEMINI_API_KEY directly from .env.production.local (not via shell
 *     `source` — one bad line in .env breaks the whole sourcing)
 *   - Tolerate per-leg failures (don't kill the run if one model 403s)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes(n);

const PLAN_PATH = arg("--plan") || "/tmp/dedup-plan.json";
const INCLUDE_OLLAMA = has("--include-ollama");
const GPT_CHUNK_SIZE = Number(arg("--gpt-chunk") || "12");

if (!existsSync(PLAN_PATH)) {
  console.error(`Plan file not found: ${PLAN_PATH}`);
  console.error(`Run \`pnpm dedup:retrieve --mode pending > /tmp/dedup-plan.json\` first.`);
  process.exit(1);
}

const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const outDir = `/tmp/council/dedup/${stamp}`;
mkdirSync(outDir, { recursive: true });

const itemCount = plan.plan?.length || 0;
console.error(`[council] Plan: ${itemCount} sources from ${PLAN_PATH}`);
console.error(`[council] Output dir: ${outDir}`);

// ─── env loading (resilient to broken .env lines) ───────────────────────────

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}
const env = { ...readEnvFile(".env"), ...readEnvFile(".env.production.local"), ...process.env };

// Model ids — overridable via env, mirrors defaults in src/config.ts (config.models.dedupCouncil*)
const CLAUDE_MODEL = env.DEDUP_COUNCIL_CLAUDE_MODEL || "claude-opus-4-8";
const GEMINI_MODEL = env.DEDUP_COUNCIL_GEMINI_MODEL || "gemini-3.1-pro-preview";
const GPT_MODEL = env.DEDUP_COUNCIL_GPT_MODEL || "gpt-5.5";

// ─── wrapper prompt ─────────────────────────────────────────────────────────

// Read Parts.md verbatim so the classifier can resolve part-name aliases
// (e.g. "watchtower" == "The Self-Monitor"). Vocabulary drift across reviews
// otherwise produces near-duplicate insights that look distinct under embedding
// + RRF retrieval. Graceful no-op if file is missing.
function loadPartsContext() {
  const path = "Artifacts/Note/Parts.md";
  if (!existsSync(path)) return "";
  const body = readFileSync(path, "utf8");
  return `\n## Parts-of-self database (treat aliases as same referent)\n\nWhen a pair uses different vocabulary for the same part (e.g. one says "watchtower", the other says "The Self-Monitor"), they are talking about the same referent. Use the database below to resolve aliases and recognize when insights belong to the same part even when phrasing differs.\n\n${body}\n`;
}

const PARTS_CONTEXT = loadPartsContext();

const WRAPPER = `You are classifying candidate insight pairs for a vault dedup workflow.

Input: a JSON file embedded below (the "INPUT DATA" section). Each entry under \`.plan[]\` pairs a "source" insight (a Pending file) with up to 10 "candidates" from Insight/ OR Pending/ ordered by hybrid RRF score. Bodies are full text. Cosine distance is provided when available.

For EACH source × top-candidate pair, classify the relationship:

- **Duplicate** — candidate already says what source says (paraphrase or restatement); source adds no meaningful new detail, evidence, attribution, framing, or precision. Action: delete source, keep candidate.
- **Merge** — candidate covers the same core idea, but source genuinely adds detail, evidence, attribution, fresh angle, or precision the candidate lacks. Action: rewrite the candidate to integrate source's unique content while preserving its atomic shape, union the source wikilinks, delete source. **The vault is years old; insights should accrete, not multiply.**
- **Distinct** — genuinely orthogonal idea: different core claim, different mechanism, or different domain with no shared anchor. Action: leave both. Promote the source to Insight/ as-is.

Only consider the TOP candidate per source unless multiple candidates have RRF scores within 10% of the top.

**Two boundaries, two different biases — apply them independently:**

1. **Distinct ↔ Merge** (the consequential one). Prefer **Merge** when the source shares ANY core claim, mechanism, or domain anchor with the candidate — *even if the framing or scope differs* — provided the source contributes something the candidate doesn't already say. Reserve **Distinct** for genuinely orthogonal ideas with no overlap. Mitch wants insights to remain atomic but also to consolidate over time as the corpus grows; Distinct should not be the safe default for near-misses.

2. **Duplicate ↔ Merge**. The test is whether the source contributes *new differentiating content*. If the source is a near-paraphrase that adds nothing — same claim, same scope, same evidence, same examples — classify as **Duplicate** even though the merge bias above might tempt you. The bias only applies at the Distinct↔Merge boundary; it does not push Duplicates into Merges. A Merge that fabricates new content from a true paraphrase is worse than a clean Duplicate.

Think carefully about each pair before classifying — both boundaries are consequential, but they call for opposite default behaviors.

Output ONE JSON array, one object per source. Schema:

[
  {
    "source_path": "Pending/X.md",
    "classification": "Duplicate" | "Merge" | "Distinct",
    "target_path": "Insight/Y.md" | "Pending/Y.md" | null,
    "rationale": "<1-3 sentences citing specific overlap or distinction>",
    "merge_body": "<full proposed canonical body if Merge, else null>",
    "confidence": "low" | "medium" | "high"
  }
]

End with a single line OUTSIDE the JSON: "Confidence: low | medium | high — <one sentence>"
${PARTS_CONTEXT}
----- INPUT DATA -----
`;

// ─── output cleanup helpers ─────────────────────────────────────────────────

function extractJsonArray(text) {
  // Strip ```json ... ``` fences
  let t = text.replace(/```(?:json)?\s*\n([\s\S]*?)\n```/g, "$1");
  // Find the first [ … ] balanced array
  const start = t.indexOf("[");
  if (start === -1) return null;
  let depth = 0, end = -1;
  for (let i = start; i < t.length; i++) {
    if (t[i] === "[") depth++;
    else if (t[i] === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function buildInput(planSubset) {
  return WRAPPER + JSON.stringify({ ...plan, plan: planSubset }, null, 2);
}

// ─── leg runners ────────────────────────────────────────────────────────────

const LEG_TIMEOUT_MS = Number(env.DEDUP_COUNCIL_TIMEOUT_MS || 10 * 60 * 1000);

function runProc(cmd, argv, stdinText, envOverride = {}, timeoutMs = LEG_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, argv, { env: { ...env, ...envOverride } });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    }, timeoutMs);
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -2 : code,
        stdout,
        stderr: timedOut ? `${stderr}\n[killed: timeout after ${Math.round(timeoutMs/1000)}s]` : stderr,
      });
    });
    proc.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err) }); });
    if (stdinText) { proc.stdin.write(stdinText); proc.stdin.end(); }
    else { proc.stdin.end(); }  // codex blocks forever on open-but-empty stdin
  });
}

// Each leg accepts an optional planSubset so the orchestration loop can retry
// just the dropped items. Returns the parsed array (or {ok:false, error}); the
// caller is responsible for writing the final per-leg parsed.json (after
// merging initial + retry results).

async function legClaude(items = plan.plan, rawSuffix = "") {
  const input = buildInput(items);
  console.error(`[council] claude: launching (${items.length} items${rawSuffix ? ` ${rawSuffix}` : ""})`);
  const r = await runProc("claude", [
    "-p", "--model", CLAUDE_MODEL, "--dangerously-skip-permissions", input,
  ], null);
  writeFileSync(`${outDir}/claude${rawSuffix}.raw.txt`, r.stdout);
  if (r.code !== 0) return { ok: false, error: r.stderr || `exit ${r.code}` };
  const arr = extractJsonArray(r.stdout);
  if (!arr) return { ok: false, error: "JSON parse failed", raw: r.stdout.slice(0, 200) };
  console.error(`[council] claude${rawSuffix}: ${arr.length} items`);
  return { ok: true, parsed: arr };
}

async function legGemini(items = plan.plan, rawSuffix = "") {
  if (!env.GEMINI_API_KEY) return { ok: false, error: "GEMINI_API_KEY not set" };
  const input = buildInput(items);
  console.error(`[council] gemini: launching (${items.length} items${rawSuffix ? ` ${rawSuffix}` : ""})`);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: input }] }],
    generationConfig: {
      maxOutputTokens: 65536,
      // thinkingBudget: -1 = dynamic (model decides). For pair-classification
      // we want extended reasoning on ambiguous merge-vs-distinct calls.
      // Set to a positive integer (e.g. 16384) to cap explicit budget.
      thinkingConfig: { thinkingBudget: -1 },
    },
  });
  const r = await runProc("curl", [
    "-sS",
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    "-H", "Content-Type: application/json",
    "-d", "@-",
  ], body);
  writeFileSync(`${outDir}/gemini${rawSuffix}.raw.json`, r.stdout);
  let json;
  try { json = JSON.parse(r.stdout); } catch { return { ok: false, error: "Invalid JSON from API" }; }
  if (json.error) return { ok: false, error: json.error.message };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { ok: false, error: "No content in Gemini response" };
  const arr = extractJsonArray(text);
  if (!arr) return { ok: false, error: "JSON parse failed" };
  console.error(`[council] gemini${rawSuffix}: ${arr.length} items`);
  return { ok: true, parsed: arr };
}

async function legGpt(items = plan.plan, rawSuffix = "") {
  // Chunk to avoid GPT-5.5 output truncation
  const chunks = [];
  for (let i = 0; i < items.length; i += GPT_CHUNK_SIZE) {
    chunks.push(items.slice(i, i + GPT_CHUNK_SIZE));
  }
  console.error(`[council] gpt: launching (${chunks.length} chunks of ≤${GPT_CHUNK_SIZE}${rawSuffix ? `, ${rawSuffix}` : ""})`);
  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    const input = buildInput(chunks[i]);
    // Reasoning effort: `high` is the upper bound that reliably completes
    // within budget — xhigh stalls past 15min on ~12-item chunks (do not bump).
    // The merge-vs-distinct call is the consequential one in this pipeline, so
    // we accept higher per-run cost for sharper boundary judgments.
    // Sandbox: `read-only` prevents Codex from acting on AGENTS.md session-init
    // ("run pnpm ingest:sessions on session open"). Without this, Codex burns
    // its budget executing those commands and times out before classifying.
    // Observed 2026-05-28 on a 10-source neuro chunk at `high` effort.
    const r = await runProc("codex", [
      "exec", "--skip-git-repo-check",
      "-s", "read-only",
      "-m", GPT_MODEL,
      "-c", "model_reasoning_effort=\"high\"",
      input,
    ], null);
    writeFileSync(`${outDir}/gpt${rawSuffix}-chunk-${i}.raw.txt`, r.stdout);
    if (r.code !== 0) {
      console.error(`[council] gpt${rawSuffix} chunk ${i}: exit ${r.code} — ${r.stderr.slice(-200)}`);
      continue;
    }
    const arr = extractJsonArray(r.stdout);
    if (!arr) {
      console.error(`[council] gpt${rawSuffix} chunk ${i}: JSON parse failed`);
      continue;
    }
    console.error(`[council] gpt${rawSuffix} chunk ${i}: ${arr.length} items`);
    all.push(...arr);
  }
  if (all.length === 0) return { ok: false, error: "all chunks failed" };
  return { ok: true, parsed: all };
}

async function legOllama(items = plan.plan, rawSuffix = "") {
  const input = buildInput(items);
  console.error(`[council] ollama: launching (qwen2.5:32b, ${items.length} items${rawSuffix ? ` ${rawSuffix}` : ""}, expect 5-15min)`);
  const r = await runProc("ollama", ["run", "qwen2.5:32b-instruct-q4_K_M"], input);
  writeFileSync(`${outDir}/ollama${rawSuffix}.raw.txt`, r.stdout);
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(-200) };
  // Strip ANSI escapes
  const cleaned = r.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const arr = extractJsonArray(cleaned);
  if (!arr) return { ok: false, error: "JSON parse failed" };
  console.error(`[council] ollama${rawSuffix}: ${arr.length} items`);
  return { ok: true, parsed: arr };
}

const legFns = { claude: legClaude, gemini: legGemini, gpt: legGpt, ollama: legOllama };

// ─── run all in parallel ────────────────────────────────────────────────────

const legs = [
  ["claude", legClaude],
  ["gemini", legGemini],
  ["gpt",    legGpt],
];
if (INCLUDE_OLLAMA) legs.push(["ollama", legOllama]);

const results = await Promise.all(legs.map(async ([name, fn]) => {
  try { return [name, await fn()]; }
  catch (err) { return [name, { ok: false, error: String(err) }]; }
}));

// Retry pass: each leg may have dropped items (timeouts, parse failures, GPT
// chunk skips). For any leg that returned fewer source_paths than expected,
// retry just the missing items in a small follow-up batch. One retry per leg —
// dropping after that is a real fail, not a transient glitch.
const expectedPaths = new Set(plan.plan.map(p => p.source.source_path));
for (const [name, r] of results) {
  if (!r.ok || !r.parsed) continue;
  const got = new Set(r.parsed.map(o => o.source_path).filter(Boolean));
  const missing = [...expectedPaths].filter(p => !got.has(p));
  if (missing.length === 0) continue;
  console.error(`[council] ${name}: dropped ${missing.length}/${itemCount} items; retrying`);
  const missingItems = plan.plan.filter(p => missing.includes(p.source.source_path));
  const retryFn = legFns[name];
  if (!retryFn) continue;
  let retry;
  try { retry = await retryFn(missingItems, "-retry"); }
  catch (err) { retry = { ok: false, error: String(err) }; }
  if (retry.ok && retry.parsed) {
    r.parsed = [...r.parsed, ...retry.parsed];
    console.error(`[council] ${name}: ${r.parsed.length}/${itemCount} after retry (+${retry.parsed.length})`);
  } else {
    console.error(`[council] ${name}: retry failed — ${retry.error}`);
  }
}

// Final write: per-leg parsed.json + manifest.
for (const [name, r] of results) {
  if (r.ok && r.parsed) {
    writeFileSync(`${outDir}/${name}.parsed.json`, JSON.stringify(r.parsed, null, 2));
    r.count = r.parsed.length;
    delete r.parsed; // keep manifest small
  }
}

const manifest = {
  stamp,
  outDir,
  plan_path: PLAN_PATH,
  source_count: itemCount,
  legs: Object.fromEntries(results),
};
writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));

console.error();
console.error("[council] Summary:");
for (const [name, r] of results) {
  console.error(`  ${name}: ${r.ok ? `${r.count}/${itemCount} items` : `FAIL — ${r.error}`}`);
}

// Fail loud: a dead required leg means synth silently runs on a partial panel,
// which collapses every row to likely_safe (auto_safe needs a full unanimous panel).
// Abort unless --allow-degraded so the operator consciously accepts the degraded run.
const REQUIRED_LEGS = ["claude", "gemini", "gpt"];
const deadLegs = results
  .filter(([name, r]) => REQUIRED_LEGS.includes(name) && !r.ok)
  .map(([name]) => name);
if (deadLegs.length && !has("--allow-degraded")) {
  console.error(`\n[council] ABORT: required leg(s) failed: ${deadLegs.join(", ")}.`);
  console.error(`[council] Synthesizing on a partial panel caps every row at likely_safe. The Gemini default rots — check model ids in Artifacts/Prompt/Council Review.md.`);
  console.error(`[council] Re-run after fixing, or pass --allow-degraded to proceed anyway. Outputs: ${outDir}`);
  process.exit(1);
}

// stdout = the manifest path (consumed by dedup:synth)
console.log(outDir);
