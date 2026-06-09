#!/usr/bin/env node
/**
 * Dedup Stage 4 — apply the synthesis plan to the vault.
 *
 * Usage:
 *   pnpm dedup:apply <outDir>                   # dry run by default
 *   pnpm dedup:apply <outDir> --apply           # actually mutate
 *   pnpm dedup:apply <outDir> --apply --skip likely_safe   # auto-safe only
 *   pnpm dedup:apply <outDir> --apply --override 4=gemini  # use gemini's body for merge #4
 *
 * Where <outDir> is /tmp/council/dedup/<stamp> (the dir written by dedup:synth).
 *
 * What it does (in order):
 *   1. Snapshot every file that will be touched (Pending sources + Insight targets) to /tmp/dedup-snapshot-<ts>/
 *   2. For each Duplicate/Merge: scan inbound [[wikilinks]] across the vault, rewrite to point at the target
 *   3. Phase 4 + 5a — promotions (mv Pending → Insight, collision-suffix on conflict)
 *   4. Phase 2 + 5b — duplicate deletes (rm Pending after wikilink rewrite)
 *   5. Phase 3 + 5c — merges (write target body with computed frontmatter dates, then rm Pending)
 *
 * Frontmatter dates: extracted from \\d{4}-\\d{2}-\\d{2} matches in the merge_body
 * (covers wikilink targets like [[2026-04-25 — Evening Checkin]] and inline dates).
 * If the merge body has no dated wikilinks, falls back to the existing target's
 * frontmatter dates rather than dropping them.
 *
 * After apply, the script prints next steps. It does NOT run \`pnpm sync:obsidian\`
 * because Remotely Save needs Obsidian open to push local→R2 first.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, readdirSync, mkdirSync, copyFileSync } from "fs";
import { join, basename, dirname } from "path";

const VAULT = "/Users/mitch/Projects/espejo/Artifacts";
const args = process.argv.slice(2);
const dryRun = !args.includes("--apply");
const outDir = args[0];

if (!outDir || !existsSync(`${outDir}/synthesis.json`)) {
  console.error("usage: pnpm dedup:apply <outDir> [--apply] [--skip likely_safe] [--override N=leg]");
  console.error("       <outDir> must contain synthesis.json from dedup:synth");
  process.exit(1);
}

const skipLikely = args.includes("--skip") && args[args.indexOf("--skip") + 1] === "likely_safe";
const overrides = {};
let oi = -1;
while ((oi = args.indexOf("--override", oi + 1)) >= 0) {
  const v = args[oi + 1];
  const [n, leg] = v.split("=");
  overrides[Number(n)] = leg;
}

const synth = JSON.parse(readFileSync(`${outDir}/synthesis.json`, "utf8"));
const log = (...a) => console.log((dryRun ? "[DRY] " : "") + a.join(" "));

// Defensive DEFER resolver (synth normally promotes true ties, so this is a
// safety net for old/hand-edited plans): among legs that wrote a merge_body for
// the resolved final_target, return the highest signal-recall one (score_breakdown
// is pre-sorted best-first), else null. Never an arbitrary hard-coded leg.
function bestLegWithBodyForTarget(s) {
  const ordered = (s.score_breakdown || []).map(x => x.leg);
  const pool = ordered.length ? ordered : Object.keys(s.merge_bodies || {});
  for (const leg of pool) {
    if (s.merge_bodies?.[leg] && s.classifications?.[leg]?.target === s.final_target) return leg;
  }
  return null;
}

const fp = (rel) => join(VAULT, rel);
const baseNoExt = (p) => basename(p, ".md");

// ─── snapshot ───────────────────────────────────────────────────────────────

const snapshot = `/tmp/dedup-snapshot-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
function takeSnapshot(plan) {
  if (dryRun) return;
  mkdirSync(`${snapshot}/Pending`, { recursive: true });
  mkdirSync(`${snapshot}/Insight`, { recursive: true });
  for (const s of plan) {
    if (s.source_path && existsSync(fp(s.source_path))) copyFileSync(fp(s.source_path), `${snapshot}/${s.source_path}`);
    if (s.final_target && existsSync(fp(s.final_target))) copyFileSync(fp(s.final_target), `${snapshot}/${s.final_target}`);
  }
  console.log(`[snapshot] ${snapshot}`);
}

// ─── inbound wikilink scan ──────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "Template") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function rewriteInbound(deletedRel, replacementRel) {
  const oldName = baseNoExt(deletedRel);
  const newName = replacementRel ? baseNoExt(replacementRel) : null;
  const re = new RegExp(`\\[\\[${oldName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(\\|[^\\]]+)?\\]\\]`, "g");
  let total = 0;
  for (const f of walk(VAULT)) {
    if (f === fp(deletedRel)) continue;
    const content = readFileSync(f, "utf8");
    if (!re.test(content)) continue;
    re.lastIndex = 0;
    const matches = (content.match(re) || []).length;
    if (newName) {
      const updated = content.replace(re, (_, alias) => `[[${newName}${alias || ""}]]`);
      log(`  rewrite ${matches}× [[${oldName}]] → [[${newName}]] in ${f.replace(VAULT + "/", "")}`);
      if (!dryRun) writeFileSync(f, updated);
    } else {
      log(`  ⚠️ ${matches}× orphan [[${oldName}]] in ${f.replace(VAULT + "/", "")}`);
    }
    total += matches;
  }
  if (total === 0) log(`  no inbound links for [[${oldName}]]`);
  return total;
}

// ─── frontmatter dates ──────────────────────────────────────────────────────

function recomputeDates(body) {
  // Restrict to dates inside wikilinks — those are the dated artifacts the
  // merge actually references. A free-floating YYYY-MM-DD in prose ("started
  // in 2024-01-01") shouldn't move the canonical frontmatter date.
  const dates = [...body.matchAll(/\[\[(\d{4}-\d{2}-\d{2})[^\]]*\]\]/g)].map(m => m[1]).sort();
  if (dates.length === 0) return null;
  return { created_at: dates[0], updated_at: dates[dates.length - 1] };
}

function existingDates(targetRel) {
  if (!existsSync(fp(targetRel))) return null;
  const content = readFileSync(fp(targetRel), "utf8");
  const c = content.match(/^created_at:\s*(\d{4}-\d{2}-\d{2})/m);
  const u = content.match(/^updated_at:\s*(\d{4}-\d{2}-\d{2})/m);
  if (!c && !u) return null;
  return { created_at: c?.[1] || u?.[1], updated_at: u?.[1] || c?.[1] };
}

function writeMerged(targetRel, body) {
  let dates = recomputeDates(body) || existingDates(targetRel);
  let fm = `---\nkind: insight\n`;
  if (dates) fm += `created_at: ${dates.created_at}\nupdated_at: ${dates.updated_at}\n`;
  fm += `---\n`;
  // Strip any existing frontmatter from body
  let b = body;
  if (b.startsWith("---")) {
    const end = b.indexOf("\n---\n", 4);
    if (end > -1) b = b.slice(end + 5);
  }
  b = b.replace(/^kind:\s*insight\s*\n/, "");
  const final = fm + b.trimStart();
  log(`  write: ${targetRel} (${final.length}b, dates ${dates?.created_at || "?"}–${dates?.updated_at || "?"})`);
  if (!dryRun) writeFileSync(fp(targetRel), final);
}

// ─── primitives ─────────────────────────────────────────────────────────────

function rm(rel) {
  if (!existsSync(fp(rel))) { log(`  SKIP rm (gone): ${rel}`); return; }
  log(`  rm: ${rel}`);
  if (!dryRun) unlinkSync(fp(rel));
}

function mv(srcRel, dstRel) {
  if (!existsSync(fp(srcRel))) { log(`  SKIP mv (gone): ${srcRel}`); return; }
  // No-op when src and dst are identical (e.g. Mode B Distinct case where the
  // Pending→Insight prefix swap is a no-op). Without this guard, the collision
  // branch below would rename the file to itself with a -1 suffix.
  if (srcRel === dstRel) { log(`  SKIP mv (src == dst): ${srcRel}`); return; }
  let target = dstRel;
  if (existsSync(fp(target))) {
    target = target.replace(/\.md$/, "-1.md");
    log(`  ⚠️ collision; suffixing: ${target}`);
  }
  log(`  mv: ${srcRel} → ${target}`);
  if (!dryRun) renameSync(fp(srcRel), fp(target));
}

// ─── execute ────────────────────────────────────────────────────────────────

// Only skip rows that genuinely need a human call: split-vote MERGES (which need
// a body picked) and DEFER cases (which need a target picked). A split-vote
// row whose final_action is already Distinct has no risky decision — promote it.
const needsManualCall = (s) =>
  s.consensus === "needs_review" && (s.final_action !== "Distinct" || s.recommended_pick === "DEFER");
const plan = synth.plan.filter(s => skipLikely ? s.consensus === "auto_safe" : !needsManualCall(s));
const skipped = synth.plan.filter(s => !plan.includes(s));
console.log(`Plan: ${plan.length}/${synth.plan.length} actions (${dryRun ? "DRY RUN" : "APPLY"}${skipLikely ? ", auto-safe only" : ""})`);
if (skipped.length) console.log(`Skipped (need manual call): ${skipped.map(s => s.source_path.replace(/^Pending\//, "")).join(", ")}`);
takeSnapshot(plan);

const distincts = plan.filter(s => s.final_action === "Distinct");
const dups      = plan.filter(s => s.final_action === "Duplicate");
const merges    = plan.filter(s => s.final_action === "Merge");
const skips     = plan.filter(s => s.final_action === "Skip");

if (skips.length) {
  console.log();
  console.log(`=== Skipped (${skips.length}) — reciprocal-merge cycle reverse ===`);
  for (const s of skips) {
    log(`  ⏭️ ${s.source_path} (cycle-paired with ${s.coalesce_cycle_paired_with}; primary removes this file)`);
  }
}

// Track which Pending paths get promoted to Insight by Distinct phase, so the
// Merge phase can redirect targets that pointed to a now-empty Pending path.
// Without this, a Pending file that's both a Distinct source AND a Merge target
// gets mv'd to Insight/ by Distinct, then Merge writes a NEW file at the empty
// Pending/ path — leaving stale + canonical bodies for the same insight.
const promotedToInsight = new Map();

console.log();
// In Mode A, Distinct sources live in Pending/ and the Pending→Insight rewrite
// promotes them. In Mode B, sources are already in Insight/ so the prefix swap
// is a no-op and the file is left in place. Same code path covers both — the
// `mv` helper detects src == dst and skips.
console.log(`=== Distinct (${distincts.length}) — promote Pending→Insight, no-op in Mode B ===`);
for (const s of distincts) {
  log(`Distinct ${s.source_path}`);
  const dst = s.source_path.replace(/^Pending\//, "Insight/");
  // Mirror mv()'s collision-suffix logic so the redirect targets the right path.
  const actualDst = existsSync(fp(dst)) && s.source_path !== dst ? dst.replace(/\.md$/, "-1.md") : dst;
  promotedToInsight.set(s.source_path, actualDst);
  mv(s.source_path, dst);
}

console.log();
console.log(`=== Duplicate deletes (${dups.length}) ===`);
for (const s of dups) {
  log(`Delete ${s.source_path} (dup of ${s.final_target})`);
  rewriteInbound(s.source_path, s.final_target);
  rm(s.source_path);
}

// Preview-aligned merge numbering: position in the full synth.plan among
// non-supersede Merges (matches the ### N. numbering in preview.md). Apply's
// filter can drop merges, which used to shift sequential counters and break
// `--override N=leg`. Map by source_path instead so overrides stay stable.
const previewMergeNum = new Map();
{ let pmn = 0;
  for (const s of synth.plan) {
    if (s.final_action === "Merge" && !s.is_supersede) { pmn++; previewMergeNum.set(s.source_path, pmn); }
  } }

console.log();
console.log(`=== Merges (${merges.length}) ===`);
const deferFallbacks = [];
for (const s of merges) {
  const mergeNum = previewMergeNum.get(s.source_path);
  let pick = overrides[mergeNum] || s.recommended_pick;
  if (pick === "DEFER") {
    // Plurality/tie resolution now lives in synth: a genuine tie is promoted to
    // Distinct, so a Merge should never carry DEFER. If one slips through (an
    // older synthesis.json, or a hand-edit), do NOT pick an arbitrary leg.
    // Honor an explicit override; otherwise choose the highest-recall leg that
    // actually wrote a body for the resolved target, and skip loudly if none.
    if (overrides[mergeNum]) {
      pick = overrides[mergeNum];
      log(`  ⚠️ Was DEFER — using override ${pick}`);
    } else {
      pick = bestLegWithBodyForTarget(s);
      if (!pick) {
        console.error(`  ⚠️ DEFER with no leg body for target ${s.final_target} — SKIPPING merge #${mergeNum}: ${s.source_path}. Re-run synth, or pass --override ${mergeNum}=<leg>.`);
        deferFallbacks.push({ num: mergeNum, source: s.source_path, target: s.final_target, pick: "(skipped — no body)" });
        continue;
      }
      log(`  ⚠️ Was DEFER — recall-picked ${pick} (has a body for ${s.final_target})`);
      deferFallbacks.push({ num: mergeNum, source: s.source_path, target: s.final_target, pick });
    }
  }
  let target = s.final_target;
  // If picked leg routed to a different target, use that
  if (s.classifications[pick]?.target && s.classifications[pick].target !== target) {
    log(`  ⚠️ ${pick} routed to different target: ${s.classifications[pick].target}`);
    target = s.classifications[pick].target;
  }
  // If the target was promoted to Insight by the Distinct phase, follow it.
  // Otherwise the merge writes a new file at the now-empty Pending path.
  if (promotedToInsight.has(target)) {
    const promoted = promotedToInsight.get(target);
    log(`  ↪️ target ${target} was promoted; redirecting to ${promoted}`);
    target = promoted;
  }
  const body = s.merge_bodies[pick];
  if (!body) { console.error(`  MISSING BODY (${pick}) for merge #${mergeNum}: ${s.source_path}`); continue; }
  log(`Merge #${mergeNum} ${s.source_path} → ${target} (using ${pick})`);
  writeMerged(target, body);
  // Pending→Pending merges (typical when both files in a cycle-coalesced pair
  // were still pending) leave the merged content in Pending/, which then re-
  // enters the next dedup pool. Promote to Insight/ so the merge is complete.
  if (target.startsWith("Pending/")) {
    const desiredDst = target.replace(/^Pending\//, "Insight/");
    const actualDst = existsSync(fp(desiredDst)) ? desiredDst.replace(/\.md$/, "-1.md") : desiredDst;
    log(`  ↪️ post-merge promote: ${target} → ${actualDst}`);
    mv(target, desiredDst);
    target = actualDst;
  }
  rewriteInbound(s.source_path, target);
  rm(s.source_path);
}

console.log();
if (deferFallbacks.length) {
  console.log(`=== ⚠️ DEFER fallbacks (${deferFallbacks.length}) — review and override if needed ===`);
  for (const d of deferFallbacks) {
    const shortS = d.source.replace(/^Pending\//, "").replace(/\.md$/, "");
    const shortT = d.target?.replace(/^(Pending|Insight)\//, "").replace(/\.md$/, "") || "—";
    console.log(`  #${d.num} ${shortS} → ${shortT} (silently picked: ${d.pick})`);
  }
  console.log(`  To override: rerun with --override ${deferFallbacks.map(d => `${d.num}=<leg>`).join(" --override ")}`);
  console.log();
}
console.log("=== Done ===");
if (dryRun) {
  console.log();
  console.log("This was a DRY RUN. Re-run with --apply to mutate.");
} else {
  console.log();
  console.log(`Snapshot: ${snapshot}`);
  console.log();
  console.log("Next steps:");
  console.log("  1. Open Obsidian — Remotely Save will push local → R2 (a few seconds)");
  console.log("  2. Run \`pnpm sync:obsidian\` — pulls R2 → DB");
  console.log("  3. Postcheck: \`pnpm dedup:retrieve --mode existing --threshold 0.20 > /tmp/dedup-postcheck.json\`");
  console.log("     Then \`jq '.pair_count' /tmp/dedup-postcheck.json\` — should be near 0");
}
