#!/usr/bin/env node
/**
 * For each Merge case in synthesis.json:
 *   1. Read source body + target body from the vault.
 *   2. Read the recommended merge body.
 *   3. Sentence-tokenize the merge body.
 *   4. For each merge sentence, compute max cosine sim against any sentence in
 *      (source ∪ target). High = faithful (sentence traces to existing content).
 *      Low = invented or heavily paraphrased.
 *   5. Flag any merge sentence with sim < THRESHOLD as suspicious.
 *
 * This catches LLM hallucination — net-new claims not present in either source.
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const SYNTH = process.argv[2];
if (!SYNTH) { console.error("usage: check-merge-faithfulness.mjs <synthesis.json>"); process.exit(1); }
const VAULT = "/Users/mitch/Projects/espejo/Artifacts";
const THRESHOLD = 0.55;  // cosine sim under this is "novel"; tuned for paraphrase tolerance

// Read .env.production.local for OPENAI_API_KEY
const envText = readFileSync("/Users/mitch/Projects/espejo/.env.production.local", "utf8");
const apiKey = envText.match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) { console.error("no OPENAI_API_KEY"); process.exit(1); }

const synth = JSON.parse(readFileSync(SYNTH, "utf8"));
const merges = synth.plan.filter(s => s.final_action === "Merge");

// Strip frontmatter + ## Sources block, leave just the body prose
function bodyText(filePath) {
  const full = readFileSync(`${VAULT}/${filePath}`, "utf8");
  // strip frontmatter
  let body = full.replace(/^---\n[\s\S]*?\n---\n?/, "");
  // strip trailing ## Sources block
  body = body.replace(/\n##\s+Sources[\s\S]*$/i, "");
  return body.trim();
}

// Naive sentence split — good enough for this check. Splits on . ! ? followed by space/newline.
// Also splits on double-newline (paragraph breaks) so bullet-style fragments work.
function sentences(text) {
  const parts = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(['"])/)
    .map(s => s.trim())
    .filter(s => s.length > 15);  // skip tiny fragments
  return parts;
}

async function embed(texts) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`embed failed ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data.map(d => d.embedding);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const report = [];

for (let i = 0; i < merges.length; i++) {
  const m = merges[i];
  const srcPath = m.source_path;
  const tgtPath = m.final_target;
  const pick = m.recommended_pick;
  const mergeBody = m.merge_bodies[pick];

  if (!existsSync(`${VAULT}/${srcPath}`)) { report.push({ idx: i+1, error: `source missing: ${srcPath}` }); continue; }
  if (!existsSync(`${VAULT}/${tgtPath}`)) { report.push({ idx: i+1, error: `target missing: ${tgtPath}` }); continue; }
  if (!mergeBody) { report.push({ idx: i+1, error: `no merge body for pick=${pick}` }); continue; }

  const srcBody = bodyText(srcPath);
  const tgtBody = bodyText(tgtPath);
  // Strip ## Sources from merge body too — sources aren't prose claims
  const mergeOnly = mergeBody.replace(/\n##\s+Sources[\s\S]*$/i, "").trim();

  const mergeSents = sentences(mergeOnly);
  const srcSents = sentences(srcBody);
  const tgtSents = sentences(tgtBody);
  const allRefSents = [...srcSents, ...tgtSents];

  if (allRefSents.length === 0 || mergeSents.length === 0) {
    report.push({ idx: i+1, srcPath, tgtPath, pick, error: "empty bodies" });
    continue;
  }

  const allTexts = [...mergeSents, ...allRefSents];
  const embs = await embed(allTexts);
  const mergeEmbs = embs.slice(0, mergeSents.length);
  const refEmbs = embs.slice(mergeSents.length);

  const sentenceReport = mergeSents.map((s, j) => {
    let bestSim = -1, bestRef = -1;
    for (let k = 0; k < refEmbs.length; k++) {
      const sim = cosine(mergeEmbs[j], refEmbs[k]);
      if (sim > bestSim) { bestSim = sim; bestRef = k; }
    }
    const refSrc = bestRef < srcSents.length ? "source" : "target";
    return {
      merge_sentence: s,
      best_sim: bestSim.toFixed(3),
      best_match: allRefSents[bestRef],
      best_match_from: refSrc,
      flagged: bestSim < THRESHOLD,
    };
  });

  const flaggedCount = sentenceReport.filter(s => s.flagged).length;

  report.push({
    idx: i+1,
    src: srcPath.replace(/^Insight\//, ""),
    tgt: tgtPath.replace(/^Insight\//, ""),
    pick,
    merge_sentences: mergeSents.length,
    flagged_count: flaggedCount,
    min_sim: Math.min(...sentenceReport.map(s => parseFloat(s.best_sim))).toFixed(3),
    avg_sim: (sentenceReport.reduce((a,s) => a+parseFloat(s.best_sim), 0) / sentenceReport.length).toFixed(3),
    flagged: sentenceReport.filter(s => s.flagged),
  });
  process.stderr.write(`[${i+1}/${merges.length}] checked: ${flaggedCount} flagged of ${mergeSents.length} (min sim ${report[report.length-1].min_sim})\n`);
}

console.log(JSON.stringify({ threshold: THRESHOLD, merges: report }, null, 2));
