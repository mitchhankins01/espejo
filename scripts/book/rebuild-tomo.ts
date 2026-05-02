import { buildEpub, tomoFilename } from "./epub.ts";
import { sendToKindle } from "./send.ts";
import { interleave } from "./bilingual.ts";
import { offerJuliaShare, type ShareJuliaMode } from "./share.ts";
import { readFile, writeFile } from "fs/promises";

async function main() {
  const args = process.argv.slice(2);
  const bilingual = args.includes("--bilingual");
  let shareJulia: ShareJuliaMode;
  if (args.includes("--share-julia")) shareJulia = "yes";
  else if (args.includes("--no-share-julia")) shareJulia = "skip";
  else shareJulia = process.stdin.isTTY ? "prompt" : "skip";

  const n = Number(args.find((a) => !a.startsWith("--")));
  if (!Number.isFinite(n))
    throw new Error(
      "usage: rebuild-tomo.ts <tomo_number> [--bilingual] [--share-julia|--no-share-julia]"
    );
  const padded = String(n).padStart(4, "0");
  const md = await readFile(`books/tomos/${padded}.md`, "utf-8");
  const title = md.match(/^#\s+(.+)/)![1];

  let epubMarkdown = md;
  let filename = tomoFilename(n, title);
  let subject = `Espejo — Tomo ${padded} — ${title}`;
  if (bilingual) {
    console.log("[bilingual] interleaving ES + EN");
    epubMarkdown = await interleave(md);
    await writeFile(`books/tomos/${padded}-bilingual.md`, epubMarkdown, "utf-8");
    filename = filename.replace(/\.epub$/, " (bilingual).epub");
    subject = `${subject} (bilingual)`;
  }
  const epubPath = `books/build/${filename}`;
  await buildEpub({ tomoNum: n, title, markdown: epubMarkdown, outPath: epubPath });
  await sendToKindle({ epubPath, filename, subject });
  console.log("rebuilt + sent");
  await offerJuliaShare({ mode: shareJulia });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
