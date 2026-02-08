import "dotenv/config";

const env = process.env.NODE_ENV || "development";

const databaseUrl =
  process.env.DATABASE_URL ||
  ({
    development: "postgresql://dev:dev@localhost:5432/journal_dev",
    test: "postgresql://test:test@localhost:5433/journal_test",
    production: "",
  }[env] ??
    "");

if (env === "production" && !databaseUrl) {
  throw new Error(
    "DATABASE_URL is required in production. Set it as an environment variable."
  );
}

export const config = {
  env,
  database: {
    url: databaseUrl,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    embeddingModel: "text-embedding-3-small" as const,
    embeddingDimensions: 1536,
  },
  embedding: {
    batchSize: 100,
  },
  server: {
    port: parseInt(process.env.PORT || "3000", 10),
    mcpSecret: process.env.MCP_SECRET || "",
  },
} as const;
