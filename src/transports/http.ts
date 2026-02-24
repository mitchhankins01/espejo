import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import {
  upsertDailyMetric,
  getActivityLog,
  getRecentActivityLogs,
  getRetentionByInterval,
  getVocabularyFunnel,
  getGradeTrend,
  getLapseRateTrend,
  getProgressTimeSeries,
  getRetentionByContext,
  getSpanishQuizStats,
  getSpanishAdaptiveContext,
  getSpanishAssessments,
  getLatestSpanishAssessment,
} from "../db/queries.js";
import { registerOAuthRoutes, isValidOAuthToken } from "./oauth.js";
import { startOuraSyncTimer } from "../oura/sync.js";

type ServerFactory = () => McpServer;

export async function startHttpServer(createServer: ServerFactory): Promise<void> {
  const port = config.server.port;
  const app = express();

  app.set("trust proxy", 1);
  startOuraSyncTimer(pool);
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

  // Activity log endpoints — bearer token auth (same as /api/metrics)
  app.get("/api/activity", async (req, res) => {
    if (secret) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    try {
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1),
        100
      );
      const since = req.query.since
        ? new Date(String(req.query.since))
        : undefined;
      const toolName = req.query.tool ? String(req.query.tool) : undefined;

      const logs = await getRecentActivityLogs(pool, {
        toolName,
        since,
        limit,
      });
      res.json(logs);
    } catch (err) {
      console.error("Activity log list error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/activity/:id", async (req, res) => {
    if (secret) {
      const auth = req.headers.authorization;
      const queryToken = req.query.token;
      if (queryToken === secret) {
        // Allow token-based auth via query param (for Telegram detail links)
      } else if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: "Invalid ID" });
        return;
      }
      const log = await getActivityLog(pool, id);
      if (!log) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(log);
    } catch (err) {
      console.error("Activity log error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // Spanish analytics endpoints
  // ---------------------------------------------------------------------------

  app.get("/api/spanish/:chatId/dashboard", async (req, res) => {
    if (secret) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const chatId = req.params.chatId;
    const days = Math.min(
      Math.max(parseInt(String(req.query.days ?? "90"), 10) || 90, 1),
      365
    );

    try {
      const [
        stats,
        adaptive,
        retention,
        funnel,
        gradeTrend,
        lapseTrend,
        progress,
        contextRetention,
        latestAssessment,
      ] = await Promise.all([
        getSpanishQuizStats(pool, chatId),
        getSpanishAdaptiveContext(pool, chatId),
        getRetentionByInterval(pool, chatId),
        getVocabularyFunnel(pool, chatId),
        getGradeTrend(pool, chatId, days),
        getLapseRateTrend(pool, chatId, days),
        getProgressTimeSeries(pool, chatId, days),
        getRetentionByContext(pool, chatId),
        getLatestSpanishAssessment(pool, chatId),
      ]);

      res.json({
        stats,
        adaptive,
        retention,
        funnel,
        grade_trend: gradeTrend,
        lapse_trend: lapseTrend,
        progress,
        context_retention: contextRetention,
        latest_assessment: latestAssessment,
      });
    } catch (err) {
      console.error("Spanish dashboard error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/spanish/:chatId/assessments", async (req, res) => {
    if (secret) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const chatId = req.params.chatId;
    const days = Math.min(
      Math.max(parseInt(String(req.query.days ?? "90"), 10) || 90, 1),
      365
    );

    try {
      const assessments = await getSpanishAssessments(pool, chatId, days);
      res.json(assessments);
    } catch (err) {
      console.error("Spanish assessments error:", err);
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
