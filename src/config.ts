import dotenv from "dotenv";
import type { LlmProvider } from "./llm/index.js";
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
const telegramLlmProvider = (process.env.TELEGRAM_LLM_PROVIDER?.toLowerCase() ||
  "anthropic") as LlmProvider;
if (
  telegramLlmProvider !== "anthropic" &&
  telegramLlmProvider !== "openai" &&
  telegramLlmProvider !== "deepseek"
) {
  throw new Error(
    `Invalid TELEGRAM_LLM_PROVIDER "${telegramLlmProvider}". Use "anthropic", "openai", or "deepseek".`
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
  } else if (telegramLlmProvider === "deepseek") {
    required.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
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
    // Model backing the conversational chat flow (src/telegram/flows/chat.ts).
    // Chat-only — distinct from the fast/distill tiers in config.models.
    chatModel: process.env.TELEGRAM_CHAT_MODEL || "deepseek-v4-pro",
    voiceModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    voiceName: process.env.OPENAI_TTS_VOICE || "alloy",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  models: {
    anthropicFast:
      process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-4-5-20251001",
    // HN distillation (src/hn/distill.ts). Routed through the cross-provider
    // chat() helper, so provider is configurable. Defaults to DeepSeek for
    // cost — Opus-quality distills are not worth Opus pricing on a daily cron.
    distillProvider: (process.env.HN_DISTILL_PROVIDER ||
      "deepseek") as LlmProvider,
    distillModel: process.env.HN_DISTILL_MODEL || "deepseek-v4-pro",
    // Long-form tomo writer + planner (scripts/book/*). Restored after the
    // 14d29bd rename dropped the old `anthropicChat` key these depended on.
    bookWriter: process.env.ANTHROPIC_BOOK_MODEL || "claude-opus-4-8",
    openaiVision: process.env.OPENAI_VISION_MODEL || "gpt-4.1",
    openaiTranscribe: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
    openaiCondense: process.env.OPENAI_CONDENSE_MODEL || "gpt-4o",
    // Dedup-council leg models live in scripts/dedup/council-models.json — the
    // council runs as a plain-node .mjs that can't import this TS config, so
    // that JSON is their single source of truth. Don't re-declare them here.
  },
  oura: {
    accessToken: process.env.OURA_ACCESS_TOKEN || "",
    syncIntervalMinutes: ouraSyncIntervalMinutes,
    syncLookbackDays: ouraSyncLookbackDays,
  },
  timezone: process.env.TIMEZONE || "Europe/Madrid",
  github: {
    owner: process.env.GITHUB_OWNER || "mitchhankins01",
    repo: process.env.GITHUB_REPO || "espejo",
  },
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
