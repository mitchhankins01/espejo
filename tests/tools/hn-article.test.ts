import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchArticleText,
  extractReadableContent,
} from "../../src/hn/article.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractReadableContent", () => {
  it("extracts the title and main text from a simple HTML page", () => {
    const html = `
      <html><head><title>My Page</title></head>
      <body>
        <header>nav stuff</header>
        <main><p>The main content goes here. ${"x ".repeat(120)}</p></main>
        <footer>copyright</footer>
      </body></html>`;
    const result = extractReadableContent(html);
    expect(result.title).toBe("My Page");
    expect(result.text).toContain("The main content goes here.");
    expect(result.text).not.toContain("nav stuff");
    expect(result.text).not.toContain("copyright");
  });

  it("strips script and style content", () => {
    const html = `
      <html><head><title>X</title></head>
      <body>
        <script>alert("xss")</script>
        <style>body{color:red}</style>
        <article><p>Real text. ${"y ".repeat(120)}</p></article>
      </body></html>`;
    const result = extractReadableContent(html);
    expect(result.text).toContain("Real text.");
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain("color:red");
  });

  it("falls back to body when article/main are absent or too short", () => {
    const html = `<html><head><title>Y</title></head><body><p>Body text fallback.</p></body></html>`;
    const result = extractReadableContent(html);
    expect(result.text).toBe("Body text fallback.");
  });

  it("returns null title when missing", () => {
    expect(extractReadableContent("<html><body><p>x</p></body></html>").title).toBeNull();
  });
});

describe("fetchArticleText", () => {
  it("returns extracted content for a 200 HTML response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () =>
        "<html><head><title>T</title></head><body><article>Hello world</article></body></html>",
    });
    const result = await fetchArticleText("https://example.com/x");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/x");
    expect(result!.title).toBe("T");
    expect(result!.text).toContain("Hello world");
  });

  it("returns null for a non-HTML content type", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => "application/pdf" },
      text: async () => "%PDF-1.4 binary",
    });
    expect(await fetchArticleText("https://example.com/x.pdf")).toBeNull();
  });

  it("retries on 503 then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => "text/html" },
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        text: async () =>
          "<html><head><title>T</title></head><body><p>retry success</p></body></html>",
      });
    const result = await fetchArticleText("https://example.com/x");
    expect(result?.text).toContain("retry success");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-retryable HTTP error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: () => "text/html" },
      text: async () => "",
    });
    await expect(fetchArticleText("https://example.com/x")).rejects.toThrow(
      /HTTP 404/
    );
  });

  it("throws when fetch itself rejects (after retries)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(fetchArticleText("https://example.com/x")).rejects.toThrow(
      /network down/
    );
  });
});
