import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("dotenv", () => ({ default: { config: () => {} } }));

describe("config", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("throws in production when DATABASE_URL is missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;

    await expect(() => import("../../src/config.js")).rejects.toThrow(
      "DATABASE_URL"
    );
  });

  it("throws in production when R2_PUBLIC_URL is missing", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://prod:prod@db/journal";
    delete process.env.R2_PUBLIC_URL;

    await expect(() => import("../../src/config.js")).rejects.toThrow(
      "R2_PUBLIC_URL"
    );
  });

  it("succeeds in production when all required vars are set", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://prod:prod@db/journal";
    process.env.R2_PUBLIC_URL = "https://media.example.com";

    const { config } = await import("../../src/config.js");
    expect(config.env).toBe("production");
    expect(config.database.url).toBe("postgresql://prod:prod@db/journal");
  });

  it("uses development database defaults", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;

    const { config } = await import("../../src/config.js");
    expect(config.database.url).toContain("localhost:5434");
    expect(config.database.url).toContain("journal_dev");
  });

  it("uses test database defaults", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;

    const { config } = await import("../../src/config.js");
    expect(config.database.url).toContain("localhost:5433");
    expect(config.database.url).toContain("journal_test");
  });

  it("reads R2 config from env vars", async () => {
    process.env.NODE_ENV = "development";
    process.env.R2_ACCOUNT_ID = "acct-123";
    process.env.R2_ACCESS_KEY_ID = "key-456";
    process.env.R2_SECRET_ACCESS_KEY = "secret-789";
    process.env.R2_BUCKET_NAME = "my-bucket";
    process.env.R2_PUBLIC_URL = "https://cdn.example.com";

    const { config } = await import("../../src/config.js");
    expect(config.r2.accountId).toBe("acct-123");
    expect(config.r2.accessKeyId).toBe("key-456");
    expect(config.r2.secretAccessKey).toBe("secret-789");
    expect(config.r2.bucketName).toBe("my-bucket");
    expect(config.r2.publicUrl).toBe("https://cdn.example.com");
  });

  it("uses R2 defaults when env vars are missing", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_BUCKET_NAME;

    const { config } = await import("../../src/config.js");
    expect(config.r2.accountId).toBe("");
    expect(config.r2.bucketName).toBe("espejo-media");
  });

  it("reads PORT env var", async () => {
    process.env.NODE_ENV = "development";
    process.env.PORT = "8080";

    const { config } = await import("../../src/config.js");
    expect(config.server.port).toBe(8080);
  });

  it("defaults PORT to 3000", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.PORT;

    const { config } = await import("../../src/config.js");
    expect(config.server.port).toBe(3000);
  });

  it("defaults NODE_ENV to development when undefined", async () => {
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;

    const { config } = await import("../../src/config.js");
    expect(config.env).toBe("development");
    expect(config.database.url).toContain("localhost:5434");
  });

  it("reads OPENAI_API_KEY from env", async () => {
    process.env.NODE_ENV = "development";
    process.env.OPENAI_API_KEY = "sk-test-key-123";

    const { config } = await import("../../src/config.js");
    expect(config.openai.apiKey).toBe("sk-test-key-123");
  });

  it("reads OPENAI_CHAT_MODEL from env", async () => {
    process.env.NODE_ENV = "development";
    process.env.OPENAI_CHAT_MODEL = "gpt-4.1-mini";

    const { config } = await import("../../src/config.js");
    expect(config.openai.chatModel).toBe("gpt-4.1-mini");
  });

  it("defaults OPENAI_CHAT_MODEL when env var is missing", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.OPENAI_CHAT_MODEL;

    const { config } = await import("../../src/config.js");
    expect(config.openai.chatModel).toBe("gpt-5-mini");
  });

  it("falls back to empty string for unknown NODE_ENV", async () => {
    process.env.NODE_ENV = "staging";
    delete process.env.DATABASE_URL;

    const { config } = await import("../../src/config.js");
    expect(config.database.url).toBe("");
  });

  it("prefers DATABASE_URL env var over defaults", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgresql://custom:custom@mydb/journal";

    const { config } = await import("../../src/config.js");
    expect(config.database.url).toBe(
      "postgresql://custom:custom@mydb/journal"
    );
  });

  it("reads telegram config from env vars", async () => {
    process.env.NODE_ENV = "development";
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
    process.env.TELEGRAM_SECRET_TOKEN = "secret123";
    process.env.TELEGRAM_ALLOWED_CHAT_ID = "456789";
    process.env.TELEGRAM_LLM_PROVIDER = "openai";
    process.env.TELEGRAM_VOICE_REPLY_MODE = "always";
    process.env.TELEGRAM_VOICE_REPLY_EVERY = "2";
    process.env.TELEGRAM_VOICE_REPLY_MIN_CHARS = "10";
    process.env.TELEGRAM_VOICE_REPLY_MAX_CHARS = "200";
    process.env.OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
    process.env.OPENAI_TTS_VOICE = "alloy";

    const { config } = await import("../../src/config.js");
    expect(config.telegram.botToken).toBe("123:ABC");
    expect(config.telegram.secretToken).toBe("secret123");
    expect(config.telegram.allowedChatId).toBe("456789");
    expect(config.telegram.llmProvider).toBe("openai");
    expect(config.telegram.voiceReplyMode).toBe("always");
    expect(config.telegram.voiceReplyEvery).toBe(2);
    expect(config.telegram.voiceReplyMinChars).toBe(10);
    expect(config.telegram.voiceReplyMaxChars).toBe(200);
    expect(config.telegram.voiceModel).toBe("gpt-4o-mini-tts");
    expect(config.telegram.voiceName).toBe("alloy");
  });

  it("uses telegram defaults when env vars are missing", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_SECRET_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_CHAT_ID;
    delete process.env.TELEGRAM_LLM_PROVIDER;
    delete process.env.TELEGRAM_VOICE_REPLY_MODE;
    delete process.env.TELEGRAM_VOICE_REPLY_EVERY;
    delete process.env.TELEGRAM_VOICE_REPLY_MIN_CHARS;
    delete process.env.TELEGRAM_VOICE_REPLY_MAX_CHARS;
    delete process.env.OPENAI_TTS_MODEL;
    delete process.env.OPENAI_TTS_VOICE;

    const { config } = await import("../../src/config.js");
    expect(config.telegram.botToken).toBe("");
    expect(config.telegram.secretToken).toBe("");
    expect(config.telegram.allowedChatId).toBe("");
    expect(config.telegram.llmProvider).toBe("anthropic");
    expect(config.telegram.voiceReplyMode).toBe("adaptive");
    expect(config.telegram.voiceReplyEvery).toBe(3);
    expect(config.telegram.voiceReplyMinChars).toBe(16);
    expect(config.telegram.voiceReplyMaxChars).toBe(450);
    expect(config.telegram.voiceModel).toBe("gpt-4o-mini-tts");
    expect(config.telegram.voiceName).toBe("alloy");
  });

  it("throws for invalid TELEGRAM_LLM_PROVIDER", async () => {
    process.env.NODE_ENV = "development";
    process.env.TELEGRAM_LLM_PROVIDER = "invalid";

    await expect(() => import("../../src/config.js")).rejects.toThrow(
      "Invalid TELEGRAM_LLM_PROVIDER"
    );
  });

  it("throws for invalid TELEGRAM_VOICE_REPLY_MODE", async () => {
    process.env.NODE_ENV = "development";
    process.env.TELEGRAM_VOICE_REPLY_MODE = "sometimes";

    await expect(() => import("../../src/config.js")).rejects.toThrow(
      "Invalid TELEGRAM_VOICE_REPLY_MODE"
    );
  });

  it("throws when TELEGRAM_VOICE_REPLY_MIN_CHARS is greater than max", async () => {
    process.env.NODE_ENV = "development";
    process.env.TELEGRAM_VOICE_REPLY_MIN_CHARS = "200";
    process.env.TELEGRAM_VOICE_REPLY_MAX_CHARS = "100";

    await expect(() => import("../../src/config.js")).rejects.toThrow(
      "TELEGRAM_VOICE_REPLY_MIN_CHARS must be less than or equal to TELEGRAM_VOICE_REPLY_MAX_CHARS."
    );
  });

  it("reads anthropic config from env vars", async () => {
    process.env.NODE_ENV = "development";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_MODEL = "claude-opus-4-20250514";

    const { config } = await import("../../src/config.js");
    expect(config.anthropic.apiKey).toBe("sk-ant-test");
    expect(config.anthropic.model).toBe("claude-opus-4-20250514");
  });

  it("uses anthropic defaults when env vars are missing", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;

    const { config } = await import("../../src/config.js");
    expect(config.anthropic.apiKey).toBe("");
    expect(config.anthropic.model).toBe("claude-sonnet-4-6");
  });

  it("reads TIMEZONE from env", async () => {
    process.env.NODE_ENV = "development";
    process.env.TIMEZONE = "America/Los_Angeles";

    const { config } = await import("../../src/config.js");
    expect(config.timezone).toBe("America/Los_Angeles");
  });

  it("defaults TIMEZONE to Europe/Madrid", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.TIMEZONE;

    const { config } = await import("../../src/config.js");
    expect(config.timezone).toBe("Europe/Madrid");
  });

  it("throws in production when TELEGRAM_BOT_TOKEN is set but dependencies are missing", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://prod:prod@db/journal";
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
    delete process.env.TELEGRAM_SECRET_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_CHAT_ID;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await expect(() => import("../../src/config.js")).rejects.toThrow(
      "TELEGRAM_BOT_TOKEN is set but required vars are missing"
    );
  });

  it("succeeds in production when TELEGRAM_BOT_TOKEN is set with all dependencies", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://prod:prod@db/journal";
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
    process.env.TELEGRAM_SECRET_TOKEN = "secret123";
    process.env.TELEGRAM_ALLOWED_CHAT_ID = "456789";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-openai-test";

    const { config } = await import("../../src/config.js");
    expect(config.telegram.botToken).toBe("123:ABC");
  });

  it("succeeds in production with openai provider without anthropic key", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://prod:prod@db/journal";
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
    process.env.TELEGRAM_SECRET_TOKEN = "secret123";
    process.env.TELEGRAM_ALLOWED_CHAT_ID = "456789";
    process.env.TELEGRAM_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-openai-test";
    delete process.env.ANTHROPIC_API_KEY;

    const { config } = await import("../../src/config.js");
    expect(config.telegram.botToken).toBe("123:ABC");
    expect(config.telegram.llmProvider).toBe("openai");
  });

  it("succeeds in production without Telegram when bot token is not set", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://prod:prod@db/journal";
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    delete process.env.TELEGRAM_BOT_TOKEN;

    const { config } = await import("../../src/config.js");
    expect(config.telegram.botToken).toBe("");
  });

  it("has apiRates with expected models", async () => {
    process.env.NODE_ENV = "development";

    const { config } = await import("../../src/config.js");
    expect(config.apiRates["claude-sonnet-4-6"]).toEqual({
      input: 3.0,
      output: 15.0,
    });
    expect(config.apiRates["text-embedding-3-small"]).toEqual({
      input: 0.02,
      output: 0,
    });
    expect(config.apiRates["whisper-1"]).toEqual({
      input: 0.006,
      output: 0,
    });
  });
});
