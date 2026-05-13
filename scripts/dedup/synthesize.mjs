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
 * Recommended-pick heuristic (per Merge): score each leg's merge_body by how
 * much signal from source ∪ target it preserves — bigram recall (65%), quoted-
 * span recall (25%), wikilink recall (10%). Penalizes "longest body wins" and
 * "most refs wins" failure modes where one leg pads out refs but drops content.
 *
 * Also detects "supersede" cases: when source is a strict bigram-superset of
 * target (you wrote a fuller version of an existing Insight under the same
 * filename), there's nothing to synthesize — the action is just overwrite. The
 * preview collapses these so they don't waste review attention.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const outDir = process.argv[2];
if (!outDir) { console.error("usage: synthesize.mjs <outDir>"); process.exit(1); }

const manifest = JSON.parse(readFileSync(`${outDir}/manifest.json`, "utf8"));
const planFull = JSON.parse(readFileSync(manifest.plan_path, "utf8"));
// Mode A (pending): Distinct = promote Pending→Insight (`mv` + emoji 📤)
// Mode B (existing): Distinct = no-op, both files stay as-is
const modeIsB = planFull.mode === "existing";

// Vault root for reading body files (referenced in preview)
const VAULT = "/Users/mitch/Projects/espejo/Artifacts";
const readMd = (rel) => existsSync(join(VAULT, rel)) ? readFileSync(join(VAULT, rel), "utf8") : `[FILE NOT FOUND: ${rel}]`;

// Strip frontmatter + Sources block so signal metrics only see body prose.
function stripFrontmatter(md) {
  if (!md) return "";
  let s = md.startsWith("---\n") ? md.slice(4).replace(/^[\s\S]*?\n---\n?/, "") : md;
  // Drop trailing "## Sources" block — wikilinks counted separately.
  s = s.replace(/\n## Sources[\s\S]*$/i, "");
  return s.trim();
}

function bigrams(text) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i < words.length - 1; i++) set.add(`${words[i]} ${words[i + 1]}`);
  return set;
}

// Quoted/italicized spans — Mitch's deliberately-marked signal (`"..."`, `_..._`).
function quoteSpans(text) {
  const out = new Set();
  // Curly + straight quotes of length ≥6
  for (const m of text.matchAll(/[“"]([^”"\n]{6,})[”"]/g)) out.add(m[1].trim());
  // Markdown italic spans of length ≥6
  for (const m of text.matchAll(/[_*]([^_*\n]{6,})[_*]/g)) out.add(m[1].trim());
  return out;
}

function wikilinks(text) {
  const out = new Set();
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) out.add(m[1].trim());
  return out;
}

function recall(needles, haystackSet) {
  if (needles.size === 0) return null; // neutral
  let hit = 0;
  for (const n of needles) if (haystackSet.has(n)) hit++;
  return hit / needles.size;
}

function recallByInclusion(needles, haystackText) {
  if (needles.size === 0) return null;
  let hit = 0;
  for (const n of needles) if (haystackText.includes(n)) hit++;
  return hit / needles.size;
}

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

  // Merge body recommended pick + supersede detection
  let recommendedPick = null;
  let recommendationRationale = null;
  let isSupersede = false;
  let scoreBreakdown = null;
  if (finalAction === "Merge") {
    const planEntry = planFull.plan.find(e => e.source?.source_path === p);
    const sourceBodyRaw = planEntry?.source?.body || "";
    const targetBodyRaw = finalTarget ? readMd(finalTarget) : "";
    const srcCore = stripFrontmatter(sourceBodyRaw);
    const tgtCore = stripFrontmatter(targetBodyRaw);

    const srcBg = bigrams(srcCore);
    const tgtBg = bigrams(tgtCore);
    const unionBg = new Set([...srcBg, ...tgtBg]);
    const unionSpans = new Set([...quoteSpans(srcCore), ...quoteSpans(tgtCore)]);
    const unionLinks = new Set([...wikilinks(sourceBodyRaw), ...wikilinks(targetBodyRaw)]);

    const candidates = activeLegs
      .filter(l => votes.find(v => v.source_path === p && v === idx[l][p])?.classification === "Merge")
      .filter(l => idx[l][p]?.merge_body)
      .map(l => ({ leg: l, body: idx[l][p].merge_body }));
    if (candidates.length === 0) {
      for (const l of activeLegs) if (idx[l][p]?.merge_body) candidates.push({ leg: l, body: idx[l][p].merge_body });
    }
    let scored = null;
    if (candidates.length > 0) {
      scored = candidates.map(({ leg, body }) => {
        const bg = bigrams(stripFrontmatter(body));
        const bgRecall = recall(unionBg, bg) ?? 0;
        const spanRecall = recallByInclusion(unionSpans, body) ?? 1; // neutral if no spans
        const linkRecall = recall(unionLinks, wikilinks(body)) ?? 1; // neutral if no links
        const composite = bgRecall * 0.65 + spanRecall * 0.25 + linkRecall * 0.10;
        return { leg, body, bgRecall, spanRecall, linkRecall, composite };
      });
      scored.sort((a, b) => b.composite - a.composite);
      recommendedPick = scored[0].leg;
      scoreBreakdown = scored.map(s => ({
        leg: s.leg,
        bigram: +s.bgRecall.toFixed(3),
        span: +s.spanRecall.toFixed(3),
        link: +s.linkRecall.toFixed(3),
        composite: +s.composite.toFixed(3),
      }));
      const summary = scored.map(s => `${s.leg}=${(s.composite * 100).toFixed(0)}% (bg ${(s.bgRecall * 100).toFixed(0)}, sp ${(s.spanRecall * 100).toFixed(0)}, lk ${(s.linkRecall * 100).toFixed(0)})`).join(" · ");
      recommendationRationale = `signal recall: ${summary}`;
    }
    if (targetAgreement === "disagree") recommendedPick = "DEFER";

    // Supersede detection: winning leg's body is itself near-identical to source.
    // Means LLM(s) decided there was nothing to synthesize — the source supersedes
    // the target wholesale. Skip the alternates view and write source verbatim.
    if (recommendedPick !== "DEFER" && scored && scored[0]) {
      const winnerBg = bigrams(stripFrontmatter(scored[0].body));
      const matchToSrc = recall(srcBg, winnerBg) ?? 0;     // |w∩s|/|s| — is source covered?
      const winnerFromSrc = recall(winnerBg, srcBg) ?? 0;   // |w∩s|/|w| — is winner mostly source?
      // Supersede iff winner ≈ source (both directions). If winner adds bigrams not in source
      // (e.g. target's distinct phrasing), that's real synthesis, not supersede.
      if (matchToSrc >= 0.95 && winnerFromSrc >= 0.95) {
        isSupersede = true;
        recommendedPick = "_supersede";
        recommendationRationale = `winning leg returned source verbatim (${(matchToSrc * 100).toFixed(0)}% source covered, ${(winnerFromSrc * 100).toFixed(0)}% of winner derives from source) — no synthesis to choose between`;
      }
    }
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
    score_breakdown: scoreBreakdown,
    is_supersede: isSupersede,
    classifications: Object.fromEntries(
      activeLegs.map(l => [l, idx[l][p] ? { class: idx[l][p].classification, target: idx[l][p].target_path, conf: idx[l][p].confidence } : null])
    ),
    rationales: Object.fromEntries(activeLegs.map(l => [l, idx[l][p]?.rationale])),
    merge_bodies: (() => {
      const m = Object.fromEntries(activeLegs.map(l => [l, idx[l][p]?.merge_body]));
      if (isSupersede) {
        const planEntry = planFull.plan.find(e => e.source?.source_path === p);
        const srcBody = stripFrontmatter(planEntry?.source?.body || "");
        m._supersede = srcBody;
      }
      return m;
    })(),
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
  const distinctLabel = modeIsB ? "📋 keep both" : "📤 promote";
  const mergeLabel = s.is_supersede ? "♻️ supersede" : "🔀 merge";
  const emoji = { Duplicate: "🗑️ delete", Merge: mergeLabel, Distinct: distinctLabel }[s.final_action];
  const tally = activeLegs.map(l => (s.classifications[l]?.class || "–")[0]).join("/");
  const star = s.final_action === "Merge" ? (s.recommended_pick === "DEFER" ? "⚠️ defer" : (s.recommended_pick || "?")) : "";
  md += `| ${i} | ${emoji} | \`${shortSrc(s.source_path)}\` | \`${shortSrc(s.final_target)}\` | ${s.consensus} | ${tally} | ${star} |\n`;
}
md += `\n**Counts:** auto-safe ${counts.auto_safe_dup + counts.auto_safe_merge + counts.auto_safe_distinct} (${counts.auto_safe_dup} dup + ${counts.auto_safe_merge} merge + ${counts.auto_safe_distinct} distinct) | likely-safe ${counts.likely_safe_dup + counts.likely_safe_merge + counts.likely_safe_distinct} | needs-review ${counts.needs_review}\n\n`;

const distinctLegend = modeIsB
  ? "📋 = no action (Mode B: both files already in Insight/, stay as-is)"
  : "📤 = mv Pending → Insight";
md += `**Mode:** ${modeIsB ? "B (existing-pairwise sweep within Insight/)" : "A (pending → Insight)"}\n\n`;
md += `**Legend:** 🗑️ = delete source, ${distinctLegend}, 🔀 = rewrite target body + delete source, ♻️ = source supersedes target (verbatim replace, no synthesis). ⭐ column = leg with highest signal recall over source ∪ target (bigram 65% / quote-span 25% / wikilink 10%).\n\n---\n\n`;

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

if (modeIsB) {
  md += `## Distinct (${distActions.length}) — NO ACTION\n\n`;
  md += `Mode B sweep within \`Insight/\`. These pairs were judged covering different points despite overlap. Both files stay as-is.\n\n`;
  md += `| # | Source (kept) | Consensus |\n|---:|---|---|\n`;
} else {
  md += `## Promotions (${distActions.length}) — Distinct\n\n`;
  md += `Each is \`mv Pending/<x>.md → Insight/<x>.md\` (collision-checked).\n\n`;
  md += `| # | Source | Consensus |\n|---:|---|---|\n`;
}
i = 0;
for (const s of distActions) {
  i++;
  // In Mode B, final_target is null for Distinct (no merge target chosen); the
  // pair member is implicit in the retrieval plan but not preserved per-case.
  // Leave as a single-column listing.
  md += `| ${i} | \`${shortSrc(s.source_path)}\` | ${s.consensus} |\n`;
}
md += `\n---\n\n`;

const supersedeActions = mergeActions.filter(s => s.is_supersede);
const trueMergeActions = mergeActions.filter(s => !s.is_supersede);

if (supersedeActions.length) {
  md += `## Supersedes (${supersedeActions.length}) — source replaces target verbatim\n\n`;
  md += `Source body is a strict bigram-superset of target — same filename or near-identical scope, the Pending version is fuller. Action: write source body into target path, delete source. No synthesis to review.\n\n`;
  md += `| # | File | Consensus |\n|---:|---|---|\n`;
  let j = 0;
  for (const s of supersedeActions) {
    j++;
    md += `| ${j} | \`${shortSrc(s.source_path)}\` | ${s.consensus} |\n`;
  }
  md += `\n---\n\n`;
}

md += `## Merges (${trueMergeActions.length}) — REQUIRES YOUR ATTENTION\n\n`;
md += `Each section: source body, target body BEFORE, ⭐ recommended new body (highest signal recall). Alternates collapsed.\n\n`;
i = 0;
for (const s of trueMergeActions) {
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
