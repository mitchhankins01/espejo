import * as cheerio from "cheerio";

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 700;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; espejo-hn-distill/1.0; +https://github.com/mitchhankins)";

export interface FetchedArticle {
  url: string;
  title: string | null;
  text: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch an article URL and return cleaned readable text + the page title.
 *
 * Strategy: strip noisy elements (script/style/nav/header/footer/aside), then
 * pull text from the most-likely main content container (article, main, or
 * the body). Returns null if the response isn't HTML — Claude can't reason
 * over PDF/image bytes here so we let the caller fall back to thread-only.
 */
export async function fetchArticleText(url: string): Promise<FetchedArticle | null> {
  let response: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetchWithTimeout(url);
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `Failed to fetch article ${url}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await sleep(BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    if (
      response.ok ||
      !RETRYABLE_STATUSES.has(response.status) ||
      attempt >= MAX_RETRIES
    ) {
      break;
    }
    await sleep(BASE_DELAY_MS * 2 ** attempt);
  }

  if (!response!.ok) {
    throw new Error(
      `Article fetch returned HTTP ${response!.status} for ${url}.`
    );
  }

  const contentType = response!.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    return null;
  }

  const html = await response!.text();
  return { url, ...extractReadableContent(html) };
}

interface Extracted {
  title: string | null;
  text: string;
}

export function extractReadableContent(html: string): Extracted {
  const $ = cheerio.load(html);
  const title = ($("title").first().text() || "").trim() || null;

  // Strip noise.
  $(
    "script, style, noscript, nav, header, footer, aside, form, iframe, svg, button"
  ).remove();

  // Prefer the most semantically meaningful container.
  const candidates = ["article", "main", "[role='main']", "body"];
  let body = "";
  for (const selector of candidates) {
    const node = $(selector).first();
    if (node.length) {
      body = node.text();
      if (body.trim().length > 200) break;
    }
  }

  const text = body
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text };
}
