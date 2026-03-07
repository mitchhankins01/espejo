import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { notifyError } from "../telegram/notify.js";
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
  createArtifact,
  updateArtifact,
  deleteArtifact,
  getArtifactById,
  listArtifacts,
  searchArtifacts,
  searchContent,
  searchEntriesForPicker,
} from "../db/queries.js";
import { generateEmbedding } from "../db/embeddings.js";
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
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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

  // ---------------------------------------------------------------------------
  // Knowledge artifact endpoints
  // ---------------------------------------------------------------------------

  const requireBearerAuth = (req: express.Request, res: express.Response): boolean => {
    if (!secret) return true;
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    /* v8 ignore next */
    return true;
  };

  const artifactKindSchema = z.enum(["insight", "theory", "model", "reference"]);

  // GET /api/artifacts — list or search
  app.get("/api/artifacts", async (req, res) => {
    if (!requireBearerAuth(req, res)) return;

    try {
      const q = req.query.q ? String(req.query.q) : undefined;
      /* v8 ignore next */
      const kind = req.query.kind ? artifactKindSchema.parse(req.query.kind) : undefined;
      /* v8 ignore next */
      const tags = req.query.tags ? String(req.query.tags).split(",").filter(Boolean) : undefined;
      /* v8 ignore next */
      const tagsMode = (req.query.tags_mode === "all" ? "all" : "any") as "any" | "all";
      /* v8 ignore next */
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), q ? 50 : 100);
      /* v8 ignore next */
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      if (q) {
        const embedding = await generateEmbedding(q);
        const results = await searchArtifacts(pool, embedding, q, { kind, tags, tags_mode: tagsMode }, limit);
        res.json(results);
      } else {
        const results = await listArtifacts(pool, { kind, tags, tags_mode: tagsMode, limit, offset });
        res.json(results);
      }
    } catch (err) {
      console.error("Artifact list/search error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/:id
  app.get("/api/artifacts/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const artifact = await getArtifactById(pool, req.params.id);
      if (!artifact) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(artifact);
    } catch (err) {
      console.error("Artifact get error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  const createArtifactSchema = z.object({
    kind: artifactKindSchema,
    title: z.string().min(1).max(300),
    body: z.string().min(1),
    tags: z.array(z.string()).optional(),
    source_entry_uuids: z.array(z.string()).optional(),
  });

  // POST /api/artifacts
  app.post("/api/artifacts", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    const parsed = createArtifactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    try {
      const artifact = await createArtifact(pool, parsed.data);
      res.status(201).json(artifact);
    } catch (err) {
      console.error("Artifact create error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  const updateArtifactSchema = z.object({
    kind: artifactKindSchema.optional(),
    title: z.string().min(1).max(300).optional(),
    body: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    source_entry_uuids: z.array(z.string()).optional(),
    expected_version: z.number().int().min(1),
  });

  // PUT /api/artifacts/:id
  app.put("/api/artifacts/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    const parsed = updateArtifactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    try {
      const { expected_version, ...data } = parsed.data;
      const result = await updateArtifact(pool, req.params.id, expected_version, data);

      if (result === null) {
        res.status(404).json({ error: "Not found" });
      } else if (result === "version_conflict") {
        res.status(409).json({ error: "Version conflict. Reload and try again." });
      } else {
        res.json(result);
      }
    } catch (err) {
      console.error("Artifact update error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/artifacts/:id
  app.delete("/api/artifacts/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const deleted = await deleteArtifact(pool, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ status: "deleted" });
    } catch (err) {
      console.error("Artifact delete error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/entries/search — lightweight search for source picker
  app.get("/api/entries/search", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    const q = req.query.q ? String(req.query.q) : "";
    if (!q) {
      res.status(400).json({ error: "Missing q parameter" });
      return;
    }

    try {
      /* v8 ignore next */
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), 50);
      const results = await searchEntriesForPicker(pool, q, limit);
      res.json(results);
    } catch (err) {
      console.error("Entry search error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/content/search — unified search
  app.get("/api/content/search", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    const q = req.query.q ? String(req.query.q) : "";
    if (!q) {
      res.status(400).json({ error: "Missing q parameter" });
      return;
    }

    try {
      /* v8 ignore next */
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), 50);
      const contentTypes = req.query.content_types
        ? String(req.query.content_types).split(",").filter(Boolean) as ("journal_entry" | "knowledge_artifact")[]
        : undefined;
      const embedding = await generateEmbedding(q);
      const results = await searchContent(pool, embedding, q, { content_types: contentTypes }, limit);
      res.json(results);
    } catch (err) {
      console.error("Content search error:", err);
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

  // Serve web app static files from web/dist
  /* v8 ignore next 9 -- static file serving only active when web build exists */
  const webDistPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "..", "web", "dist"
  );
  app.use(express.static(webDistPath));
  app.get("/{*splat}", (_req, res, next) => {
    if (_req.path.startsWith("/api") || _req.path.startsWith("/mcp")) return next();
    res.sendFile(path.join(webDistPath, "index.html"));
  });

  const server = app.listen(port, "0.0.0.0", () => {
    console.error(`espejo-mcp HTTP server running on http://0.0.0.0:${port}`);
  });
  /* v8 ignore next 4 -- runtime-only: HTTP server errors are not unit-testable */
  server.on("error", (err) => {
    console.error("HTTP server error:", err);
    notifyError("HTTP server", err);
  });
}
