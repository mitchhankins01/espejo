import { readFile } from "fs/promises";
import { join } from "path";
import { checkJuliaSensitivity } from "./book/sensitivity.js";
import { readHistory } from "./book/state.js";

const TOMOS_DIR = "books/tomos";

async function main() {
  const history = await readHistory();
  for (const tomo of history) {
    const padded = String(tomo.n).padStart(4, "0");
    const mdPath = join(TOMOS_DIR, `${padded}.md`);
    const markdown = await readFile(mdPath, "utf-8");
    const check = await checkJuliaSensitivity(markdown);
    const status = check.flagged ? "FLAGGED" : "clean";
    const shared = tomo.shared_with_julia ? ` shared:${tomo.shared_with_julia.slice(0, 10)}` : "";
    console.log(`[${padded}] ${status} — ${tomo.title}${shared}`);
    if (check.flagged) {
      console.log(`         reason: ${check.reason}`);
      if (check.snippet) console.log(`         snippet: "${check.snippet}"`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
