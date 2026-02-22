import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN;

if (!BOT_TOKEN) {
  console.error(
    "TELEGRAM_BOT_TOKEN is required. Set it in .env or as an environment variable."
  );
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isDelete = args.includes("--delete");
const isInfo = args.includes("--info");
const webhookUrl = args.find((a) => !a.startsWith("--"));

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

interface TelegramResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  description?: string;
}

async function telegramPost(
  method: string,
  body?: Record<string, unknown>
): Promise<TelegramResponse> {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<TelegramResponse>;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function setWebhook(url: string): Promise<void> {
  console.log(`Setting webhook to: ${url}`);

  const body: Record<string, unknown> = {
    url,
    allowed_updates: ["message", "callback_query"],
  };

  if (SECRET_TOKEN) {
    body.secret_token = SECRET_TOKEN;
    console.log("Including secret_token for webhook verification.");
  } else {
    console.warn(
      "Warning: TELEGRAM_SECRET_TOKEN is not set. Webhook will not be verified."
    );
  }

  const result = await telegramPost("setWebhook", body);

  if (result.ok) {
    console.log("Webhook set successfully.");
    await showWebhookInfo();
  } else {
    console.error(`Failed to set webhook: ${result.description}`);
    process.exit(1);
  }
}

async function deleteWebhook(): Promise<void> {
  console.log("Deleting webhook...");

  const result = await telegramPost("deleteWebhook");

  if (result.ok) {
    console.log("Webhook deleted successfully.");
  } else {
    console.error(`Failed to delete webhook: ${result.description}`);
    process.exit(1);
  }
}

async function showWebhookInfo(): Promise<void> {
  const result = await telegramPost("getWebhookInfo");

  if (result.ok && result.result) {
    const info = result.result;
    console.log("\nWebhook info:");
    console.log(`  URL:             ${info.url || "(not set)"}`);
    console.log(`  Pending updates: ${info.pending_update_count ?? "unknown"}`);
    if (info.last_error_date) {
      console.log(`  Last error:      ${info.last_error_message}`);
      console.log(
        `  Error date:      ${new Date((info.last_error_date as number) * 1000).toISOString()}`
      );
    }
    if (info.allowed_updates) {
      console.log(
        `  Allowed updates: ${(info.allowed_updates as string[]).join(", ")}`
      );
    }
  } else {
    console.error(`Failed to get webhook info: ${result.description}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (isInfo) {
    await showWebhookInfo();
  } else if (isDelete) {
    await deleteWebhook();
  } else if (webhookUrl) {
    await setWebhook(webhookUrl);
  } else {
    console.error("Usage:");
    console.error(
      "  pnpm telegram:setup <webhook-url>    Set webhook"
    );
    console.error(
      "  pnpm telegram:setup --info           Show current webhook info"
    );
    console.error(
      "  pnpm telegram:setup --delete         Remove webhook"
    );
    console.error("");
    console.error("Example:");
    console.error(
      "  pnpm telegram:setup https://espejo.railway.app/api/telegram"
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Telegram setup failed:", err);
  process.exit(1);
});
