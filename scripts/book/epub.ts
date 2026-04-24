import { writeFile } from "fs/promises";
import { EPub } from "epub-gen-memory";
import { marked } from "marked";

export interface EpubOptions {
  tomoNum: number;
  title: string;
  markdown: string;
  outPath: string;
}

export async function buildEpub(opts: EpubOptions): Promise<void> {
  const { tomoNum, title, markdown, outPath } = opts;

  const body = markdown.replace(/^#\s+.+\n?/, "").trim();
  const html = await marked.parse(body);

  const padded = String(tomoNum).padStart(4, "0");
  const bookTitle = `Espejo — Tomo ${padded} — ${title}`;

  const epub = new EPub(
    {
      title: bookTitle,
      author: "Espejo",
      lang: "es",
      description: `Tomo ${tomoNum} — ${title}`,
      tocTitle: "Índice",
    },
    [
      {
        title,
        content: html,
      },
    ]
  );

  const buffer = await epub.genEpub();
  await writeFile(outPath, buffer);
}

export function tomoFilename(tomoNum: number, title: string): string {
  const padded = String(tomoNum).padStart(4, "0");
  const slug = slugify(title);
  return `Espejo Tomo ${padded} - ${slug}.epub`;
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
}
