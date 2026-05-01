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
import { config } from "../src/config.js";

const TOMOS_DIR = "books/tomos";
const BUILD_DIR = "books/build";
const PLAN_PATH = "books/next-plan.json";

interface SavedPlan {
  tomo_n: number;
  saved_at: string;
  plan: Plan;
}

async function loadSavedPlan(expectedTomoN: number): Promise<Plan | null> {
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
}

function parseArgs(): Args {
  const argv = process.argv;
  const steerIdx = argv.indexOf("--steer");
  const steer = steerIdx >= 0 ? argv[steerIdx + 1] : process.env.STEER;
  let bilingual: boolean | undefined;
  if (argv.includes("--bilingual")) bilingual = true;
  else if (argv.includes("--no-bilingual")) bilingual = false;
  return {
    planOnly: argv.includes("--plan-only"),
    dry: argv.includes("--dry"),
    send: !argv.includes("--no-send"),
    steer,
    bilingual,
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

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("[1/6] ensuring style guide is fresh");
  const style = await ensureStyle();

  console.log("[2/6] reading history");
  const history = await readHistory();
  const n = nextTomoNumber(history);
  const excluded = recentSourceUuids(history, 30);
  const recent = recentTomoSummaries(history, 30);
  console.log(
    `      tomo #${n}, ${history.length} prior, ${excluded.size} UUIDs excluded`
  );

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
  const saved = args.planOnly ? null : await loadSavedPlan(n);
  if (args.steer && !saved) {
    console.log(`      steering planner with: ${args.steer.slice(0, 80)}${args.steer.length > 80 ? "..." : ""}`);
  }
  const p = saved ?? (await plan(style, recent, longArc, context, args.steer));
  if (saved) {
    console.log(`      reusing saved plan from ${PLAN_PATH}`);
  }
  console.log(`      essay/${p.domain} — "${p.title}"`);
  console.log(`      angle: ${p.angle}`);
  console.log(`      sources: ${p.source_refs.length}`);

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
  const markdown = await write(p, style, allContext, lookupsBlock, grammarBlock);
  const words = countWords(markdown);
  console.log(`      ${words} words`);
  if (words < 1700 || words > 2700) {
    console.warn(`      WARN: word count ${words} is outside 1800-2400 target`);
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
    domain: p.domain,
    topic: p.topic,
    source_uuids: p.source_refs,
    date: new Date().toISOString().slice(0, 10),
    word_count: words,
    bilingual: wantsBilingual,
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
