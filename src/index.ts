#!/usr/bin/env node
import dotenv from "dotenv";
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env", override: true });
}
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pool } from "./db/client.js";
import { createServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf-8")
);
const VERSION: string = pkg.version;

const args = process.argv.slice(2);
const useHttp = args.includes("--http");

async function main(): Promise<void> {
  if (useHttp) {
    const { startHttpServer } = await import("./transports/http.js");
    await startHttpServer(() => createServer(pool, VERSION));
  } else {
    const server = createServer(pool, VERSION);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("espejo-mcp running on stdio");
  }
}

main().catch((err) => {
  console.error("Failed to start espejo-mcp:", err);
  process.exit(1);
});
