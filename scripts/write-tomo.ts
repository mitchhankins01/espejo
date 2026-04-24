/**
 * Write the next tomo of the Espejo series.
 *
 * Usage:
 *   pnpm tsx scripts/write-tomo.ts             # normal: plan + write + epub + email
 *   pnpm tsx scripts/write-tomo.ts --plan-only # stop after planner, print plan
 *   pnpm tsx scripts/write-tomo.ts --dry       # plan + write, print to stdout, no files, no email
 *   pnpm tsx scripts/write-tomo.ts --no-send   # everything except the email
 */

import { writeFile, mkdir } from "fs/promises";
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
import { gatherContext } from "./book/context.js";
import { plan } from "./book/planner.js";
import { write, countWords } from "./book/writer.js";
import {
  formatLookupsForWriter,
  readLookups,
  recentLookups,
} from "./book/lookups.js";
import { buildEpub, tomoFilename } from "./book/epub.js";
import { sendToKindle } from "./book/send.js";
import { config } from "../src/config.js";

const TOMOS_DIR = "books/tomos";
const BUILD_DIR = "books/build";

interface Args {
  planOnly: boolean;
  dry: boolean;
  send: boolean;
}

function parseArgs(): Args {
  return {
    planOnly: process.argv.includes("--plan-only"),
    dry: process.argv.includes("--dry"),
    send: !process.argv.includes("--no-send"),
  };
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

  console.log("[3/6] gathering context (last 14 days)");
  const context = await gatherContext(excluded, 14);
  console.log(
    `      ${context.length} items (${context.filter((c) => c.kind === "entry").length} entries, ${context.filter((c) => c.kind === "insight").length} insights)`
  );
  if (context.length < 3) {
    throw new Error(
      `Only ${context.length} usable context items in the last 14 days. ` +
        `Either journal more, widen the window, or reduce excluded UUIDs.`
    );
  }

  console.log("[4/6] planning (Claude pass 1)");
  const p = await plan(style, recent, context);
  console.log(`      ${p.format}/${p.domain} — "${p.title}"`);
  console.log(`      angle: ${p.angle}`);
  console.log(`      sources: ${p.source_refs.length}`);

  if (args.planOnly) {
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
  const markdown = await write(p, style, context, lookupsBlock);
  const words = countWords(markdown);
  console.log(`      ${words} words`);
  if (words < 1100 || words > 1800) {
    console.warn(`      WARN: word count ${words} is outside 1300-1600 target`);
  }

  if (args.dry) {
    console.log("\n--- dry run (tomo not saved) ---\n");
    console.log(markdown);
    await pool.end();
    return;
  }

  console.log("[6/6] packaging epub + recording history");
  const padded = String(n).padStart(4, "0");
  const tomoPath = join(TOMOS_DIR, `${padded}.md`);
  const filename = tomoFilename(n, p.title);
  const epubPath = join(BUILD_DIR, filename);

  await mkdir(TOMOS_DIR, { recursive: true });
  await mkdir(BUILD_DIR, { recursive: true });
  await writeFile(tomoPath, markdown, "utf-8");
  await buildEpub({
    tomoNum: n,
    title: p.title,
    markdown,
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
    word_count: words,
  });

  const subject = `Espejo — Tomo ${padded} — ${p.title}`;

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
