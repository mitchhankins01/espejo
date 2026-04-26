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

// ─── wrapper prompt ─────────────────────────────────────────────────────────

const WRAPPER = `You are classifying candidate insight pairs for a vault dedup workflow.

Input: a JSON file embedded below (the "INPUT DATA" section). Each entry under \`.plan[]\` pairs a "source" insight (a Pending file) with up to 10 "candidates" from Insight/ OR Pending/ ordered by hybrid RRF score. Bodies are full text. Cosine distance is provided when available.

For EACH source × top-candidate pair, classify the relationship:

- **Duplicate** — candidate already says exactly what source says, in different words. Action: delete source, keep candidate.
- **Merge** — candidate covers the same idea but source adds a meaningful detail, evidence, source attribution, or precision the candidate lacks. Action: rewrite the candidate to integrate source's unique content, union the source wikilinks, delete source.
- **Distinct** — same topic but different points (or fundamentally different ideas). Action: leave both. Promote the source to Insight/ as-is.

Only consider the TOP candidate per source unless multiple candidates have RRF scores within 10% of the top.

Be conservative on Merge — semantic merging atomic insights is destructive when wrong. If a pair is ambiguous, classify as **Distinct** and note uncertainty in your rationale.

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

function runProc(cmd, argv, stdinText, envOverride = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, argv, { env: { ...env, ...envOverride } });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    if (stdinText) { proc.stdin.write(stdinText); proc.stdin.end(); }
  });
}

async function legClaude() {
  const input = buildInput(plan.plan);
  console.error("[council] claude: launching (full batch)");
  const r = await runProc("claude", [
    "-p", "--model", "claude-opus-4-7", "--dangerously-skip-permissions", input,
  ], null);
  writeFileSync(`${outDir}/claude.raw.txt`, r.stdout);
  if (r.code !== 0) return { ok: false, error: r.stderr || `exit ${r.code}` };
  const arr = extractJsonArray(r.stdout);
  if (!arr) return { ok: false, error: "JSON parse failed", raw: r.stdout.slice(0, 200) };
  console.error(`[council] claude: ${arr.length} items`);
  writeFileSync(`${outDir}/claude.parsed.json`, JSON.stringify(arr, null, 2));
  return { ok: true, count: arr.length };
}

async function legGemini() {
  if (!env.GEMINI_API_KEY) return { ok: false, error: "GEMINI_API_KEY not set" };
  const input = buildInput(plan.plan);
  console.error("[council] gemini: launching (full batch)");
  const body = JSON.stringify({
    contents: [{ parts: [{ text: input }] }],
    generationConfig: { maxOutputTokens: 65536 },
  });
  const r = await runProc("curl", [
    "-sS",
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${env.GEMINI_API_KEY}`,
    "-H", "Content-Type: application/json",
    "-d", "@-",
  ], body);
  writeFileSync(`${outDir}/gemini.raw.json`, r.stdout);
  let json;
  try { json = JSON.parse(r.stdout); } catch { return { ok: false, error: "Invalid JSON from API" }; }
  if (json.error) return { ok: false, error: json.error.message };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { ok: false, error: "No content in Gemini response" };
  const arr = extractJsonArray(text);
  if (!arr) return { ok: false, error: "JSON parse failed" };
  console.error(`[council] gemini: ${arr.length} items`);
  writeFileSync(`${outDir}/gemini.parsed.json`, JSON.stringify(arr, null, 2));
  return { ok: true, count: arr.length };
}

async function legGpt() {
  // Chunk to avoid GPT-5.5 output truncation
  const chunks = [];
  for (let i = 0; i < plan.plan.length; i += GPT_CHUNK_SIZE) {
    chunks.push(plan.plan.slice(i, i + GPT_CHUNK_SIZE));
  }
  console.error(`[council] gpt: launching (${chunks.length} chunks of ≤${GPT_CHUNK_SIZE})`);
  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    const input = buildInput(chunks[i]);
    const r = await runProc("codex", [
      "exec", "--skip-git-repo-check", "-m", "gpt-5.5", input,
    ], null);
    writeFileSync(`${outDir}/gpt-chunk-${i}.raw.txt`, r.stdout);
    if (r.code !== 0) {
      console.error(`[council] gpt chunk ${i}: exit ${r.code} — ${r.stderr.slice(-200)}`);
      continue;
    }
    const arr = extractJsonArray(r.stdout);
    if (!arr) {
      console.error(`[council] gpt chunk ${i}: JSON parse failed`);
      continue;
    }
    console.error(`[council] gpt chunk ${i}: ${arr.length} items`);
    all.push(...arr);
  }
  if (all.length === 0) return { ok: false, error: "all chunks failed" };
  writeFileSync(`${outDir}/gpt.parsed.json`, JSON.stringify(all, null, 2));
  return { ok: true, count: all.length };
}

async function legOllama() {
  const input = buildInput(plan.plan);
  console.error("[council] ollama: launching (qwen2.5:32b, expect 5-15min)");
  const r = await runProc("ollama", ["run", "qwen2.5:32b-instruct-q4_K_M"], input);
  writeFileSync(`${outDir}/ollama.raw.txt`, r.stdout);
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(-200) };
  // Strip ANSI escapes
  const cleaned = r.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const arr = extractJsonArray(cleaned);
  if (!arr) return { ok: false, error: "JSON parse failed" };
  console.error(`[council] ollama: ${arr.length} items`);
  writeFileSync(`${outDir}/ollama.parsed.json`, JSON.stringify(arr, null, 2));
  return { ok: true, count: arr.length };
}

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

// stdout = the manifest path (consumed by dedup:synth)
console.log(outDir);
