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
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// Split prose paragraphs into one sentence per line so the line-based unified
// diff can show sentence-level changes (otherwise a single quote-style change
// re-flags the whole paragraph). Markdown-heading / list / wikilink-only
// paragraphs are left untouched.
function sentenceSplit(text) {
  if (!text) return "";
  return text.split(/\n{2,}/).map(p => {
    if (/^(#+\s|[-*]\s|>\s|\[\[)/.test(p.trim())) return p;
    return p.replace(/([.!?](?:["'’”])?)\s+(?=["“„¡¿]?[A-ZÁÉÍÓÚÑ])/g, "$1\n");
  }).join("\n\n");
}

// Unified diff between two body strings (git-diff style, sentence-granular).
// Returns "" if identical; otherwise the hunk lines (drops the --- / +++ header).
function unifiedDiff(before, after) {
  if (before === after) return "";
  const dir = mkdtempSync(join(tmpdir(), "ddiff-"));
  try {
    const a = join(dir, "before"); const b = join(dir, "after");
    // Trailing \n suppresses "No newline at end of file" markers from `diff`.
    writeFileSync(a, sentenceSplit(before) + "\n");
    writeFileSync(b, sentenceSplit(after) + "\n");
    const r = spawnSync("diff", ["-u", "--label", "BEFORE", "--label", "AFTER", a, b], { encoding: "utf8" });
    if (r.status === 0) return "";
    if (r.status === 1) {
      // Strip the two header lines (--- BEFORE / +++ AFTER) — labels are redundant with our section header.
      return r.stdout.split("\n").slice(2).join("\n");
    }
    return `[diff error: ${r.stderr || "unknown"}]`;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Drop YAML frontmatter only (keep body + trailing ## Sources so wikilink changes show in diffs).
function stripFrontmatter(md) {
  if (!md) return "";
  return md.startsWith("---\n") ? md.slice(4).replace(/^[\s\S]*?\n---\n?/, "") : md;
}

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

// Two primitives + a composition. `stripFrontmatter` and `stripSourcesSection`
// each do one thing; `bodyCore` is the prose-only form used for similarity /
// signal-recall calculations. Preview rendering uses `stripFrontmatter` alone
// so the displayed body still shows its Sources block.
function stripSourcesSection(md) {
  if (!md) return "";
  return md.replace(/\n## Sources[\s\S]*$/i, "");
}
function bodyCore(md) {
  return stripSourcesSection(stripFrontmatter(md)).trim();
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

// Ghost filter: drop any leg-returned source_path that isn't in the canonical
// retrieval plan. Legs occasionally hallucinate extra rows (e.g. Gemini keyed a
// source by its DB UUID instead of file path) which then survive as phantom
// cases in the preview and break apply's mv against a non-existent file. The
// retrieval plan is authoritative — anything outside it is a ghost.
const validSourcePaths = new Set(
  planFull.plan.map(e => e.source?.source_path).filter(Boolean)
);
for (const leg of activeLegs) {
  const before = legArrays[leg].length;
  const ghosts = [];
  legArrays[leg] = legArrays[leg].filter(o => {
    if (!validSourcePaths.has(o.source_path)) { ghosts.push(o.source_path); return false; }
    return true;
  });
  if (ghosts.length) {
    console.error(`[synth] ${leg}: dropped ${ghosts.length}/${before} ghost source(s) not in plan: ${ghosts.join(", ")}`);
  }
}

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

  // Consensus bucket. auto_safe requires a full unanimous panel (n≥3); 2/2-agree
  // and single-vote rows are downgraded to likely_safe so the missing-leg case
  // doesn't masquerade as full confidence.
  let consensus;
  if (n === 0) consensus = "no_votes";
  else if (n >= 3 && topCount === n) consensus = "auto_safe";
  else if (n >= 3 && topCount === n - 1) consensus = "likely_safe";
  else if (n === 2 && topCount === 2) consensus = "likely_safe";
  else if (n === 1) consensus = "likely_safe";
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
    const srcCore = bodyCore(sourceBodyRaw);
    const tgtCore = bodyCore(targetBodyRaw);

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
        const bg = bigrams(bodyCore(body));
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
      const winnerBg = bigrams(bodyCore(scored[0].body));
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

// Post-pass: detect multi-source-same-target merge groups. When N>1 sources
// merge into the same destination, apply writes each merge_body sequentially —
// each based on the ORIGINAL target — so later writes silently overwrite
// earlier writes' content. To prevent data loss, keep the highest-signal source
// as the primary Merge and demote the others to Distinct (they promote to
// Insight/ as separate files; the next dedup pass / mode-B sweep will catch
// the remaining overlap with the merged target).
const mergeGroups = {};
for (const s of synth) {
  if (s.final_action === "Merge" && s.final_target) {
    (mergeGroups[s.final_target] ||= []).push(s);
  }
}
for (const [target, group] of Object.entries(mergeGroups)) {
  if (group.length <= 1) continue;
  const compositeOf = (s) => s.score_breakdown?.[0]?.composite ?? 0;
  const primary = group.reduce((best, s) => compositeOf(s) > compositeOf(best) ? s : best);
  for (const s of group) {
    if (s === primary) continue;
    s.coalesce_demoted_from = { final_action: "Merge", final_target: s.final_target };
    s.coalesce_primary = primary.source_path;
    s.final_action = "Distinct";
    s.final_target = null;
    s.recommended_pick = null;
    s.recommendation_rationale = `co-targeted ${target.replace(/^(Pending|Insight)\//, "")} with primary ${primary.source_path.replace(/^Pending\//, "")} — demoted to Distinct to avoid sequential-write data loss; rerun dedup to merge separately`;
  }
  console.error(`[synth] multi-source group at ${target.replace(/^(Pending|Insight)\//, "")}: primary=${primary.source_path.replace(/^Pending\//, "")}, demoted ${group.length - 1} secondary source(s)`);
}

// Cycle coalesce: reciprocal merges A→B and B→A. Apply would run both
// sequentially — second clobbers first's body and reads from a target that the
// first just rewrote. The target-group coalescer above only catches sources
// that share a destination; it can't see cycles because the targets differ.
// Keep the higher-composite direction as primary Merge; drop the reverse with
// final_action="Skip" so apply ignores it (the primary's source-delete already
// removes the cycle's other end).
const mergeBySource = {};
for (const s of synth) {
  if (s.final_action === "Merge" && s.final_target) mergeBySource[s.source_path] = s;
}
const cycleHandled = new Set();
for (const [src, s] of Object.entries(mergeBySource)) {
  if (cycleHandled.has(src)) continue;
  const reverse = mergeBySource[s.final_target];
  if (!reverse || reverse.final_target !== src) continue;
  const compositeOf = (x) => x.score_breakdown?.[0]?.composite ?? 0;
  const primary = compositeOf(s) >= compositeOf(reverse) ? s : reverse;
  const secondary = primary === s ? reverse : s;
  secondary.coalesce_cycle_paired_with = primary.source_path;
  secondary.final_action = "Skip";
  secondary.recommended_pick = null;
  secondary.recommendation_rationale = `reciprocal merge cycle with ${primary.source_path.replace(/^Pending\//, "")} — primary direction kept; this reverse direction skipped (primary's source-delete already removes this file)`;
  cycleHandled.add(primary.source_path);
  cycleHandled.add(secondary.source_path);
  console.error(`[synth] cycle coalesced: primary=${primary.source_path.replace(/^Pending\//, "")} ⇄ skipped=${secondary.source_path.replace(/^Pending\//, "")}`);
}

const summary = {
  total: synth.length,
  buckets: synth.reduce((acc, s) => { acc[s.consensus] = (acc[s.consensus] || 0) + 1; return acc; }, {}),
  by_final_action: synth.reduce((acc, s) => { acc[s.final_action] = (acc[s.final_action] || 0) + 1; return acc; }, {}),
  coalesce_demotions: synth.filter(s => s.coalesce_demoted_from).length,
  cycle_skips: synth.filter(s => s.coalesce_cycle_paired_with).length,
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
  const emoji = { Duplicate: "🗑️ delete", Merge: mergeLabel, Distinct: distinctLabel, Skip: "⏭️ skip-cycle" }[s.final_action] || s.final_action;
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
const skipActions = synth.filter(s => s.final_action === "Skip");

if (skipActions.length) {
  md += `## Skipped (${skipActions.length}) — reciprocal merge cycle\n\n`;
  md += `These rows were the reverse direction of an A↔B merge cycle. Apply ignores them — the primary direction's source-delete already removes this file from the vault. No action needed.\n\n`;
  md += `| # | This row (skipped) | Paired with (primary) |\n|---:|---|---|\n`;
  let j = 0;
  for (const s of skipActions) {
    j++;
    md += `| ${j} | \`${shortSrc(s.source_path)}\` | \`${shortSrc(s.coalesce_cycle_paired_with)}\` |\n`;
  }
  md += `\n---\n\n`;
}

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
  i = 0;
  for (const s of distActions) {
    i++;
    md += `| ${i} | \`${shortSrc(s.source_path)}\` | ${s.consensus} |\n`;
  }
  md += `\n---\n\n`;
} else {
  md += `## Promotions (${distActions.length}) — Distinct\n\n`;
  md += `Each is \`mv Pending/<x>.md → Insight/<x>.md\` (collision-checked). Full body shown for review.\n\n`;
  const demotions = distActions.filter(s => s.coalesce_demoted_from);
  if (demotions.length) {
    md += `⚠️ **${demotions.length} coalesce-demotion${demotions.length === 1 ? "" : "s"}**: row(s) below were originally classified Merge but co-targeted the same destination as another source. To prevent sequential-write data loss, the highest-signal source kept the Merge classification and the rest were demoted here. Rerun \`pnpm dedup:full\` (or another retrieve→council→synth cycle) afterwards to merge them properly against the now-updated target.\n\n`;
  }
  i = 0;
  for (const s of distActions) {
    i++;
    const tag = s.coalesce_demoted_from
      ? ` — **coalesce-demoted** (was Merge → \`${shortSrc(s.coalesce_demoted_from.final_target)}\`, primary: \`${shortSrc(s.coalesce_primary)}\`)`
      : "";
    md += `### ${i}. \`${shortSrc(s.source_path)}\` — ${s.consensus}${tag}\n\n`;
    md += `\`\`\`md\n${stripFrontmatter(readMd(s.source_path))}\n\`\`\`\n\n`;
  }
  md += `---\n\n`;
}

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
md += `Each section: source body (will be deleted) + full target BEFORE + red/green diff + full target ⭐ recommended AFTER. Alternates collapsed.\n\n`;
i = 0;
for (const s of trueMergeActions) {
  i++;
  const pick = s.recommended_pick;
  const isDefer = pick === "DEFER";
  const disagreeMark = s.target_agreement === "disagree" ? " ⚠️ TARGET DISAGREEMENT" : "";
  md += `### ${i}. \`${shortSrc(s.source_path)}\` → \`${shortSrc(s.final_target)}\`${disagreeMark}\n\n`;
  md += `**⭐ Recommended:** \`${pick}\` — _${s.recommendation_rationale || "(no rationale)"}_\n\n`;

  md += `**Source body (deleted after merge):**\n\n\`\`\`md\n${stripFrontmatter(readMd(s.source_path))}\n\`\`\`\n\n`;

  if (!isDefer && s.merge_bodies?.[pick]) {
    const beforeBody = stripFrontmatter(readMd(s.final_target));
    const afterBody = s.merge_bodies[pick];
    const diff = unifiedDiff(beforeBody, afterBody);
    md += `**Target BEFORE (\`${shortSrc(s.final_target)}\`):**\n\n\`\`\`md\n${beforeBody}\n\`\`\`\n\n`;
    md += `**Target diff (BEFORE → AFTER ⭐ ${pick}):**\n\n`;
    if (diff) {
      md += `\`\`\`diff\n${diff}\`\`\`\n\n`;
      md += `**Target AFTER ⭐ ${pick} (full body):**\n\n\`\`\`md\n${afterBody}\n\`\`\`\n\n`;
    } else {
      md += `_(no changes — picked body is identical to current target)_\n\n`;
    }
  } else if (isDefer) {
    md += `**Current target body:**\n\n\`\`\`md\n${stripFrontmatter(readMd(s.final_target))}\n\`\`\`\n\n`;
    md += `_⚠️ Models picked different targets. Decide manually._\n\n`;
  }

  const alts = activeLegs.filter(l => l !== pick && s.merge_bodies?.[l]);
  if (alts.length) {
    md += `<details><summary>Alternative merged bodies (${alts.join(", ")})</summary>\n\n`;
    for (const l of alts) {
      const altTargetPath = s.classifications[l]?.target;
      const altTargetLabel = altTargetPath ? ` → \`${shortSrc(altTargetPath)}\`` : "";
      md += `**${l}${altTargetLabel}:**\n\n`;
      // If the alt picked the same target, show as a diff against current target;
      // otherwise show plain body (since the diff baseline differs).
      if (altTargetPath && altTargetPath === s.final_target) {
        const altDiff = unifiedDiff(stripFrontmatter(readMd(altTargetPath)), s.merge_bodies[l]);
        md += altDiff ? `\`\`\`diff\n${altDiff}\`\`\`\n\n` : `_(no changes)_\n\n`;
      } else {
        md += `\`\`\`md\n${s.merge_bodies[l]}\n\`\`\`\n\n`;
      }
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
