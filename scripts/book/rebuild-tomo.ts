/**
 * Phase 4 — build the bilingual EPUB from the reviewed Spanish markdown and
 * deliver it to the Kindle.
 *
 * Every tomo is now bilingual (faithful, readable ES↔EN). The flow:
 *   pnpm tsx scripts/book/rebuild-tomo.ts NNNN --no-send   # build + write NNNN-bilingual.md for review
 *   pnpm tsx scripts/book/rebuild-tomo.ts NNNN             # reuse the reviewed bilingual md, build EPUB, send
 *
 * The bilingual interleave is generated once and cached at books/tomos/NNNN-bilingual.md.
 * A second run reuses it (so any hand-edits to the bilingual md survive); pass
 * --force-bilingual to regenerate it from the Spanish source.
 */

import { buildEpub, tomoFilename } from "./epub.js";
import { sendToKindle } from "./send.js";
import { interleave } from "./bilingual.js";
import { offerJuliaShare, type ShareJuliaMode } from "./share.js";
import { splitTomo } from "./writer.js";
import { readHistory } from "./state.js";
import { legByline } from "./models.js";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const send = !args.includes("--no-send");
  const forceBilingual = args.includes("--force-bilingual");
  let shareJulia: ShareJuliaMode;
  if (args.includes("--share-julia")) shareJulia = "yes";
  else if (args.includes("--no-share-julia")) shareJulia = "skip";
  else shareJulia = process.stdin.isTTY ? "prompt" : "skip";

  const n = Number(args.find((a) => !a.startsWith("--")));
  if (!Number.isFinite(n))
    throw new Error(
      "usage: rebuild-tomo.ts <tomo_number> [--no-send] [--force-bilingual] [--share-julia|--no-share-julia]"
    );
  const padded = String(n).padStart(4, "0");
  const rawMd = await readFile(`books/tomos/${padded}.md`, "utf-8");
  // Strip the legacy Reader notes section (feature removed; still on disk in old tomos).
  const { nota } = splitTomo(rawMd);
  const md = nota ? rawMd.slice(0, rawMd.indexOf(nota)).trimEnd() + "\n" : rawMd;
  const title = md.match(/^#\s+(.+)/)![1];

  const biPath = `books/tomos/${padded}-bilingual.md`;
  let bilingualMd: string;
  if (existsSync(biPath) && !forceBilingual) {
    bilingualMd = await readFile(biPath, "utf-8");
    console.log(`[bilingual] reusing reviewed ${biPath}`);
  } else {
    console.log("[bilingual] interleaving ES + faithful EN");
    bilingualMd = await interleave(md);
    await writeFile(biPath, bilingualMd, "utf-8");
    console.log(`[bilingual] wrote ${biPath}`);
  }

  // First-page author stamp (model-comparison flow). Read from history; absent
  // for tomos written before model tagging, in which case no byline is shown.
  const record = (await readHistory()).find((r) => r.n === n);
  const modelByline =
    record?.leg && record?.model
      ? legByline({ label: record.leg, model: record.model })
      : undefined;

  const filename = tomoFilename(n, title).replace(/\.epub$/, " (bilingual).epub");
  const epubPath = `books/build/${filename}`;
  await buildEpub({
    tomoNum: n,
    title,
    markdown: bilingualMd,
    outPath: epubPath,
    model: modelByline,
  });
  console.log(
    `[epub] built ${epubPath}${modelByline ? ` (✍ ${modelByline})` : ""}`
  );

  if (!send) {
    console.log(
      `\n=== SEND SKIPPED (--no-send) ===\nReview ${biPath} and ${epubPath}, then run without --no-send to deliver.\n`
    );
    return;
  }

  const subject = `Espejo — Tomo ${padded} — ${title} (bilingual)`;
  await sendToKindle({ epubPath, filename, subject });
  console.log("[send] sent");
  await offerJuliaShare({ mode: shareJulia });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
