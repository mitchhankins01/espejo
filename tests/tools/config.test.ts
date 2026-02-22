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

    const { config } = await import("../../src/config.js");
    expect(config.telegram.botToken).toBe("123:ABC");
    expect(config.telegram.secretToken).toBe("secret123");
    expect(config.telegram.allowedChatId).toBe("456789");
  });

  it("uses telegram defaults when env vars are missing", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_SECRET_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_CHAT_ID;

    const { config } = await import("../../src/config.js");
    expect(config.telegram.botToken).toBe("");
    expect(config.telegram.secretToken).toBe("");
    expect(config.telegram.allowedChatId).toBe("");
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
