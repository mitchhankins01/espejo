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
  const dates = [...body.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]).sort();
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
  let target = dstRel;
  if (existsSync(fp(target))) {
    target = target.replace(/\.md$/, "-1.md");
    log(`  ⚠️ collision; suffixing: ${target}`);
  }
  log(`  mv: ${srcRel} → ${target}`);
  if (!dryRun) renameSync(fp(srcRel), fp(target));
}

// ─── execute ────────────────────────────────────────────────────────────────

const plan = synth.plan.filter(s => skipLikely ? s.consensus === "auto_safe" : s.consensus !== "needs_review");
console.log(`Plan: ${plan.length}/${synth.plan.length} actions (${dryRun ? "DRY RUN" : "APPLY"}${skipLikely ? ", auto-safe only" : ""})`);
takeSnapshot(plan);

const promotes = plan.filter(s => s.final_action === "Distinct");
const dups     = plan.filter(s => s.final_action === "Duplicate");
const merges   = plan.filter(s => s.final_action === "Merge");

console.log();
console.log(`=== Promotions (${promotes.length}) ===`);
for (const s of promotes) {
  log(`Promote ${s.source_path}`);
  // Promote = mv Pending → Insight (or keep folder if source is Pending vs Pending dup'd elsewhere)
  const dst = s.source_path.replace(/^Pending\//, "Insight/");
  mv(s.source_path, dst);
}

console.log();
console.log(`=== Duplicate deletes (${dups.length}) ===`);
let mergeNum = 0;
for (let i = 0; i < dups.length; i++) {
  const s = dups[i];
  log(`Delete ${s.source_path} (dup of ${s.final_target})`);
  rewriteInbound(s.source_path, s.final_target);
  rm(s.source_path);
}

console.log();
console.log(`=== Merges (${merges.length}) ===`);
for (let i = 0; i < merges.length; i++) {
  mergeNum++;
  const s = merges[i];
  let pick = overrides[mergeNum] || s.recommended_pick;
  if (pick === "DEFER") {
    // Default to gemini if user didn't override
    pick = overrides[mergeNum] || "gemini";
    log(`  ⚠️ Was DEFER — falling back to ${pick}`);
  }
  let target = s.final_target;
  // If picked leg routed to a different target, use that
  if (s.classifications[pick]?.target && s.classifications[pick].target !== target) {
    log(`  ⚠️ ${pick} routed to different target: ${s.classifications[pick].target}`);
    target = s.classifications[pick].target;
  }
  const body = s.merge_bodies[pick];
  if (!body) { console.error(`  MISSING BODY (${pick}) for merge #${mergeNum}: ${s.source_path}`); continue; }
  log(`Merge #${mergeNum} ${s.source_path} → ${target} (using ${pick})`);
  writeMerged(target, body);
  rewriteInbound(s.source_path, target);
  rm(s.source_path);
}

console.log();
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
