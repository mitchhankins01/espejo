import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
} else {
  dotenv.config({ path: ".env.test", override: true });
}

const env = process.env.NODE_ENV || "development";
const telegramLlmProvider =
  process.env.TELEGRAM_LLM_PROVIDER?.toLowerCase() || "anthropic";
const telegramVoiceReplyMode =
  process.env.TELEGRAM_VOICE_REPLY_MODE?.toLowerCase() || "adaptive";

if (
  telegramLlmProvider !== "anthropic" &&
  telegramLlmProvider !== "openai"
) {
  throw new Error(
    `Invalid TELEGRAM_LLM_PROVIDER "${telegramLlmProvider}". Use "anthropic" or "openai".`
  );
}

if (
  telegramVoiceReplyMode !== "off" &&
  telegramVoiceReplyMode !== "adaptive" &&
  telegramVoiceReplyMode !== "always"
) {
  throw new Error(
    `Invalid TELEGRAM_VOICE_REPLY_MODE "${telegramVoiceReplyMode}". Use "off", "adaptive", or "always".`
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

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(
    `${name} must be a boolean (true/false). Received "${raw}".`
  );
}

const telegramVoiceReplyEvery = parseIntegerEnv(
  "TELEGRAM_VOICE_REPLY_EVERY",
  3,
  1
);
const telegramVoiceReplyMinChars = parseIntegerEnv(
  "TELEGRAM_VOICE_REPLY_MIN_CHARS",
  16,
  1
);
const telegramVoiceReplyMaxChars = parseIntegerEnv(
  "TELEGRAM_VOICE_REPLY_MAX_CHARS",
  450,
  16
);
const telegramSoulEnabled = parseBooleanEnv("TELEGRAM_SOUL_ENABLED", true);
const telegramSoulFeedbackEvery = parseIntegerEnv(
  "TELEGRAM_SOUL_FEEDBACK_EVERY",
  8,
  1
);
const telegramPulseEnabled = parseBooleanEnv("TELEGRAM_PULSE_ENABLED", true);
const telegramPulseIntervalHours = parseIntegerEnv(
  "TELEGRAM_PULSE_INTERVAL_HOURS",
  24,
  1
);

if (telegramVoiceReplyMinChars > telegramVoiceReplyMaxChars) {
  throw new Error(
    "TELEGRAM_VOICE_REPLY_MIN_CHARS must be less than or equal to TELEGRAM_VOICE_REPLY_MAX_CHARS."
  );
}

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
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    secretToken: process.env.TELEGRAM_SECRET_TOKEN || "",
    allowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID || "",
    llmProvider: telegramLlmProvider,
    voiceReplyMode: telegramVoiceReplyMode,
    voiceReplyEvery: telegramVoiceReplyEvery,
    voiceReplyMinChars: telegramVoiceReplyMinChars,
    voiceReplyMaxChars: telegramVoiceReplyMaxChars,
    soulEnabled: telegramSoulEnabled,
    soulFeedbackEvery: telegramSoulFeedbackEvery,
    pulseEnabled: telegramPulseEnabled,
    pulseIntervalHours: telegramPulseIntervalHours,
    voiceModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    voiceName: process.env.OPENAI_TTS_VOICE || "alloy",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
  },
  timezone: process.env.TIMEZONE || "Europe/Madrid",
  apiRates: {
    "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
    "gpt-4.1": { input: 2.0, output: 8.0 },
    "text-embedding-3-small": { input: 0.02, output: 0 },
    "whisper-1": { input: 0.006, output: 0 },
  } as Record<string, { input: number; output: number }>,
} as const;
