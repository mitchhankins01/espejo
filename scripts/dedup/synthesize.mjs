#!/usr/bin/env node
/**
 * Dedup Stage 3 — synthesize council outputs into a single plan + preview.
 *
 * Usage:
 *   pnpm dedup:synth /tmp/council/dedup/<stamp>
 *
 * Reads {claude,gemini,gpt[,ollama]}.parsed.json from <outDir>, plus the
 * original plan referenced by manifest.json. Emits:
 *
 *   <outDir>/synthesis.json   — machine-readable plan with consensus + picks
 *   <outDir>/preview.md       — human review doc (v2 layout: top-of-doc table,
 *                               bodies only on Merge cases, ⭐ recommended pick)
 *
 * Also prints the preview path on stdout for the caller to open.
 *
 * Recommended-pick heuristic (per Merge): pick the leg whose merge_body has
 * the most wikilinks; ties broken by longer body. Override happens in the
 * preview ("use Y for X") feedback loop with the orchestrating agent.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const outDir = process.argv[2];
if (!outDir) { console.error("usage: synthesize.mjs <outDir>"); process.exit(1); }

const manifest = JSON.parse(readFileSync(`${outDir}/manifest.json`, "utf8"));
const planFull = JSON.parse(readFileSync(manifest.plan_path, "utf8"));

// Vault root for reading body files (referenced in preview)
const VAULT = "/Users/mitch/Projects/espejo/Artifacts";
const readMd = (rel) => existsSync(join(VAULT, rel)) ? readFileSync(join(VAULT, rel), "utf8") : `[FILE NOT FOUND: ${rel}]`;

// Load each leg (skip if file missing)
const LEGS = ["claude", "gemini", "gpt", "ollama"];
const legArrays = {};
for (const leg of LEGS) {
  const f = `${outDir}/${leg}.parsed.json`;
  if (existsSync(f)) legArrays[leg] = JSON.parse(readFileSync(f, "utf8"));
}
const activeLegs = Object.keys(legArrays);
console.error(`[synth] Active legs: ${activeLegs.join(", ")}`);

// Index each leg by source_path
const idx = {};
for (const leg of activeLegs) {
  idx[leg] = Object.fromEntries(legArrays[leg].map(o => [o.source_path, o]));
}

// Union of all source paths
const allPaths = [...new Set(activeLegs.flatMap(l => legArrays[l].map(o => o.source_path)))].sort();

// ─── synthesis per source ───────────────────────────────────────────────────

const synth = allPaths.map(p => {
  const votes = activeLegs.map(l => idx[l][p]).filter(Boolean);
  const n = votes.length;

  const tally = {};
  for (const v of votes) tally[v.classification] = (tally[v.classification] || 0) + 1;
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const [topClass, topCount] = sorted[0] || [null, 0];

  // Target tally among voters who chose the top class
  const targetTally = {};
  for (const v of votes) {
    if (v.classification === topClass && v.target_path) {
      targetTally[v.target_path] = (targetTally[v.target_path] || 0) + 1;
    }
  }
  const consensusTarget = Object.entries(targetTally).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const targetAgreement = (topClass === "Merge" || topClass === "Duplicate")
    ? (Object.keys(targetTally).length === 1 ? "agree" : "disagree")
    : null;

  // Consensus bucket
  let consensus;
  if (n === 0) consensus = "no_votes";
  else if (topCount === n) consensus = "auto_safe";
  else if (n >= 3 && topCount === n - 1) consensus = "likely_safe";
  else consensus = "needs_review";
  if (votes.every(v => v.confidence === "low")) consensus = "low_confidence";

  // Default: when split, fall to Distinct (most conservative)
  let finalAction = topClass;
  let finalTarget = consensusTarget;
  if (consensus === "needs_review" || finalAction === "Distinct") {
    finalTarget = null;
  }
  if (consensus === "needs_review") {
    finalAction = "Distinct";
  }

  // Merge body recommended pick (heuristic)
  let recommendedPick = null;
  let recommendationRationale = null;
  if (finalAction === "Merge") {
    const candidates = activeLegs
      .filter(l => votes.find(v => v.source_path === p && v === idx[l][p])?.classification === "Merge")
      .filter(l => idx[l][p]?.merge_body)
      .map(l => ({ leg: l, body: idx[l][p].merge_body }));
    if (candidates.length === 0) {
      // Fall back to any leg with a merge_body
      for (const l of activeLegs) if (idx[l][p]?.merge_body) candidates.push({ leg: l, body: idx[l][p].merge_body });
    }
    if (candidates.length > 0) {
      // Heuristic: most wikilinks; tiebreaker = longer body
      const score = (body) => {
        const links = (body.match(/\[\[[^\]]+\]\]/g) || []).length;
        return links * 10000 + body.length; // links dominate
      };
      candidates.sort((a, b) => score(b.body) - score(a.body));
      recommendedPick = candidates[0].leg;
      const linkCounts = candidates.map(c => `${c.leg}=${(c.body.match(/\[\[/g) || []).length}`).join(", ");
      recommendationRationale = `most wikilinks (${linkCounts})`;
    }
    if (targetAgreement === "disagree") recommendedPick = "DEFER";
  }

  return {
    source_path: p,
    final_action: finalAction,
    final_target: finalTarget,
    consensus,
    target_agreement: targetAgreement,
    tally,
    votes_n: n,
    recommended_pick: recommendedPick,
    recommendation_rationale: recommendationRationale,
    classifications: Object.fromEntries(
      activeLegs.map(l => [l, idx[l][p] ? { class: idx[l][p].classification, target: idx[l][p].target_path, conf: idx[l][p].confidence } : null])
    ),
    rationales: Object.fromEntries(activeLegs.map(l => [l, idx[l][p]?.rationale])),
    merge_bodies: Object.fromEntries(activeLegs.map(l => [l, idx[l][p]?.merge_body])),
  };
});

const summary = {
  total: synth.length,
  buckets: synth.reduce((acc, s) => { acc[s.consensus] = (acc[s.consensus] || 0) + 1; return acc; }, {}),
  by_final_action: synth.reduce((acc, s) => { acc[s.final_action] = (acc[s.final_action] || 0) + 1; return acc; }, {}),
  active_legs: activeLegs,
};

writeFileSync(`${outDir}/synthesis.json`, JSON.stringify({ summary, plan: synth }, null, 2));
console.error(`[synth] ${outDir}/synthesis.json`);
console.error(JSON.stringify(summary, null, 2));

// ─── preview.md (v2 layout: top table, bodies only where useful) ────────────

const shortSrc = (p) => p?.replace(/^Pending\//, "").replace(/^Insight\//, "").replace(/\.md$/, "") || "—";

const counts = {
  auto_safe_dup: synth.filter(s => s.consensus === "auto_safe" && s.final_action === "Duplicate").length,
  auto_safe_merge: synth.filter(s => s.consensus === "auto_safe" && s.final_action === "Merge").length,
  auto_safe_distinct: synth.filter(s => s.consensus === "auto_safe" && s.final_action === "Distinct").length,
  likely_safe_dup: synth.filter(s => s.consensus === "likely_safe" && s.final_action === "Duplicate").length,
  likely_safe_merge: synth.filter(s => s.consensus === "likely_safe" && s.final_action === "Merge").length,
  likely_safe_distinct: synth.filter(s => s.consensus === "likely_safe" && s.final_action === "Distinct").length,
  needs_review: synth.filter(s => s.consensus === "needs_review").length,
};

let md = `# Dedup Apply Preview\n\n`;
md += `**Vault:** \`${VAULT}\` · **Generated:** ${new Date().toISOString().slice(0, 19)}Z · **Council:** ${activeLegs.join(", ")}\n`;
md += `**Plan:** ${manifest.plan_path} · **Council outputs:** ${outDir}\n\n`;

md += `## Quick scan — all ${synth.length} actions\n\n`;
md += `| # | Action | Source | Target | Consensus | C/G/T | ⭐ |\n|---:|---|---|---|---|---|---|\n`;
let i = 0;
for (const s of synth) {
  i++;
  const emoji = { Duplicate: "🗑️ delete", Merge: "🔀 merge", Distinct: "📤 promote" }[s.final_action];
  const tally = activeLegs.map(l => (s.classifications[l]?.class || "–")[0]).join("/");
  const star = s.final_action === "Merge" ? (s.recommended_pick === "DEFER" ? "⚠️ defer" : (s.recommended_pick || "?")) : "";
  md += `| ${i} | ${emoji} | \`${shortSrc(s.source_path)}\` | \`${shortSrc(s.final_target)}\` | ${s.consensus} | ${tally} | ${star} |\n`;
}
md += `\n**Counts:** auto-safe ${counts.auto_safe_dup + counts.auto_safe_merge + counts.auto_safe_distinct} (${counts.auto_safe_dup} dup + ${counts.auto_safe_merge} merge + ${counts.auto_safe_distinct} distinct) | likely-safe ${counts.likely_safe_dup + counts.likely_safe_merge + counts.likely_safe_distinct} | needs-review ${counts.needs_review}\n\n`;

md += `**Legend:** 🗑️ = delete source, 📤 = mv Pending → Insight, 🔀 = rewrite target body + delete source. ⭐ column = which model's merge body is recommended (heuristic: most wikilinks).\n\n---\n\n`;

// Phase tables — non-Merge actions need no body
const dupActions = synth.filter(s => s.final_action === "Duplicate");
const distActions = synth.filter(s => s.final_action === "Distinct");
const mergeActions = synth.filter(s => s.final_action === "Merge");

md += `## Deletes (${dupActions.length}) — Duplicate\n\n`;
md += `| # | Source | Target it duplicates | Consensus |\n|---:|---|---|---|\n`;
i = 0;
for (const s of dupActions) {
  i++;
  md += `| ${i} | \`${shortSrc(s.source_path)}\` | \`${shortSrc(s.final_target)}\` | ${s.consensus} |\n`;
}
md += `\n---\n\n`;

md += `## Promotions (${distActions.length}) — Distinct\n\n`;
md += `Each is \`mv Pending/<x>.md → Insight/<x>.md\` (collision-checked).\n\n`;
md += `| # | Source | Consensus |\n|---:|---|---|\n`;
i = 0;
for (const s of distActions) {
  i++;
  md += `| ${i} | \`${shortSrc(s.source_path)}\` | ${s.consensus} |\n`;
}
md += `\n---\n\n`;

md += `## Merges (${mergeActions.length}) — REQUIRES YOUR ATTENTION\n\n`;
md += `Each section: source body, target body BEFORE, ⭐ recommended new body. Alternates collapsed.\n\n`;
i = 0;
for (const s of mergeActions) {
  i++;
  const pick = s.recommended_pick;
  const isDefer = pick === "DEFER";
  const disagreeMark = s.target_agreement === "disagree" ? " ⚠️ TARGET DISAGREEMENT" : "";
  md += `### ${i}. \`${shortSrc(s.source_path)}\` → \`${shortSrc(s.final_target)}\`${disagreeMark}\n\n`;
  md += `**⭐ Recommended:** \`${pick}\` — _${s.recommendation_rationale || "(no rationale)"}_\n\n`;
  md += `<details><summary>Source body (deleted after merge)</summary>\n\n\`\`\`md\n${readMd(s.source_path)}\n\`\`\`\n</details>\n\n`;
  md += `<details><summary>Target body — BEFORE</summary>\n\n\`\`\`md\n${readMd(s.final_target)}\n\`\`\`\n</details>\n\n`;
  if (!isDefer && s.merge_bodies?.[pick]) {
    md += `**Target body — AFTER (⭐ ${pick}):**\n\n\`\`\`md\n${s.merge_bodies[pick]}\n\`\`\`\n\n`;
  } else if (isDefer) {
    md += `_⚠️ Models picked different targets. Decide manually._\n\n`;
  }
  const alts = activeLegs.filter(l => l !== pick && s.merge_bodies?.[l]);
  if (alts.length) {
    md += `<details><summary>Alternative merged bodies (${alts.join(", ")})</summary>\n\n`;
    for (const l of alts) {
      const altTarget = s.classifications[l]?.target ? ` → \`${shortSrc(s.classifications[l].target)}\`` : "";
      md += `**${l}${altTarget}:**\n\n\`\`\`md\n${s.merge_bodies[l]}\n\`\`\`\n\n`;
    }
    md += `</details>\n\n`;
  }
  md += `---\n\n`;
}

md += `## How to respond\n\n`;
md += `1. **"Approve all"** — apply every recommendation as-is.\n`;
md += `2. **"Approve auto-safe only"** — defer all \`likely_safe\` and \`needs_review\` rows.\n`;
md += `3. **"Skip these:"** + action numbers from the top table.\n`;
md += `4. **"Use Y for X"** — override a merge body pick (e.g. "use gemini for merge 4").\n`;
md += `\nThen run \`pnpm dedup:apply ${outDir}/synthesis.json\`.\n`;

writeFileSync(`${outDir}/preview.md`, md);
console.error(`[synth] ${outDir}/preview.md (${md.length} bytes)`);

// stdout = the preview path for the orchestrating agent
console.log(`${outDir}/preview.md`);
