/**
 * Write the next tomo(s) of the Espejo series.
 *
 * Flow:
 *   1. pnpm tsx scripts/write-tomo.ts --plan-only        # plan 6 anchored-essay candidates
 *   2. pnpm tsx scripts/write-tomo.ts --pick=3           # write one
 *      pnpm tsx scripts/write-tomo.ts --pick=2,3,5       # write several IN PARALLEL (cap 2)
 *
 * This script writes Spanish markdown (books/tomos/NNNN.md) and records history.
 * It does NOT build EPUBs, interleave the bilingual edition, or send to Kindle —
 * that is Phase 4 (scripts/book/rebuild-tomo.ts), run after Phase-3 review.
 *
 * Other flags:
 *   --dry              # plan + write, print to stdout, no files/history (requires --pick)
 *   --steer "..."      # nudge the planner with editorial direction (use with --plan-only)
 *   --fresh-plan       # delete books/next-plan.json before reading
 *
 * Plan persistence: `--plan-only` writes books/next-plan.json with all 6 candidates.
 * `--pick` reuses that file; successfully-written candidates are dropped from the
 * plan and tomo_n is bumped so the remainder stay pickable. Source UUIDs hidden by
 * the recent-exclusion filter are fetched directly by UUID so the writer sees them.
 */

import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { pool } from "../src/db/client.js";
import {
  readHistory,
  appendHistory,
  nextTomoNumber,
  recentSourceUuids,
  recentTomoSummaries,
} from "./book/state.js";
import {
  gatherContext,
  gatherLongArcContext,
  fetchContextByUuid,
  type ContextItem,
} from "./book/context.js";
import { plan, type Candidate, type PlannerOutput } from "./book/planner.js";
import { write, countWords } from "./book/writer.js";
import { checkTildes } from "./book/coverage-checks.js";
import {
  formatLookupsForWriter,
  readLookups,
  recentLookups,
  type LookupStateTag,
} from "./book/lookups.js";
import {
  classifyVocabState,
  getVocabStateForStems,
} from "../src/db/queries/vocab-reviews.js";
import {
  formatHighlightsForWriter,
  readHighlights,
  recentHighlights,
} from "./book/highlights.js";
import {
  formatSeriesQueueForPlanner,
  readSeriesQueue,
} from "./book/series-queue.js";
import {
  academicCorpusSize,
  matchAcademic,
  formatAcademicForWriter,
} from "./book/academic.js";
import {
  fetchRecentSpanishEntries,
  generateReaderLevelParagraph,
} from "./book/reader-level.js";

const TOMOS_DIR = "books/tomos";
const PLAN_PATH = "books/next-plan.json";
const FLOOR_WORDS = 3600;
const CEILING_WORDS = 4400;
const WRITE_CONCURRENCY = 2;

interface SavedPlan {
  tomo_n: number;
  saved_at: string;
  reader_level?: string;
  candidates: Candidate[];
}

async function loadSavedPlan(
  expectedTomoN: number
): Promise<{ candidates: Candidate[]; readerLevel: string | undefined } | null> {
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
  return { candidates: saved.candidates, readerLevel: saved.reader_level };
}

/** After a batch, drop successfully-written ids and point the plan at the next number. */
async function updatePlanAfterBatch(
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
  const payload: SavedPlan = {
    tomo_n: nextTomoN,
    saved_at: saved.saved_at,
    reader_level: saved.reader_level,
    candidates: remaining,
  };
  await writeFile(PLAN_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

async function savePlannerOutput(
  tomoN: number,
  p: PlannerOutput,
  readerLevel: string
): Promise<void> {
  const payload: SavedPlan = {
    tomo_n: tomoN,
    saved_at: new Date().toISOString(),
    reader_level: readerLevel,
    candidates: p.candidates,
  };
  await writeFile(PLAN_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

async function clearSavedPlan(): Promise<void> {
  if (existsSync(PLAN_PATH)) await unlink(PLAN_PATH).catch(() => {});
}

interface Args {
  planOnly: boolean;
  picks: number[];
  dry: boolean;
  steer?: string;
  freshPlan: boolean;
}

function parseArgs(): Args {
  const argv = process.argv;
  const steerIdx = argv.indexOf("--steer");
  const steer = steerIdx >= 0 ? argv[steerIdx + 1] : process.env.STEER;

  const picks: number[] = [];
  for (const a of argv) {
    if (a.startsWith("--pick=")) {
      const list = a.slice("--pick=".length).split(",");
      for (const tok of list) {
        const v = Number(tok.trim());
        if (!Number.isInteger(v) || v < 1 || v > 6) {
          throw new Error(`--pick values must be integers 1-6, got "${tok}"`);
        }
        if (!picks.includes(v)) picks.push(v);
      }
    }
  }
  picks.sort((a, b) => a - b);

  const planOnly = argv.includes("--plan-only");
  if (planOnly && picks.length > 0) {
    throw new Error("--plan-only and --pick cannot be combined");
  }

  return {
    planOnly,
    picks,
    dry: argv.includes("--dry"),
    steer,
    freshPlan: argv.includes("--fresh-plan"),
  };
}

function printCandidates(candidates: Candidate[]): void {
  const sorted = [...candidates].sort((a, b) => a.id - b.id);
  for (const c of sorted) {
    console.log(`\n  [${c.id}] ${c.domain}`);
    console.log(`      "${c.title}"`);
    console.log(`      topic: ${c.topic}`);
    console.log(`      angle: ${c.angle}`);
    console.log(`      sources: ${c.source_refs.length}`);
    console.log(`      take: ${c.take}`);
  }
}

async function mapWithConcurrency<T, R>(
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

interface WrittenTomo {
  n: number;
  candidate: Candidate;
  words: number;
}

async function writeOne(
  candidate: Candidate,
  n: number,
  allContext: ContextItem[],
  lookupsBlock: string,
  highlightsBlock: string,
  hasAcademicCorpus: boolean,
  dry: boolean
): Promise<WrittenTomo> {
  const padded = String(n).padStart(4, "0");
  console.log(
    `\n[tomo ${padded}] "${candidate.title}" (${candidate.domain})`
  );

  let academicBlock = "";
  if (hasAcademicCorpus) {
    const matches = await matchAcademic(candidate);
    if (matches.length > 0) {
      academicBlock = formatAcademicForWriter(matches);
      console.log(
        `      [${padded}] academic grounding: ${matches.length} paper(s) — ${matches
          .map((m) => m.similarity.toFixed(2))
          .join(", ")}`
      );
    } else {
      console.log(`      [${padded}] academic grounding: no strong match`);
    }
  }

  const markdown = await write(
    candidate,
    allContext,
    lookupsBlock,
    highlightsBlock,
    academicBlock
  );
  const counts = countWords(markdown);
  console.log(`      [${padded}] ${counts.total} words`);
  if (counts.total < FLOOR_WORDS || counts.total > CEILING_WORDS) {
    console.warn(
      `      [${padded}] WARN: word count ${counts.total} outside ${FLOOR_WORDS}-${CEILING_WORDS} band`
    );
  }

  const tildes = checkTildes(markdown);
  for (const h of tildes.hits) {
    console.warn(
      `      [${padded}] WARN: tilde slip "${h.word}" → "${h.correction}" (${h.count}x)`
    );
  }

  if (dry) {
    console.log(`\n--- dry run: tomo ${padded} (not saved) ---\n`);
    console.log(markdown);
  } else {
    await mkdir(TOMOS_DIR, { recursive: true });
    await writeFile(join(TOMOS_DIR, `${padded}.md`), markdown, "utf-8");
    console.log(`      [${padded}] saved books/tomos/${padded}.md`);
  }

  return { n, candidate, words: counts.total };
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.freshPlan) {
    await clearSavedPlan();
    console.log("[fresh-plan] cleared books/next-plan.json");
  }

  console.log("[1/4] reading history");
  const history = await readHistory();
  const n = nextTomoNumber(history);
  const excluded = recentSourceUuids(history, 30);
  const recent = recentTomoSummaries(history, 30);
  console.log(`      tomo #${n}, ${history.length} prior, ${excluded.size} UUIDs excluded`);

  console.log("[2/4] gathering context (recent 14d + long-arc 365d)");
  const context = await gatherContext(excluded, 14);
  const recentUuids = new Set(context.map((c) => c.uuid));
  const longArc = await gatherLongArcContext(excluded, recentUuids, 365);
  console.log(
    `      recent: ${context.length} items (${context.filter((c) => c.kind === "entry").length} entries, ${context.filter((c) => c.kind === "insight").length} insights)`
  );
  console.log(`      long-arc: ${longArc.length} insights from last 365d`);
  if (context.length < 3) {
    throw new Error(
      `Only ${context.length} usable context items in the last 14 days. ` +
        `Either journal more, widen the window, or reduce excluded UUIDs.`
    );
  }

  if (args.planOnly) {
    console.log("[3/4] planning 6 candidates + reader-level snapshot");
    if (args.steer) {
      const preview = args.steer.slice(0, 120);
      console.log(`      steering planner with: ${preview}${args.steer.length > 120 ? "..." : ""}`);
    }
    const seriesQueueRaw = await readSeriesQueue();
    const seriesQueueBlock = formatSeriesQueueForPlanner(seriesQueueRaw);
    if (seriesQueueRaw.length > 0) {
      const veinCount = seriesQueueRaw
        .split("\n")
        .filter((l) => /^\s*-\s+/.test(l)).length;
      console.log(
        `      injecting series queue (${veinCount} active vein${veinCount === 1 ? "" : "s"})`
      );
    }
    const [output, readerLevel] = await Promise.all([
      plan(recent, longArc, context, args.steer, seriesQueueBlock),
      fetchRecentSpanishEntries(90, 5).then(generateReaderLevelParagraph),
    ]);
    await savePlannerOutput(n, output, readerLevel);
    console.log(`      saved 6 candidates to ${PLAN_PATH}`);
    console.log("\n--- candidates ---");
    printCandidates(output.candidates);
    console.log(`\nPick with: pnpm tsx scripts/write-tomo.ts --pick=<ids,comma,separated>`);
    await pool.end();
    return;
  }

  if (args.picks.length === 0) {
    console.error(
      "[error] no candidate selected. Run with --plan-only first, then --pick=<ids>."
    );
    await pool.end();
    process.exit(2);
  }

  console.log(`[3/4] loading plan and picking ${args.picks.join(", ")}`);
  const loaded = await loadSavedPlan(n);
  if (!loaded) {
    console.error(`[error] no saved plan for tomo #${n}. Run --plan-only first.`);
    await pool.end();
    process.exit(2);
  }
  const { candidates } = loaded;
  const picked: Candidate[] = [];
  for (const id of args.picks) {
    const c = candidates.find((x) => x.id === id);
    if (!c) {
      console.error(
        `[error] candidate #${id} not in saved plan. Available ids: ${candidates.map((x) => x.id).join(", ")}`
      );
      await pool.end();
      process.exit(2);
    }
    picked.push(c);
  }

  // Freeze context once; rescue any source UUIDs the recent-exclusion filter hid.
  const allContext = [...longArc, ...context];
  const validUuids = new Set(allContext.map((c) => c.uuid));
  const missing = [
    ...new Set(picked.flatMap((c) => c.source_refs).filter((u) => !validUuids.has(u))),
  ];
  if (missing.length > 0) {
    const rescued = await fetchContextByUuid(missing);
    if (rescued.length > 0) {
      console.log(`      rescuing ${rescued.length} excluded source UUID(s)`);
      allContext.push(...rescued);
      rescued.forEach((c) => validUuids.add(c.uuid));
    }
    const stillMissing = picked
      .flatMap((c) => c.source_refs)
      .filter((u) => !validUuids.has(u));
    if (stillMissing.length > 0) {
      throw new Error(
        `Picked candidate(s) reference source UUIDs not in DB: ${[...new Set(stillMissing)].join(", ")}. Re-plan with --fresh-plan + --plan-only.`
      );
    }
  }

  // Shared writer inputs (computed once, reused across the batch).
  const lookups = await readLookups();
  const recentLookupRows = recentLookups(lookups, 30);
  const stateMap = await getVocabStateForStems(
    pool,
    recentLookupRows.map((l) => l.stem)
  );
  const stateByStem = new Map<string, LookupStateTag | null>();
  for (const l of recentLookupRows) {
    stateByStem.set(
      l.stem.toLowerCase(),
      classifyVocabState(stateMap.get(l.stem.toLowerCase()))
    );
  }
  const lookupsBlock = formatLookupsForWriter(recentLookupRows, stateByStem);
  const highlightsBlock = formatHighlightsForWriter(
    recentHighlights(await readHighlights(), 12)
  );

  const corpusSize = await academicCorpusSize();
  if (corpusSize === 0) {
    console.warn(
      "      WARN: no embedded Reference/Academic papers found — academic grounding disabled (run pnpm sync:obsidian + pnpm embed:prod to enable)"
    );
  } else {
    console.log(`      academic corpus: ${corpusSize} embedded paper(s) available`);
  }

  // Assign tomo numbers up front, in pick order, then write in parallel (cap 2).
  console.log(
    `[4/4] writing ${picked.length} tomo(s) #${n}-${n + picked.length - 1} (concurrency ${WRITE_CONCURRENCY})`
  );
  const numbered = picked.map((c, i) => ({ c, n: n + i }));
  const results = await mapWithConcurrency(
    numbered,
    WRITE_CONCURRENCY,
    ({ c, n: tomoN }) =>
      writeOne(
        c,
        tomoN,
        allContext,
        lookupsBlock,
        highlightsBlock,
        corpusSize > 0,
        args.dry
      )
  );

  const written: WrittenTomo[] = [];
  const failed: { id: number; n: number; error: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") written.push(r.value);
    else
      failed.push({
        id: numbered[i].c.id,
        n: numbered[i].n,
        error: (r.reason as Error)?.message ?? String(r.reason),
      });
  });

  if (!args.dry) {
    // History append is read-modify-write — serialize it after the parallel pass.
    for (const w of written.sort((a, b) => a.n - b.n)) {
      await appendHistory({
        n: w.n,
        title: w.candidate.title,
        format: "essay",
        domain: w.candidate.domain,
        topic: w.candidate.topic,
        source_uuids: w.candidate.source_refs,
        date: new Date().toISOString().slice(0, 10),
        word_count: w.words,
        bilingual: true,
      });
    }
    const afterHistory = await readHistory();
    await updatePlanAfterBatch(
      written.map((w) => w.candidate.id),
      nextTomoNumber(afterHistory)
    );
  }

  console.log("\n=== batch summary ===");
  for (const w of written.sort((a, b) => a.n - b.n)) {
    console.log(`  ✓ tomo ${String(w.n).padStart(4, "0")} — "${w.candidate.title}" (${w.words}w)`);
  }
  for (const f of failed) {
    console.log(`  ✗ tomo ${String(f.n).padStart(4, "0")} (candidate #${f.id}) — ${f.error}`);
  }
  if (!args.dry && written.length > 0) {
    console.log(
      "\nReview books/tomos/NNNN.md, fix in place, then deliver each with:\n  NODE_ENV=production pnpm tsx scripts/book/rebuild-tomo.ts NNNN [--no-send]"
    );
  }
  console.log("=====================\n");

  await pool.end();
  if (failed.length > 0 && written.length === 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
