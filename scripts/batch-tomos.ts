/**
 * One-off batch writer: take all 6 candidates from books/next-plan.json
 * and ship them as tomos #N..N+5, each bilingual + sent to Kindle.
 *
 * Context (style, history snapshot, recent/long-arc, lookups, grammar, highlights)
 * is frozen at script start so candidate source UUIDs stay valid across all 6
 * iterations — appendHistory grows after each write but does NOT re-filter context.
 *
 * Run: pnpm tsx scripts/batch-tomos.ts
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
} from "./book/state.js";
import { gatherContext, gatherLongArcContext } from "./book/context.js";
import type { Candidate } from "./book/planner.js";
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
import {
  formatHighlightsForWriter,
  readHighlights,
  recentHighlights,
} from "./book/highlights.js";
import { buildEpub, tomoFilename } from "./book/epub.js";
import { sendToKindle } from "./book/send.js";
import { config } from "../src/config.js";

const TOMOS_DIR = "books/tomos";
const BUILD_DIR = "books/build";
const PLAN_PATH = "books/next-plan.json";

interface SavedPlan {
  tomo_n: number;
  saved_at: string;
  candidates: Candidate[];
}

async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 30000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.warn(`  [retry] attempt ${i + 1}/${attempts} failed: ${(err as Error).message ?? err}; retrying in ${delayMs / 1000}s`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  if (!existsSync(PLAN_PATH)) {
    throw new Error(`${PLAN_PATH} missing — run write-tomo --plan-only first.`);
  }
  const saved = JSON.parse(await readFile(PLAN_PATH, "utf-8")) as SavedPlan;
  if (!Array.isArray(saved.candidates) || saved.candidates.length !== 6) {
    throw new Error(`${PLAN_PATH} must contain 6 candidates`);
  }
  const candidates = [...saved.candidates].sort((a, b) => a.id - b.id);

  console.log("[batch] freezing context for all 6 candidates");
  const style = await ensureStyle();
  const history = await readHistory();
  const startN = nextTomoNumber(history);
  if (saved.tomo_n > startN) {
    throw new Error(
      `Saved plan was for tomo #${saved.tomo_n} but next number is #${startN}. Re-plan.`
    );
  }
  const writtenTitles = new Set(history.map((h) => h.title));
  const remaining = candidates.filter((c) => !writtenTitles.has(c.title));
  if (remaining.length === 0) {
    console.log("[batch] all 6 candidates already in history — nothing to do");
    if (existsSync(PLAN_PATH)) await unlink(PLAN_PATH).catch(() => {});
    await pool.end();
    return;
  }
  if (remaining.length < candidates.length) {
    console.log(
      `[batch] resuming — ${candidates.length - remaining.length} already in history, ${remaining.length} remaining`
    );
  }
  const excluded = recentSourceUuids(history, 30);
  const context = await gatherContext(excluded, 14);
  const recentUuids = new Set(context.map((c) => c.uuid));
  const longArc = await gatherLongArcContext(excluded, recentUuids, 365);
  const allContext = [...longArc, ...context];
  const validUuids = new Set(allContext.map((c) => c.uuid));

  for (const c of remaining) {
    const missing = c.source_refs.filter((u) => !validUuids.has(u));
    if (missing.length > 0) {
      throw new Error(
        `Candidate #${c.id} references UUIDs no longer in pool: ${missing.join(", ")}`
      );
    }
  }
  console.log(
    `      ${allContext.length} context items locked, ${remaining.length} candidate(s) validate`
  );

  const lookups = await readLookups();
  const lookupsBlock = formatLookupsForWriter(recentLookups(lookups, 30));
  const grammarFlags = await readGrammarFlags();
  const grammarBlock = formatGrammarFlagsForWriter(
    recentGrammarFlags(grammarFlags, 15)
  );
  const highlights = await readHighlights();
  const highlightsBlock = formatHighlightsForWriter(
    recentHighlights(highlights, 12)
  );

  await mkdir(TOMOS_DIR, { recursive: true });
  await mkdir(BUILD_DIR, { recursive: true });

  for (let i = 0; i < remaining.length; i++) {
    const c = remaining[i];
    const n = startN + i;
    const padded = String(n).padStart(4, "0");
    console.log(
      `\n[batch ${i + 1}/${remaining.length}] tomo #${n} — ${c.format}/${c.domain} — "${c.title}"`
    );

    const tomoPath = join(TOMOS_DIR, `${padded}.md`);
    let markdown: string;
    if (existsSync(tomoPath)) {
      markdown = await readFile(tomoPath, "utf-8");
      console.log(`  [write] reusing existing ${tomoPath} (${countWords(markdown).total} words)`);
    } else {
      console.log("  [write] generating Spanish markdown");
      markdown = await retry(() =>
        write(c, style, allContext, lookupsBlock, grammarBlock, highlightsBlock)
      );
      const counts = countWords(markdown);
      console.log(`  [write] ${counts.total} words`);
      if (counts.total < 1700 || counts.total > 2700) {
        console.warn(
          `  [warn] word count ${counts.total} outside 1800-2400 target`
        );
      }
      await writeFile(tomoPath, markdown, "utf-8");
    }
    const counts = countWords(markdown);

    console.log("  [bilingual] interleaving ES + EN");
    const bilingualMarkdown = await retry(() => interleave(markdown));
    const biPath = join(TOMOS_DIR, `${padded}-bilingual.md`);
    await writeFile(biPath, bilingualMarkdown, "utf-8");

    const baseFilename = tomoFilename(n, c.title);
    const filename = baseFilename.replace(/\.epub$/, " (bilingual).epub");
    const epubPath = join(BUILD_DIR, filename);
    await buildEpub({
      tomoNum: n,
      title: c.title,
      markdown: bilingualMarkdown,
      outPath: epubPath,
    });

    await appendHistory({
      n,
      title: c.title,
      format: c.format,
      domain: c.domain,
      topic: c.topic,
      source_uuids: c.source_refs,
      date: new Date().toISOString().slice(0, 10),
      word_count: counts.total,
      bilingual: true,
    });

    const subject = `Espejo — Tomo ${padded} — ${c.title} (bilingual)`;
    console.log(`  [send] emailing to ${config.gmail.kindleEmail}`);
    await retry(() => sendToKindle({ epubPath, filename, subject }));
    console.log(`  [send] sent`);
  }

  if (existsSync(PLAN_PATH)) await unlink(PLAN_PATH).catch(() => {});
  console.log(
    `\n[batch] done — wrote tomos #${startN}-${startN + remaining.length - 1}, sent ${remaining.length} emails`
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
