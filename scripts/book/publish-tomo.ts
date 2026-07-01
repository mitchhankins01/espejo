/**
 * Phase 3 — deliver reviewed tomo(s) to the Kindle.
 *
 *   pnpm publish-tomo 91                 # send tomo 91
 *   pnpm publish-tomo 91,92              # send several
 *   pnpm publish-tomo 91 --no-send       # rebuild only (review the EPUB first)
 *   pnpm publish-tomo 91 --force         # regenerate the bilingual even if fresh
 *
 * `pnpm write-tomo` already produced the bilingual + EPUB. This script's job is
 * the send — plus a staleness check: if books/tomos/NNNN.md was edited after
 * the bilingual was built (the review gate exists precisely so you fix drafts),
 * the bilingual + EPUB are rebuilt automatically before sending. Hand-edits to
 * the bilingual .md itself are preserved unless the Spanish source is newer or
 * --force is passed.
 */
import { existsSync } from "fs";
import { readFile, stat, writeFile } from "fs/promises";
import {
  interleave,
  buildEpub,
  tomoFilename,
  sendToKindle,
  legByline,
  splitTomo,
  readHistory,
  paddedTomo,
  tomoMdPath,
  tomoBilingualPath,
  errorMessage,
  BUILD_DIR,
} from "./lib.js";

interface Args {
  tomos: number[];
  send: boolean;
  force: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const positional = argv.find((a) => !a.startsWith("--"));
  if (!positional) {
    throw new Error("usage: pnpm publish-tomo <n[,n,...]> [--no-send] [--force]");
  }
  const tomos = positional.split(",").map((tok) => {
    const v = Number(tok.trim());
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`tomo numbers must be positive integers, got "${tok}"`);
    }
    return v;
  });
  return {
    tomos: [...new Set(tomos)].sort((a, b) => a - b),
    send: !argv.includes("--no-send"),
    force: argv.includes("--force"),
  };
}

async function mtime(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}

async function publishOne(n: number, args: Args): Promise<void> {
  const padded = paddedTomo(n);
  const mdPath = tomoMdPath(n);
  const biPath = tomoBilingualPath(n);
  if (!existsSync(mdPath)) {
    throw new Error(`${mdPath} not found — write it first (pnpm write-tomo --pick=...)`);
  }

  const rawMd = await readFile(mdPath, "utf-8");
  // Strip the legacy Reader notes section (feature removed; still on disk in old tomos).
  const { nota } = splitTomo(rawMd);
  const md = nota ? rawMd.slice(0, rawMd.indexOf(nota)).trimEnd() + "\n" : rawMd;
  const titleMatch = md.match(/^#\s+(.+)/);
  if (!titleMatch) throw new Error(`${mdPath} has no "# <title>" heading`);
  const title = titleMatch[1];

  // Rebuild the bilingual when the Spanish source is newer than the existing
  // interleave (post-review edits) — otherwise reuse it so hand-edits to the
  // bilingual .md survive.
  let rebuild = args.force;
  if (!rebuild && existsSync(biPath)) {
    rebuild = (await mtime(mdPath)) > (await mtime(biPath));
    if (rebuild) console.log(`[${padded}] ${mdPath} edited after bilingual build — rebuilding`);
  } else if (!existsSync(biPath)) {
    rebuild = true;
  }

  let bilingualMd: string;
  if (rebuild) {
    console.log(`[${padded}] interleaving ES + faithful EN`);
    bilingualMd = await interleave(md);
    await writeFile(biPath, bilingualMd, "utf-8");
    console.log(`[${padded}] wrote ${biPath}`);
  } else {
    bilingualMd = await readFile(biPath, "utf-8");
    console.log(`[${padded}] reusing reviewed ${biPath}`);
  }

  // First-page author stamp (model-comparison flow). Read from history; absent
  // for tomos written before model tagging, in which case no byline is shown.
  const record = (await readHistory()).find((r) => r.n === n);
  const byline =
    record?.leg && record?.model
      ? legByline({ label: record.leg, model: record.model })
      : undefined;

  const filename = tomoFilename(n, title).replace(/\.epub$/, " (bilingual).epub");
  const epubPath = `${BUILD_DIR}/${filename}`;
  await buildEpub({ tomoNum: n, title, markdown: bilingualMd, outPath: epubPath, model: byline });
  console.log(`[${padded}] built ${epubPath}${byline ? ` (✍ ${byline})` : ""}`);

  if (!args.send) {
    console.log(`[${padded}] SEND SKIPPED (--no-send) — review ${biPath} and the EPUB, then re-run without --no-send.`);
    return;
  }

  await sendToKindle({
    epubPath,
    filename,
    subject: `Espejo — Tomo ${padded} — ${title} (bilingual)`,
  });
  console.log(`[${padded}] sent to Kindle`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const failed: number[] = [];
  for (const n of args.tomos) {
    try {
      await publishOne(n, args);
    } catch (err) {
      failed.push(n);
      console.error(`[${paddedTomo(n)}] failed: ${errorMessage(err)}`);
    }
  }
  if (failed.length > 0) {
    throw new Error(`failed tomo(s): ${failed.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
