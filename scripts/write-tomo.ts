/**
 * Write the next tomo of the Espejo series.
 *
 * Two-step flow:
 *   1. pnpm tsx scripts/write-tomo.ts --plan-only         # plan 6 candidates (3 essay + 3 flow), save, print
 *   2. pnpm tsx scripts/write-tomo.ts --pick=<id>         # write that candidate + epub + email
 *
 * Other flags:
 *   --dry              # plan + write, print to stdout, no files, no email (requires --pick)
 *   --no-send          # everything except the email
 *   --bilingual        # render ES + EN side-by-side without prompting
 *   --no-bilingual     # skip the bilingual prompt, ship ES-only
 *   --share-julia      # send unshared tomos to Julia after Mitch's send
 *   --no-share-julia   # skip Julia-share prompt
 *   --steer "..."      # nudge the planner with editorial direction (use with --plan-only)
 *   --fresh-plan       # delete books/next-plan.json before reading (forces re-plan on next --plan-only)
 *
 * If neither --bilingual nor --no-bilingual is passed, a TTY prompt asks after the tomo is written.
 *
 * Plan persistence: `--plan-only` writes books/next-plan.json with all 6 candidates.
 * `--pick=<id>` reuses that file; on success, drops the picked candidate from the plan
 * and bumps tomo_n so the remaining candidates stay pickable across sequential writes.
 * The file is deleted once all candidates are picked. Source UUIDs that the new tomo's
 * recent-exclusion filter would normally hide are fetched directly by UUID so the
 * writer still sees their bodies.
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
} from "./book/context.js";
import { plan, type Candidate, type PlannerOutput } from "./book/planner.js";
import { write, countWords, splitTomo } from "./book/writer.js";
import {
  checkOpenQuestionsCoverage,
  checkTildes,
  findUnmappedQuestions,
  findLongGlosses,
} from "./book/coverage-checks.js";
import { interleave } from "./book/bilingual.js";
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
  formatOpenQuestionsForWriter,
  readOpenQuestions,
} from "./book/open-questions.js";
import {
  formatSeriesQueueForPlanner,
  readSeriesQueue,
} from "./book/series-queue.js";
import { buildEpub, tomoFilename } from "./book/epub.js";
import { sendToKindle } from "./book/send.js";
import { offerJuliaShare, type ShareJuliaMode } from "./book/share.js";
import {
  fetchRecentSpanishEntries,
  generateReaderLevelParagraph,
} from "./book/reader-level.js";
import { config } from "../src/config.js";

const TOMOS_DIR = "books/tomos";
const BUILD_DIR = "books/build";
const PLAN_PATH = "books/next-plan.json";

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
    console.warn(
      `      ${PLAN_PATH} has no candidates left — ignoring`
    );
    await unlink(PLAN_PATH).catch(() => {});
    return null;
  }
  return { candidates: saved.candidates, readerLevel: saved.reader_level };
}

async function dropPickedFromPlan(
  pickedId: number,
  nextTomoN: number
): Promise<void> {
  if (!existsSync(PLAN_PATH)) return;
  const raw = await readFile(PLAN_PATH, "utf-8");
  const saved = JSON.parse(raw) as SavedPlan;
  const remaining = saved.candidates.filter((c) => c.id !== pickedId);
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
  pick?: number;
  dry: boolean;
  send: boolean;
  steer?: string;
  bilingual?: boolean;
  shareJulia: ShareJuliaMode;
  freshPlan: boolean;
}

function parseArgs(): Args {
  const argv = process.argv;
  const steerIdx = argv.indexOf("--steer");
  const steer = steerIdx >= 0 ? argv[steerIdx + 1] : process.env.STEER;

  let bilingual: boolean | undefined;
  if (argv.includes("--bilingual")) bilingual = true;
  else if (argv.includes("--no-bilingual")) bilingual = false;

  let shareJulia: ShareJuliaMode;
  if (argv.includes("--share-julia")) shareJulia = "yes";
  else if (argv.includes("--no-share-julia")) shareJulia = "skip";
  else shareJulia = process.stdin.isTTY ? "prompt" : "skip";

  let pick: number | undefined;
  for (const a of argv) {
    if (a.startsWith("--pick=")) {
      const v = Number(a.slice("--pick=".length));
      if (!Number.isInteger(v) || v < 1 || v > 6) {
        throw new Error(`--pick must be an integer 1-6, got "${a.slice("--pick=".length)}"`);
      }
      pick = v;
    }
  }

  const planOnly = argv.includes("--plan-only");
  if (planOnly && pick !== undefined) {
    throw new Error("--plan-only and --pick=<id> cannot be combined");
  }

  return {
    planOnly,
    pick,
    dry: argv.includes("--dry"),
    send: !argv.includes("--no-send"),
    steer,
    bilingual,
    shareJulia,
    freshPlan: argv.includes("--fresh-plan"),
  };
}

async function askBilingual(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = await import("readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      "[bilingual] Render this tomo as ES + EN sentence-by-sentence? [y/N] "
    );
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

function printCandidates(candidates: Candidate[]): void {
  const sorted = [...candidates].sort((a, b) => a.id - b.id);
  for (const c of sorted) {
    console.log(`\n  [${c.id}] ${c.format.toUpperCase()} · ${c.domain}`);
    console.log(`      "${c.title}"`);
    console.log(`      topic: ${c.topic}`);
    console.log(`      angle: ${c.angle}`);
    console.log(`      sources: ${c.source_refs.length}`);
    console.log(`      take: ${c.take}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  const batchIdx = process.env.BATCH_INDEX;
  const batchTotal = process.env.BATCH_TOTAL;
  if (batchIdx && batchTotal) {
    console.log(`\n==== batch tomo ${batchIdx}/${batchTotal} ====`);
  }

  if (args.freshPlan) {
    await clearSavedPlan();
    console.log("[fresh-plan] cleared books/next-plan.json");
  }

  console.log("[1/5] reading history");
  const history = await readHistory();
  const n = nextTomoNumber(history);
  const excluded = recentSourceUuids(history, 30);
  const recent = recentTomoSummaries(history, 30);
  console.log(`      tomo #${n}, ${history.length} prior, ${excluded.size} UUIDs excluded`);

  console.log("[2/5] gathering context (recent 14d + long-arc 365d)");
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
    console.log("[3/5] planning 6 candidates (Claude pass 1)");
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
    console.log("      planner (1) + reader-level snapshot (1b) in parallel");
    const [output, readerLevel] = await Promise.all([
      plan(recent, longArc, context, args.steer, seriesQueueBlock),
      fetchRecentSpanishEntries(90, 5).then(generateReaderLevelParagraph),
    ]);
    await savePlannerOutput(n, output, readerLevel);
    console.log(`      saved 6 candidates to ${PLAN_PATH}`);
    console.log("\n--- candidates ---");
    printCandidates(output.candidates);
    console.log(`\nPick one with: pnpm tsx scripts/write-tomo.ts --pick=<1-6>`);
    await pool.end();
    return;
  }

  if (args.pick === undefined) {
    console.error(
      "[error] no candidate selected. Run with --plan-only first, then --pick=<1-6>."
    );
    await pool.end();
    process.exit(2);
  }

  console.log(`[3/5] loading saved candidates and picking #${args.pick}`);
  const loaded = await loadSavedPlan(n);
  if (!loaded) {
    console.error(
      `[error] no saved plan for tomo #${n}. Run --plan-only first.`
    );
    await pool.end();
    process.exit(2);
  }
  const { candidates } = loaded;
  const picked = candidates.find((c) => c.id === args.pick);
  if (!picked) {
    console.error(
      `[error] candidate #${args.pick} not in saved plan. Available ids: ${candidates.map((c) => c.id).join(", ")}`
    );
    await pool.end();
    process.exit(2);
  }
  console.log(`      ${picked.format}/${picked.domain} — "${picked.title}"`);
  console.log(`      angle: ${picked.angle}`);
  console.log(`      sources: ${picked.source_refs.length}`);

  const allContext = [...longArc, ...context];
  const validUuids = new Set(allContext.map((c) => c.uuid));
  const missing = picked.source_refs.filter((u) => !validUuids.has(u));
  if (missing.length > 0) {
    const rescued = await fetchContextByUuid(missing);
    if (rescued.length > 0) {
      console.log(
        `      rescuing ${rescued.length} source UUID(s) excluded by recent-tomo filter`
      );
      allContext.push(...rescued);
      rescued.forEach((c) => validUuids.add(c.uuid));
    }
    const stillMissing = picked.source_refs.filter((u) => !validUuids.has(u));
    if (stillMissing.length > 0) {
      throw new Error(
        `Picked candidate references ${stillMissing.length} source UUIDs not in DB: ${stillMissing.join(", ")}. Re-plan with --fresh-plan + --plan-only.`
      );
    }
  }

  console.log("[4/5] writing (Claude pass 2)");
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
  if (lookups.length > 0) {
    console.log(
      `      injecting ${Math.min(lookups.length, 30)} recent lookups — vocab (${lookups.length} total)`
    );
  }
  const highlights = await readHighlights();
  const highlightsBlock = formatHighlightsForWriter(
    recentHighlights(highlights, 12)
  );
  if (highlights.length > 0) {
    console.log(
      `      injecting ${Math.min(highlights.length, 12)} recent highlights — grammar/conjugation (${highlights.length} total)`
    );
  }
  const openQuestions = await readOpenQuestions();
  const openQuestionsBlock = formatOpenQuestionsForWriter(openQuestions);
  if (openQuestions.length > 0) {
    console.log(
      `      injecting ${openQuestions.length} open Spanish question(s) — gloss every occurrence`
    );
    const unmapped = findUnmappedQuestions(openQuestions);
    if (unmapped.length > 0) {
      console.warn(
        `      WARN: ${unmapped.length} open question(s) have no coverage-check category — gloss coverage is unverified for: ${unmapped.join("; ")}. Add a category to QUESTION_KEYWORDS in scripts/book/coverage-checks.ts.`
      );
    }
  }
  const writtenMarkdown = await write(
    picked,
    allContext,
    lookupsBlock,
    highlightsBlock,
    openQuestionsBlock
  );
  const counts = countWords(writtenMarkdown);
  console.log(`      ${counts.total} words`);
  if (counts.total < 1700 || counts.total > 2700) {
    console.warn(`      WARN: word count ${counts.total} is outside 1800-2400 target`);
  }

  const tomoParts = splitTomo(writtenMarkdown);

  if (openQuestions.length > 0) {
    const coverage = checkOpenQuestionsCoverage(tomoParts.body);
    console.log(
      `      [open-questions check] ${coverage.totalGlosses} inline gloss(es)`
    );
    for (const q of coverage.perQuestion) {
      const mark = q.matches.length > 0 ? "✓" : "✗";
      console.log(`        ${mark} ${q.question}: ${q.matches.length}`);
    }
    if (coverage.missingQuestions.length > 0) {
      console.warn(
        `      WARN: no inline gloss detected for: ${coverage.missingQuestions.join(", ")}`
      );
    }
    const longGlosses = findLongGlosses(tomoParts.body);
    if (longGlosses.length > 0) {
      console.warn(
        `      WARN: ${longGlosses.length} gloss(es) over 12 words — tighten in review:`
      );
      for (const g of longGlosses) {
        console.warn(`        (${g.words}w) ${g.gloss}`);
      }
    }
  }

  const tildes = checkTildes(writtenMarkdown);
  if (tildes.hits.length === 0) {
    console.log("      [tilde check] none");
  } else {
    for (const h of tildes.hits) {
      console.warn(
        `      WARN: tilde slip "${h.word}" → "${h.correction}" (${h.count}x)`
      );
    }
  }

  const markdown = writtenMarkdown;

  if (args.dry) {
    console.log("\n--- dry run (tomo not saved) ---\n");
    console.log(markdown);
    await pool.end();
    return;
  }

  // Bilingual interleave is a SEND-TIME artifact. In the documented flow Phase 2
  // runs with --no-send, Phase 3 edits the ES markdown, and Phase 4
  // (rebuild-tomo --bilingual) regenerates the interleave from the reviewed ES.
  // Interleaving here would just be discarded by those edits — so only do it when
  // we're actually sending in this run. `wantsBilingual` still records intent.
  const wantsBilingual =
    args.bilingual !== undefined
      ? args.bilingual
      : args.send
        ? await askBilingual()
        : false;
  const builtBilingual = wantsBilingual && args.send;

  console.log("[5/5] packaging epub + recording history");
  const padded = String(n).padStart(4, "0");
  const tomoPath = join(TOMOS_DIR, `${padded}.md`);
  await mkdir(TOMOS_DIR, { recursive: true });
  await mkdir(BUILD_DIR, { recursive: true });
  await writeFile(tomoPath, markdown, "utf-8");

  let epubMarkdown = markdown;
  let filename = tomoFilename(n, picked.title);
  if (builtBilingual) {
    console.log("[bilingual] interleaving ES + EN");
    epubMarkdown = await interleave(markdown);
    const biPath = join(TOMOS_DIR, `${padded}-bilingual.md`);
    await writeFile(biPath, epubMarkdown, "utf-8");
    filename = filename.replace(/\.epub$/, " (bilingual).epub");
  } else if (wantsBilingual) {
    console.log(
      "[bilingual] deferred to Phase 4 — run `rebuild-tomo NNNN --bilingual` after review (interleaving now would be discarded by Phase-3 edits)"
    );
  }
  const epubPath = join(BUILD_DIR, filename);

  await buildEpub({
    tomoNum: n,
    title: picked.title,
    markdown: epubMarkdown,
    outPath: epubPath,
  });

  await appendHistory({
    n,
    title: picked.title,
    format: picked.format,
    domain: picked.domain,
    topic: picked.topic,
    source_uuids: picked.source_refs,
    date: new Date().toISOString().slice(0, 10),
    word_count: counts.total,
    bilingual: wantsBilingual,
  });
  await dropPickedFromPlan(picked.id, n + 1);

  const subject = `Espejo — Tomo ${padded} — ${picked.title}${builtBilingual ? " (bilingual)" : ""}`;

  if (args.send) {
    console.log(`[send] emailing ${filename} to ${config.gmail.kindleEmail}`);
    await sendToKindle({ epubPath, filename, subject });
    console.log("[send] sent");
    await offerJuliaShare({ mode: args.shareJulia });
  } else {
    console.log("\n=== SEND SKIPPED (--no-send) ===");
    console.log(`to: ${config.gmail.kindleEmail}`);
    console.log(`subject: ${subject}`);
    console.log(`attachment: ${epubPath}`);
    console.log("================================\n");
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
