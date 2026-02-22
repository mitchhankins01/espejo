import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { upsertDailyMetric } from "../db/queries.js";
import { registerOAuthRoutes, isValidOAuthToken } from "./oauth.js";

type ServerFactory = () => McpServer;

export async function startHttpServer(createServer: ServerFactory): Promise<void> {
  const port = config.server.port;
  const app = express();

  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // CORS
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Health check (public)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // OAuth routes (public — needed for the auth flow itself)
  registerOAuthRoutes(app);

  // Bearer token auth on /mcp — accepts MCP_SECRET or OAuth access tokens
  const secret = config.server.mcpSecret;
  app.use("/mcp", (req, res, next) => {
    if (!secret && !config.server.oauthClientId) return next();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    const token = auth.slice(7);
    if ((secret && token === secret) || isValidOAuthToken(token)) {
      return next();
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Unauthorized" },
      id: null,
    });
  });

  // Metrics ingestion endpoint — accepts daily weight (and later Oura) data
  // Accepts a single object OR an array of objects for batch ingestion
  const metricItemSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format"),
    weight_kg: z.number().positive(),
  });
  const metricsBodySchema = z.union([
    metricItemSchema,
    z.array(metricItemSchema).min(1),
  ]);

  app.post("/api/metrics", async (req, res) => {
    // Bearer token auth (same MCP_SECRET)
    if (secret) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const parsed = metricsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

    try {
      for (const item of items) {
        await upsertDailyMetric(pool, item.date, item.weight_kg);
      }
      res.json({ status: "ok", count: items.length, items });
    } catch (err) {
      console.error("Metrics upsert error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Telegram webhook (conditional — only when bot token is configured)
  /* v8 ignore next 4 -- dynamic import tested in telegram-webhook.test.ts */
  if (config.telegram.botToken) {
    const { registerTelegramRoutes } = await import("../telegram/webhook.js");
    registerTelegramRoutes(app);
  }

  // MCP endpoint — fresh server + transport per request (SDK requirement)
  app.post("/mcp", async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: String(err) },
          id: null,
        });
      }
    }
  });

  app.listen(port, "0.0.0.0", () => {
    console.error(`espejo-mcp HTTP server running on http://0.0.0.0:${port}`);
  });
}
