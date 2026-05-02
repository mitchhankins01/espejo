import { existsSync } from "fs";
import { mkdir, readFile } from "fs/promises";
import { join } from "path";
import { config } from "../../src/config.js";
import { sendEmail } from "../../src/email/send.js";
import { buildEpub, tomoFilename } from "./epub.js";
import { checkJuliaSensitivity } from "./sensitivity.js";
import { readHistory, updateHistory, type TomoRecord } from "./state.js";

const TOMOS_DIR = "books/tomos";
const BUILD_DIR = "books/build";

export type ShareJuliaMode = "prompt" | "yes" | "skip";

interface ShareOpts {
  mode: ShareJuliaMode;
}

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = await import("readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

async function buildAndSendToJulia(tomo: TomoRecord): Promise<void> {
  const padded = String(tomo.n).padStart(4, "0");
  const mdPath = join(TOMOS_DIR, `${padded}.md`);
  if (!existsSync(mdPath)) {
    throw new Error(`tomo ${tomo.n} markdown missing at ${mdPath}`);
  }
  const markdown = await readFile(mdPath, "utf-8");
  const filename = tomoFilename(tomo.n, tomo.title);
  await mkdir(BUILD_DIR, { recursive: true });
  const epubPath = join(BUILD_DIR, filename);

  await buildEpub({
    tomoNum: tomo.n,
    title: tomo.title,
    markdown,
    outPath: epubPath,
  });

  const subject = `Espejo — Tomo ${padded} — ${tomo.title}`;
  await sendEmail({
    to: config.gmail.juliaKindleEmail,
    subject,
    text: subject,
    attachments: [
      {
        filename,
        path: epubPath,
        contentType: "application/epub+zip",
      },
    ],
  });
}

export async function offerJuliaShare(opts: ShareOpts): Promise<void> {
  const history = await readHistory();
  const unshared = history.filter((r) => !r.shared_with_julia);

  if (unshared.length === 0) {
    if (opts.mode !== "skip") {
      console.log("[julia] no unshared tomos");
    }
    return;
  }

  if (opts.mode === "skip") return;

  const summary = unshared.map((r) => `${r.n}`).join(", ");
  console.log(
    `[julia] ${unshared.length} unshared tomo(s): ${summary} (target: ${config.gmail.juliaKindleEmail})`
  );

  let proceed: boolean;
  if (opts.mode === "yes") {
    proceed = true;
  } else {
    proceed = await ask(`[julia] Run sensitivity check + share? [y/N] `);
  }
  if (!proceed) {
    console.log("[julia] skipped");
    return;
  }

  for (const tomo of unshared) {
    const padded = String(tomo.n).padStart(4, "0");
    const mdPath = join(TOMOS_DIR, `${padded}.md`);
    if (!existsSync(mdPath)) {
      console.warn(`[julia] tomo ${tomo.n} markdown missing — skipping`);
      continue;
    }
    const markdown = await readFile(mdPath, "utf-8");

    console.log(`[julia] tomo ${tomo.n} — checking sensitivity…`);
    const check = await checkJuliaSensitivity(markdown);

    let shareThis: boolean;
    if (check.flagged) {
      console.log(`[julia] tomo ${tomo.n} FLAGGED: ${check.reason}`);
      if (check.snippet) console.log(`         snippet: "${check.snippet}"`);
      if (opts.mode === "yes" && !process.stdin.isTTY) {
        console.log(`[julia] tomo ${tomo.n} skipped (non-TTY + flagged)`);
        shareThis = false;
      } else {
        shareThis = await ask(`[julia] Share tomo ${tomo.n} anyway? [y/N] `);
      }
    } else {
      console.log(`[julia] tomo ${tomo.n} clean`);
      shareThis = true;
    }

    if (!shareThis) {
      console.log(`[julia] tomo ${tomo.n} not shared`);
      continue;
    }

    console.log(`[julia] tomo ${tomo.n} — building + sending`);
    await buildAndSendToJulia(tomo);
    await updateHistory(tomo.n, { shared_with_julia: new Date().toISOString() });
    console.log(`[julia] tomo ${tomo.n} sent + recorded`);
  }
}
