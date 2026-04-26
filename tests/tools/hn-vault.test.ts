import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writePendingReference, slugify } from "../../src/hn/vault.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "espejo-hn-vault-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Why Postgres Is Great")).toBe("why-postgres-is-great");
  });

  it("strips diacritics", () => {
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });

  it("collapses non-alphanumeric runs and trims edges", () => {
    expect(slugify("--Hello, World!  ")).toBe("hello-world");
  });

  it("returns 'untitled' for fully non-alphanumeric input", () => {
    expect(slugify("!!!")).toBe("untitled");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(120);
    expect(slugify(long).length).toBe(60);
  });
});

describe("writePendingReference", () => {
  it("creates Pending/Reference and writes a file with proper frontmatter and body", async () => {
    const result = await writePendingReference({
      title: "Why Postgres Is Great",
      markdown: "## Headline facts\n\nIt is fast.\n",
      hnUrl: "https://news.ycombinator.com/item?id=42",
      articleUrl: "https://example.com/postgres",
      isoDate: "2026-04-26",
      vaultRoot: tmpRoot,
    });

    expect(result.filename).toBe("HN-2026-04-26-why-postgres-is-great.md");
    expect(result.filePath).toBe(
      path.join(tmpRoot, "Pending", "Reference", result.filename)
    );

    const written = await readFile(result.filePath, "utf8");
    expect(written).toMatch(/^---\n/);
    expect(written).toMatch(/kind: reference/);
    expect(written).toMatch(/status: pending/);
    expect(written).toMatch(/- hn/);
    expect(written).toContain("# Why Postgres Is Great");
    expect(written).toContain("## Headline facts");
    expect(written).toContain("HN thread: https://news.ycombinator.com/item?id=42");
    expect(written).toContain("Original article: https://example.com/postgres");
  });

  it("includes extra tags alongside the default 'hn' tag", async () => {
    const result = await writePendingReference({
      title: "X",
      markdown: "body",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      articleUrl: null,
      isoDate: "2026-04-26",
      extraTags: ["postgres", "databases"],
      vaultRoot: tmpRoot,
    });
    const written = await readFile(result.filePath, "utf8");
    expect(written).toMatch(/- hn/);
    expect(written).toMatch(/- postgres/);
    expect(written).toMatch(/- databases/);
  });

  it("omits 'Original article' line when articleUrl is null", async () => {
    const result = await writePendingReference({
      title: "Ask HN: anything",
      markdown: "body",
      hnUrl: "https://news.ycombinator.com/item?id=99",
      articleUrl: null,
      isoDate: "2026-04-26",
      vaultRoot: tmpRoot,
    });
    const written = await readFile(result.filePath, "utf8");
    expect(written).not.toContain("Original article");
    expect(written).toContain("HN thread:");
  });
});
