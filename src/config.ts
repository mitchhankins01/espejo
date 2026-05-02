import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.local", override: true });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
  dotenv.config({ path: ".env.local", override: true });
} else {
  dotenv.config({ path: ".env.test", override: true });
}

const env = process.env.NODE_ENV || "development";
const telegramLlmProvider =
  process.env.TELEGRAM_LLM_PROVIDER?.toLowerCase() || "anthropic";
if (
  telegramLlmProvider !== "anthropic" &&
  telegramLlmProvider !== "openai"
) {
  throw new Error(
    `Invalid TELEGRAM_LLM_PROVIDER "${telegramLlmProvider}". Use "anthropic" or "openai".`
  );
}

function parseIntegerEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || Number.isNaN(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}. Received "${raw}".`);
  }
  return value;
}

const ouraSyncIntervalMinutes = parseIntegerEnv(
  "OURA_SYNC_INTERVAL_MINUTES",
  60,
  1
);
const ouraSyncLookbackDays = parseIntegerEnv("OURA_SYNC_LOOKBACK_DAYS", 3, 1);

const databaseUrl =
  process.env.DATABASE_URL ||
  ({
    development: "postgresql://dev:dev@localhost:5434/journal_dev",
    test: "postgresql://test:test@localhost:5433/journal_test",
    production: "",
  }[env] ??
    "");

if (env === "production" && !databaseUrl) {
  throw new Error(
    "DATABASE_URL is required in production. Set it as an environment variable."
  );
}

if (env === "production" && !process.env.R2_PUBLIC_URL) {
  throw new Error(
    "R2_PUBLIC_URL is required in production. Set it as an environment variable."
  );
}

if (env === "production" && process.env.TELEGRAM_BOT_TOKEN) {
  const required: Record<string, string | undefined> = {
    TELEGRAM_SECRET_TOKEN: process.env.TELEGRAM_SECRET_TOKEN,
    TELEGRAM_ALLOWED_CHAT_ID: process.env.TELEGRAM_ALLOWED_CHAT_ID,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  if (telegramLlmProvider === "anthropic") {
    required.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `TELEGRAM_BOT_TOKEN is set but required vars are missing: ${missing.join(", ")}. ` +
        `Set all Telegram-related vars or remove TELEGRAM_BOT_TOKEN.`
    );
  }
}

export const config = {
  env,
  database: {
    url: databaseUrl,
  },
  openai: {
    apiKey: /* v8 ignore next -- env var fallback */ process.env.OPENAI_API_KEY || "",
    chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-5-mini",
    embeddingModel: "text-embedding-3-small" as const,
    embeddingDimensions: 1536,
  },
  embedding: {
    batchSize: 100,
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    bucketName: process.env.R2_BUCKET_NAME || "espejo-media",
    publicUrl: process.env.R2_PUBLIC_URL || "",
  },
  server: {
    port: parseInt(process.env.PORT || "3000", 10),
    mcpSecret: process.env.MCP_SECRET || "",
    oauthClientId: process.env.OAUTH_CLIENT_ID || "",
    oauthClientSecret: process.env.OAUTH_CLIENT_SECRET || "",
    appUrl: (process.env.APP_URL || "").replace(/\/+$/, ""),
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    secretToken: process.env.TELEGRAM_SECRET_TOKEN || "",
    allowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID || "",
    llmProvider: telegramLlmProvider,
    voiceModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    voiceName: process.env.OPENAI_TTS_VOICE || "alloy",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
  },
  oura: {
    accessToken: process.env.OURA_ACCESS_TOKEN || "",
    syncIntervalMinutes: ouraSyncIntervalMinutes,
    syncLookbackDays: ouraSyncLookbackDays,
  },
  onThisDay: {
    enabled: !!process.env.TELEGRAM_BOT_TOKEN,
    targetHour: parseIntegerEnv("ON_THIS_DAY_HOUR", 16, 0),
  },
  timezone: process.env.TIMEZONE || "Europe/Madrid",
  gmail: {
    appPassword: process.env.GMAIL_APP_PASSWORD || "",
    fromEmail: process.env.GMAIL_FROM_EMAIL || "mitchhankins01@gmail.com",
    toEmail:
      process.env.GMAIL_TO_EMAIL ||
      process.env.GMAIL_FROM_EMAIL ||
      "mitchhankins01@gmail.com",
    kindleEmail:
      process.env.KINDLE_EMAIL || "mitchhankins01_Afzu6H@kindle.com",
    juliaKindleEmail:
      process.env.JULIA_KINDLE_EMAIL || "iulia.ignatov_pjpj4i@kindle.com",
  },
} as const;
