import dotenv from "dotenv";

if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Keep raw text body if not JSON.
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function run(): Promise<void> {
  const baseUrlArg = process.argv[2] || process.env.APP_BASE_URL;
  if (!baseUrlArg) {
    console.error("Usage: pnpm deploy:smoke <base-url>");
    console.error("Example: pnpm deploy:smoke https://espejo.railway.app");
    process.exit(1);
  }

  const baseUrl = normalizeBaseUrl(baseUrlArg);

  console.log(`Checking health endpoint: ${baseUrl}/health`);
  const health = await fetchJson(`${baseUrl}/health`, 10_000);
  console.log("Health OK:", JSON.stringify(health));

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log("Skipping Telegram webhook check (TELEGRAM_BOT_TOKEN not set).");
    return;
  }

  console.log("Checking Telegram webhook info...");
  const webhookInfo = await fetchJson(
    `https://api.telegram.org/bot${botToken}/getWebhookInfo`,
    10_000
  );
  console.log("Webhook info:", JSON.stringify(webhookInfo));
}

run().catch((err) => {
  console.error("Deploy smoke test failed:", err);
  process.exit(1);
});
