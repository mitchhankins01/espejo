/**
 * Write the next tomo of the Espejo series.
 *
 * Usage:
 *   pnpm tsx scripts/write-tomo.ts                  # normal: (reuse saved plan if present) plan + write + epub + email
 *   pnpm tsx scripts/write-tomo.ts --plan-only      # stop after planner, print plan, save to books/next-plan.json
 *   pnpm tsx scripts/write-tomo.ts --dry            # plan + write, print to stdout, no files, no email
 *   pnpm tsx scripts/write-tomo.ts --no-send        # everything except the email
 *   pnpm tsx scripts/write-tomo.ts --bilingual      # render ES + EN side-by-side without prompting
 *   pnpm tsx scripts/write-tomo.ts --no-bilingual   # skip the bilingual prompt, ship ES-only
 *   pnpm tsx scripts/write-tomo.ts --steer "..."    # nudge the planner with editorial direction
 *   pnpm tsx scripts/write-tomo.ts --format=myth    # force myth-mode (planner picks corpus entry)
 *   pnpm tsx scripts/write-tomo.ts --format=essay   # force essay-mode regardless of corpus fit
 *   pnpm tsx scripts/write-tomo.ts --myth=Sísifo    # force myth-mode with a specific myth (implies --format=myth)
 *   pnpm tsx scripts/write-tomo.ts --no-myth        # alias for --format=essay (hard veto on myth-mode)
 *   pnpm tsx scripts/write-tomo.ts --fresh-plan     # delete books/next-plan.json before reading
 *
 * If neither --bilingual nor --no-bilingual is passed, a TTY prompt asks after the tomo is written.
 *
 * Plan persistence: `--plan-only` writes books/next-plan.json. A subsequent normal run
 * reuses that plan (matching on tomo number) and deletes the file after a successful write.
 * This prevents the non-deterministic planner from drifting between phase 1 and phase 2.
 */

import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { pool } from "../src/db/client.js";
import { ensureStyle } from "./book/style.js";
import {
  readHistory,
  appendHistory,
  nextTomoNumber,
  recentSourceUuids,
  recentTomoSummaries,
  recentMythNames,
} from "./book/state.js";
import { gatherContext, gatherLongArcContext } from "./book/context.js";
import { plan, type Plan } from "./book/planner.js";
import { write, countWords } from "./book/writer.js";
import { interleave } from "./book/bilingual.js";
import {
  formatGrammarFlagsForWriter,
  formatLookupsForWriter,
  readGrammarFlags,
  readLookups,
  recentGrammarFlags,
  recentLookups,
} from "./book/lookups.js";
import { buildEpub, tomoFilename } from "./book/epub.js";
import { sendToKindle } from "./book/send.js";
import { readMyths, findMyth, suggestMyths, type MythEntry } from "./book/myths.js";
import { config } from "../src/config.js";

const TOMOS_DIR = "books/tomos";
const BUILD_DIR = "books/build";
const PLAN_PATH = "books/next-plan.json";

interface SavedPlan {
  tomo_n: number;
  saved_at: string;
  plan: Plan;
}

async function loadSavedPlan(
  expectedTomoN: number,
  myths: MythEntry[]
): Promise<Plan | null> {
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
  if (saved.plan.format === "myth" && saved.plan.myth_name) {
    if (!findMyth(myths, saved.plan.myth_name)) {
      throw new Error(
        `Saved plan references myth "${saved.plan.myth_name}" no longer in corpus. ` +
          `Delete ${PLAN_PATH} (or run with --fresh-plan) and re-plan.`
      );
    }
  }
  return saved.plan;
}

async function saveNextPlan(tomoN: number, p: Plan): Promise<void> {
  const payload: SavedPlan = {
    tomo_n: tomoN,
    saved_at: new Date().toISOString(),
    plan: p,
  };
  await writeFile(PLAN_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

async function clearSavedPlan(): Promise<void> {
  if (existsSync(PLAN_PATH)) await unlink(PLAN_PATH).catch(() => {});
}

interface Args {
  planOnly: boolean;
  dry: boolean;
  send: boolean;
  steer?: string;
  bilingual?: boolean;
  forceFormat?: "essay" | "myth";
  forceMyth?: string;
  freshPlan: boolean;
}

function parseArgs(): Args {
  const argv = process.argv;
  const steerIdx = argv.indexOf("--steer");
  const steer = steerIdx >= 0 ? argv[steerIdx + 1] : process.env.STEER;

  let bilingual: boolean | undefined;
  if (argv.includes("--bilingual")) bilingual = true;
  else if (argv.includes("--no-bilingual")) bilingual = false;

  let forceFormat: "essay" | "myth" | undefined;
  for (const a of argv) {
    if (a.startsWith("--format=")) {
      const v = a.slice("--format=".length);
      if (v !== "essay" && v !== "myth") {
        throw new Error(`--format must be "essay" or "myth", got "${v}"`);
      }
      forceFormat = v;
    }
  }

  let forceMyth: string | undefined;
  for (const a of argv) {
    if (a.startsWith("--myth=")) {
      forceMyth = a.slice("--myth=".length);
    }
  }

  const noMyth = argv.includes("--no-myth");
  if (noMyth && (forceFormat === "myth" || forceMyth)) {
    throw new Error("--no-myth cannot be combined with --format=myth or --myth=<name>");
  }
  if (noMyth) forceFormat = "essay";

  if (forceMyth) {
    if (forceFormat && forceFormat !== "myth") {
      throw new Error(`--myth=${forceMyth} implies --format=myth, but --format=${forceFormat} was set`);
    }
    forceFormat = "myth";
  }

  return {
    planOnly: argv.includes("--plan-only"),
    dry: argv.includes("--dry"),
    send: !argv.includes("--no-send"),
    steer,
    bilingual,
    forceFormat,
    forceMyth,
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

function buildSteer(baseSteer: string | undefined, args: Args): string | undefined {
  const fragments: string[] = [];
  if (baseSteer) fragments.push(baseSteer);
  if (args.forceFormat === "myth" && !args.forceMyth) {
    fragments.push("HARD RULE: format=myth (myth-mode forced by user). Pick the strongest-scoring corpus myth.");
  }
  if (args.forceFormat === "essay") {
    fragments.push("HARD RULE: format=essay (no-myth — myth-mode is forbidden this run, regardless of corpus fit).");
  }
  if (args.forceMyth) {
    fragments.push(`HARD RULE: format=myth with myth_name="${args.forceMyth}" (specific myth forced by user). Generate bridge_thesis for THIS myth even if its corpus score is moderate.`);
  }
  return fragments.length > 0 ? fragments.join("\n\n") : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.freshPlan) {
    await clearSavedPlan();
    console.log("[fresh-plan] cleared books/next-plan.json");
  }

  console.log("[1/6] ensuring style guide is fresh");
  const style = await ensureStyle();

  console.log("[2/6] reading history + corpus");
  const history = await readHistory();
  const n = nextTomoNumber(history);
  const excluded = recentSourceUuids(history, 30, 15);
  const recent = recentTomoSummaries(history, 30);
  const recentMyths = recentMythNames(history, 8);
  const myths = await readMyths();
  console.log(
    `      tomo #${n}, ${history.length} prior, ${excluded.size} UUIDs excluded, ${myths.length} myths in corpus${recentMyths.size > 0 ? `, ${recentMyths.size} myth-names excluded` : ""}`
  );

  if (args.forceMyth) {
    const found = findMyth(myths, args.forceMyth);
    if (!found) {
      const suggestions = suggestMyths(myths, args.forceMyth, 3);
      console.error(`[error] --myth="${args.forceMyth}" not found in corpus.`);
      console.error(`        Did you mean: ${suggestions.join(", ")}?`);
      console.error(`        Or add this myth with: pnpm tsx scripts/book/add-myth.ts "${args.forceMyth}" --culture <culture>`);
      await pool.end();
      process.exit(2);
    }
    args.forceMyth = found.name;
  }

  if (args.forceFormat === "myth" && myths.length === 0) {
    console.error("[error] --format=myth requested but corpus is empty (books/myths.jsonl).");
    await pool.end();
    process.exit(2);
  }

  console.log("[3/6] gathering context (recent 14d + long-arc 365d)");
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

  console.log("[4/6] planning (Claude pass 1)");
  const saved = args.planOnly ? null : await loadSavedPlan(n, myths);
  if (saved) {
    if (args.forceFormat && saved.format !== args.forceFormat) {
      throw new Error(
        `Saved plan has format="${saved.format}" but you passed --format=${args.forceFormat} (or --no-myth/--myth=). ` +
          `Re-plan with --fresh-plan.`
      );
    }
    if (args.forceMyth && saved.myth_name?.toLowerCase() !== args.forceMyth.toLowerCase()) {
      throw new Error(
        `Saved plan has myth_name="${saved.myth_name}" but you passed --myth=${args.forceMyth}. ` +
          `Re-plan with --fresh-plan.`
      );
    }
  }
  const effectiveSteer = buildSteer(args.steer, args);
  if (effectiveSteer && !saved) {
    const preview = effectiveSteer.slice(0, 120);
    console.log(`      steering planner with: ${preview}${effectiveSteer.length > 120 ? "..." : ""}`);
  }
  const p = saved ?? (await plan(style, recent, longArc, context, myths, recentMyths, effectiveSteer));
  if (saved) {
    console.log(`      reusing saved plan from ${PLAN_PATH}`);
  }

  if (args.forceMyth && (!saved) && p.myth_name?.toLowerCase() !== args.forceMyth.toLowerCase()) {
    console.warn(
      `      WARN: --myth=${args.forceMyth} requested, but planner returned myth_name=${p.myth_name}. ` +
        "Override applied: rewriting plan.myth_name. Bridge thesis may need manual review."
    );
    p.myth_name = args.forceMyth;
  }

  const formatTag = p.format === "myth" ? `myth/${p.myth_name}` : `essay/${p.domain}`;
  console.log(`      ${formatTag} — "${p.title}"`);
  console.log(`      angle: ${p.angle}`);
  if (p.format === "myth" && p.bridge_thesis) {
    console.log(`      bridge_thesis: ${p.bridge_thesis}`);
  }
  console.log(`      sources: ${p.source_refs.length}`);
  if (p.myth_top3 && p.myth_top3.length > 0) {
    console.log(`      myth_top3:`);
    for (const s of p.myth_top3.slice(0, 3)) {
      console.log(`        - ${s.name} (${s.score.toFixed(1)}): ${s.reason}`);
    }
  }

  if (args.forceFormat === "myth" && p.format !== "myth") {
    const top = p.myth_top3?.[0];
    console.error(
      `[error] --format=myth was forced but planner judged no strong corpus fit (top: ${top?.name ?? "none"} @ ${top?.score?.toFixed(1) ?? "n/a"}).`
    );
    console.error("        Use --myth=<name> to force a specific myth, or rerun without --format=myth.");
    await pool.end();
    process.exit(3);
  }

  const allContext = [...longArc, ...context];
  if (saved) {
    const validUuids = new Set(allContext.map((c) => c.uuid));
    const missing = p.source_refs.filter((u) => !validUuids.has(u));
    if (missing.length > 0) {
      throw new Error(
        `Saved plan references ${missing.length} source UUIDs no longer in the context pool: ${missing.join(", ")}. Delete ${PLAN_PATH} and re-plan.`
      );
    }
  }

  if (args.planOnly) {
    await saveNextPlan(n, p);
    console.log(`      plan saved to ${PLAN_PATH} (will be reused by next normal run)`);
    console.log("\n--- plan-only ---");
    console.log(JSON.stringify(p, null, 2));
    await pool.end();
    return;
  }

  console.log("[5/6] writing (Claude pass 2)");
  const lookups = await readLookups();
  const lookupsBlock = formatLookupsForWriter(recentLookups(lookups, 30));
  if (lookups.length > 0) {
    console.log(
      `      injecting ${Math.min(lookups.length, 30)} recent lookups (${lookups.length} total)`
    );
  }
  const grammarFlags = await readGrammarFlags();
  const grammarBlock = formatGrammarFlagsForWriter(
    recentGrammarFlags(grammarFlags, 15)
  );
  if (grammarFlags.length > 0) {
    console.log(
      `      injecting ${Math.min(grammarFlags.length, 15)} grammar uncertainties (${grammarFlags.length} total)`
    );
  }
  const mythEntry = p.format === "myth" && p.myth_name ? findMyth(myths, p.myth_name) : null;
  if (p.format === "myth" && !mythEntry) {
    throw new Error(`format=myth but myth "${p.myth_name}" not in corpus`);
  }
  const markdown = await write(p, style, allContext, lookupsBlock, grammarBlock, mythEntry);
  const counts = countWords(markdown);
  if (p.format === "myth") {
    console.log(`      ${counts.total} words (myth: ${counts.myth ?? 0}, bridge: ${counts.bridge ?? 0})`);
    if (counts.myth === undefined || counts.bridge === undefined) {
      throw new Error('myth-format tomo missing "## El espejo" boundary — writer output malformed');
    }
    if (counts.myth < 1100 || counts.myth > 1500) {
      console.warn(`      WARN: myth section ${counts.myth} words outside 1100-1500 target`);
    }
    if (counts.bridge < 400 || counts.bridge > 600) {
      console.warn(`      WARN: bridge section ${counts.bridge} words outside 400-600 target`);
    }
  } else {
    console.log(`      ${counts.total} words`);
    if (counts.total < 1700 || counts.total > 2700) {
      console.warn(`      WARN: word count ${counts.total} is outside 1800-2400 target`);
    }
  }

  if (args.dry) {
    console.log("\n--- dry run (tomo not saved) ---\n");
    console.log(markdown);
    await pool.end();
    return;
  }

  const wantsBilingual =
    args.bilingual !== undefined ? args.bilingual : await askBilingual();

  console.log("[6/6] packaging epub + recording history");
  const padded = String(n).padStart(4, "0");
  const tomoPath = join(TOMOS_DIR, `${padded}.md`);
  await mkdir(TOMOS_DIR, { recursive: true });
  await mkdir(BUILD_DIR, { recursive: true });
  await writeFile(tomoPath, markdown, "utf-8");

  let epubMarkdown = markdown;
  let filename = tomoFilename(n, p.title);
  if (wantsBilingual) {
    console.log("[bilingual] interleaving ES + EN");
    epubMarkdown = await interleave(markdown);
    const biPath = join(TOMOS_DIR, `${padded}-bilingual.md`);
    await writeFile(biPath, epubMarkdown, "utf-8");
    filename = filename.replace(/\.epub$/, " (bilingual).epub");
  }
  const epubPath = join(BUILD_DIR, filename);

  await buildEpub({
    tomoNum: n,
    title: p.title,
    markdown: epubMarkdown,
    outPath: epubPath,
  });

  await appendHistory({
    n,
    title: p.title,
    format: p.format,
    domain: p.domain,
    topic: p.topic,
    source_uuids: p.source_refs,
    date: new Date().toISOString().slice(0, 10),
    word_count: counts.total,
    word_count_myth: counts.myth,
    word_count_bridge: counts.bridge,
    bilingual: wantsBilingual,
    myth_name: p.myth_name ?? undefined,
  });
  await clearSavedPlan();

  const subject = `Espejo — Tomo ${padded} — ${p.title}${wantsBilingual ? " (bilingual)" : ""}`;

  if (args.send) {
    console.log(`[send] emailing ${filename} to ${config.gmail.kindleEmail}`);
    await sendToKindle({ epubPath, filename, subject });
    console.log("[send] sent");
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
