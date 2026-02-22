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
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
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
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
  },
  timezone: process.env.TIMEZONE || "Europe/Madrid",
  apiRates: {
    "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
    "text-embedding-3-small": { input: 0.02, output: 0 },
    "whisper-1": { input: 0.006, output: 0 },
  } as Record<string, { input: number; output: number }>,
} as const;
