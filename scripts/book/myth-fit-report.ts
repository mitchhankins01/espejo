/**
 * Score the mythology corpus against the current context. Diagnostic only — no plan written, no tomo produced.
 *
 * Usage:
 *   pnpm tsx scripts/book/myth-fit-report.ts
 *
 * Useful for:
 * - Sanity-checking a freshly-edited corpus
 * - Phase-1 manual review when forcing --format=myth
 * - Detecting corpus rot: myths that haven't fired in 90+ days and never score above ~5
 */

import { pool } from "../../src/db/client.js";
import {
  readHistory,
  recentMythNames,
  recentSourceUuids,
} from "./state.js";
import { gatherContext, gatherLongArcContext } from "./context.js";
import { readMyths } from "./myths.js";
import { scoreMyths } from "./myth-scorer.js";

async function main(): Promise<void> {
  const myths = await readMyths();
  if (myths.length === 0) {
    console.log("No myths in corpus (books/myths.jsonl). Add entries with `pnpm tsx scripts/book/add-myth.ts`.");
    await pool.end();
    return;
  }

  const history = await readHistory();
  const excluded = recentSourceUuids(history, 30);
  const recentMyths = recentMythNames(history, 8);

  const context = await gatherContext(excluded, 14);
  const recentUuids = new Set(context.map((c) => c.uuid));
  const longArc = await gatherLongArcContext(excluded, recentUuids, 365);

  console.log(
    `[fit-report] corpus: ${myths.length} myths · context: ${context.length} recent + ${longArc.length} long-arc · excluded: ${recentMyths.size} recent myth-names`
  );
  if (recentMyths.size > 0) {
    console.log(`[fit-report] excluded: ${Array.from(recentMyths).join(", ")}`);
  }

  const lastFiredByName = new Map<string, number>();
  for (const r of history) {
    if (r.myth_name) {
      lastFiredByName.set(r.myth_name, r.n);
    }
  }

  console.log("[fit-report] scoring (this calls Claude once)…");
  const scored = await scoreMyths(myths, context, longArc, recentMyths);

  console.log("\n  myth                              score   last fired   reason");
  console.log("  ───────────────────────────────── ─────── ──────────── ─────────────────────────────");
  for (const s of scored) {
    const lastFired = lastFiredByName.has(s.name)
      ? `tomo ${String(lastFiredByName.get(s.name)).padStart(4, "0")}`
      : "never       ";
    const name = s.name.padEnd(33);
    const score = s.score.toFixed(1).padStart(5);
    const reason = s.reason.length > 70 ? s.reason.slice(0, 67) + "..." : s.reason;
    console.log(`  ${name} ${score}   ${lastFired} ${reason}`);
  }

  const top = scored[0];
  if (top) {
    console.log("");
    if (top.score >= 7) {
      console.log(`[fit-report] strong fit: ${top.name} (${top.score.toFixed(1)}) — myth-mode would auto-fire`);
    } else if (top.score >= 5) {
      console.log(`[fit-report] partial fit: ${top.name} (${top.score.toFixed(1)}) — myth-mode would NOT auto-fire; --format=myth would force this myth`);
    } else {
      console.log(`[fit-report] no strong fit (max score ${top.score.toFixed(1)}) — myth-mode would NOT auto-fire`);
    }
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
