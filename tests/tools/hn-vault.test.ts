import { describe, it, expect, vi, beforeEach } from "vitest";

const putObjectContent = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn().mockReturnValue({}));

vi.mock("../../src/storage/r2.js", () => ({
  putObjectContent,
  createClient,
}));

vi.mock("../../src/config.js", () => ({
  config: {
    r2: {
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucketName: "media",
      publicUrl: "https://media.example",
    },
  },
}));

import { writePendingReference, slugify } from "../../src/hn/vault.js";

beforeEach(() => {
  putObjectContent.mockReset().mockResolvedValue(undefined);
  createClient.mockClear();
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
    expect(slugify("a".repeat(120)).length).toBe(60);
  });
});

describe("writePendingReference", () => {
  it("uploads to the 'artifacts' bucket at Pending/Reference/HN-{date}-{slug}.md", async () => {
    const result = await writePendingReference({
      title: "Why Postgres Is Great",
      markdown: "## Headline facts\n\nIt is fast.\n",
      hnUrl: "https://news.ycombinator.com/item?id=42",
      articleUrl: "https://example.com/postgres",
      isoDate: "2026-04-26",
    });

    expect(result.filename).toBe("HN-2026-04-26-why-postgres-is-great.md");
    expect(result.key).toBe(
      "Pending/Reference/HN-2026-04-26-why-postgres-is-great.md"
    );

    expect(putObjectContent).toHaveBeenCalledTimes(1);
    const [, bucket, key, content] = putObjectContent.mock.calls[0];
    expect(bucket).toBe("artifacts");
    expect(key).toBe(result.key);

    const body = content as string;
    expect(body).toMatch(/^---\n/);
    expect(body).toMatch(/kind: reference/);
    expect(body).toMatch(/status: pending/);
    expect(body).toMatch(/- hn/);
    expect(body).toContain("# Why Postgres Is Great");
    expect(body).toContain("## Headline facts");
    expect(body).toContain("HN thread: https://news.ycombinator.com/item?id=42");
    expect(body).toContain("Original article: https://example.com/postgres");
  });

  it("includes extra tags alongside the default 'hn' tag", async () => {
    await writePendingReference({
      title: "X",
      markdown: "body",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      articleUrl: null,
      isoDate: "2026-04-26",
      extraTags: ["postgres", "databases"],
    });
    const body = putObjectContent.mock.calls[0][3] as string;
    expect(body).toMatch(/- hn/);
    expect(body).toMatch(/- postgres/);
    expect(body).toMatch(/- databases/);
  });

  it("omits 'Original article' when articleUrl is null", async () => {
    await writePendingReference({
      title: "Ask HN: anything",
      markdown: "body",
      hnUrl: "https://news.ycombinator.com/item?id=99",
      articleUrl: null,
      isoDate: "2026-04-26",
    });
    const body = putObjectContent.mock.calls[0][3] as string;
    expect(body).not.toContain("Original article");
    expect(body).toContain("HN thread:");
  });

  it("respects keyPrefix override and trims trailing slashes", async () => {
    const result = await writePendingReference({
      title: "X",
      markdown: "body",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      articleUrl: null,
      isoDate: "2026-04-26",
      keyPrefix: "custom/path/",
    });
    expect(result.key).toBe("custom/path/HN-2026-04-26-x.md");
  });
});

describe("writePendingReference without R2 credentials", () => {
  it("throws an actionable error when R2 is unconfigured", async () => {
    vi.resetModules();
    vi.doMock("../../src/storage/r2.js", () => ({
      putObjectContent: vi.fn(),
      createClient: vi.fn(),
    }));
    vi.doMock("../../src/config.js", () => ({
      config: {
        r2: {
          accountId: "",
          accessKeyId: "",
          secretAccessKey: "",
          bucketName: "media",
          publicUrl: "",
        },
      },
    }));
    const { writePendingReference: fresh } = await import(
      "../../src/hn/vault.js"
    );
    await expect(
      fresh({
        title: "X",
        markdown: "y",
        hnUrl: "https://news.ycombinator.com/item?id=1",
        articleUrl: null,
        isoDate: "2026-04-26",
      })
    ).rejects.toThrow(/R2 credentials are not configured/);
  });
});
