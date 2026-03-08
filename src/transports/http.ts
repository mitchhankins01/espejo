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
  countArtifacts,
  searchArtifacts,
  searchArtifactsKeyword,
  listArtifactTags,
  listArtifactTitles,
  resolveArtifactTitleToId,
  syncExplicitLinks,
  findSimilarArtifacts,
  getExplicitLinks,
  getExplicitBacklinks,
  getArtifactGraph,
  searchContent,
  searchEntriesForPicker,
  listTodos,
  getTodoById,
  createTodo,
  updateTodo,
  deleteTodo,
  completeTodo,
  setTodoFocus,
  getFocusTodo,
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

  const artifactKindSchema = z.enum([
    "insight",
    "theory",
    "model",
    "reference",
    "note",
  ]);

  const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;

  const extractWikiLinkTitles = (markdown: string): string[] => {
    const titles = new Set<string>();
    for (const match of markdown.matchAll(wikiLinkPattern)) {
      const title = match[1]?.trim();
      if (title) titles.add(title);
    }
    return Array.from(titles);
  };

  const syncWikiLinksForArtifact = async (
    artifactId: string,
    markdown: string
  ): Promise<void> => {
    const titles = extractWikiLinkTitles(markdown);
    if (titles.length === 0) {
      await syncExplicitLinks(pool, artifactId, []);
      return;
    }

    const targetIds = (
      await Promise.all(
        titles.map((title) => resolveArtifactTitleToId(pool, title))
      )
    ).filter((id): id is string => Boolean(id));

    await syncExplicitLinks(pool, artifactId, targetIds);
  };

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
      const semantic = req.query.semantic === undefined
        ? true
        : String(req.query.semantic).toLowerCase() === "true";
      /* v8 ignore next */
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), q ? 50 : 100);
      /* v8 ignore next */
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      if (q) {
        const results = semantic
          ? await (async () => {
            const embedding = await generateEmbedding(q);
            return searchArtifacts(pool, embedding, q, { kind, tags, tags_mode: tagsMode }, limit);
          })()
          : await searchArtifactsKeyword(pool, q, { kind, tags, tags_mode: tagsMode }, limit);
        res.json(results);
      } else {
        const [results, total] = await Promise.all([
          listArtifacts(pool, { kind, tags, tags_mode: tagsMode, limit, offset }),
          countArtifacts(pool, { kind, tags, tags_mode: tagsMode }),
        ]);
        res.json({ items: results, total });
      }
    } catch (err) {
      console.error("Artifact list/search error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/tags — list tags used on artifacts with counts
  app.get("/api/artifacts/tags", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const tags = await listArtifactTags(pool);
      res.json(tags);
    } catch (err) {
      console.error("Artifact tags error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/titles — lightweight title list for quick switcher and link picker
  app.get("/api/artifacts/titles", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const titles = await listArtifactTitles(pool);
      res.json(titles);
    } catch (err) {
      console.error("Artifact titles error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/graph — graph data for force-directed view
  app.get("/api/artifacts/graph", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const graph = await getArtifactGraph(pool);
      const nodes = graph.artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        tags: artifact.tags,
      }));

      const edges: Array<{
        source: string;
        target: string;
        type: "semantic" | "explicit" | "tag" | "source";
        weight?: number;
      }> = [];

      for (const sim of graph.similarities) {
        edges.push({
          source: sim.id_1,
          target: sim.id_2,
          type: "semantic",
          weight: sim.similarity,
        });
      }

      for (const link of graph.explicitLinks) {
        edges.push({
          source: link.source_id,
          target: link.target_id,
          type: "explicit",
        });
      }

      const tagEdgeKeys = new Set<string>();
      for (let i = 0; i < graph.artifacts.length; i++) {
        for (let j = i + 1; j < graph.artifacts.length; j++) {
          const a = graph.artifacts[i];
          const b = graph.artifacts[j];
          const hasSharedTag = a.tags.some((tag) => b.tags.includes(tag));
          /* v8 ignore next -- mixed tag/non-tag pairs are data-dependent */
          if (!hasSharedTag) continue;

          const key = `${a.id}|${b.id}|tag`;
          /* v8 ignore next */
          if (tagEdgeKeys.has(key)) continue;
          tagEdgeKeys.add(key);
          edges.push({ source: a.id, target: b.id, type: "tag" });
        }
      }

      const sourceEdgeKeys = new Set<string>();
      for (const sourceLink of graph.sharedSources) {
        const key = `${sourceLink.artifact_id_1}|${sourceLink.artifact_id_2}|source`;
        /* v8 ignore next */
        if (sourceEdgeKeys.has(key)) continue;
        sourceEdgeKeys.add(key);
        edges.push({
          source: sourceLink.artifact_id_1,
          target: sourceLink.artifact_id_2,
          type: "source",
        });
      }

      res.json({ nodes, edges });
    } catch (err) {
      console.error("Artifact graph error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/:id/related — semantic + explicit links/backlinks
  app.get("/api/artifacts/:id/related", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const artifactId = req.params.id;
      const [semantic, outgoing, incoming] = await Promise.all([
        findSimilarArtifacts(pool, artifactId, 10, 0.3),
        getExplicitLinks(pool, artifactId),
        getExplicitBacklinks(pool, artifactId),
      ]);

      const explicit = [
        ...outgoing.map((item) => ({ ...item, direction: "outgoing" as const })),
        ...incoming.map((item) => ({ ...item, direction: "incoming" as const })),
      ];

      res.json({ semantic, explicit });
    } catch (err) {
      console.error("Artifact related error:", err);
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
      await syncWikiLinksForArtifact(artifact.id, artifact.body);
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
        await syncWikiLinksForArtifact(result.id, result.body);
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

  // ---------------------------------------------------------------------------
  // Todo endpoints
  // ---------------------------------------------------------------------------

  const todoStatusSchema = z.enum(["active", "waiting", "done", "someday"]);
  const createTodoSchema = z.object({
    title: z.string().min(1).max(300),
    status: todoStatusSchema.optional(),
    next_step: z.string().max(500).nullable().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    urgent: z.boolean().optional(),
    important: z.boolean().optional(),
    parent_id: z.string().optional(),
  });
  const updateTodoSchema = z.object({
    title: z.string().min(1).max(300).optional(),
    status: todoStatusSchema.optional(),
    next_step: z.string().max(500).nullable().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    urgent: z.boolean().optional(),
    important: z.boolean().optional(),
  });

  // GET /api/todos/focus — get current focus todo
  app.get("/api/todos/focus", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const todo = await getFocusTodo(pool);
      res.json(todo ?? null);
    } catch (err) {
      console.error("Todo focus error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/todos
  app.get("/api/todos", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const status = req.query.status
        ? todoStatusSchema.parse(req.query.status)
        : undefined;
      const urgent = req.query.urgent !== undefined
        ? req.query.urgent === "true"
        : undefined;
      const important = req.query.important !== undefined
        ? req.query.important === "true"
        : undefined;
      const parent_id = req.query.parent_id
        ? String(req.query.parent_id)
        : undefined;
      const focus_only = req.query.focus_only === "true" || undefined;
      const include_children = req.query.include_children === "true" || undefined;
      /* v8 ignore next 4 */
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1),
        100
      );
      /* v8 ignore next */
      const offset = Math.max(
        parseInt(String(req.query.offset ?? "0"), 10) || 0,
        0
      );

      const { rows, count } = await listTodos(pool, {
        status, urgent, important, parent_id, focus_only, include_children,
        limit, offset,
      });
      res.json({ items: rows, total: count });
    } catch (err) {
      console.error("Todo list error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/todos/:id
  app.get("/api/todos/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const todo = await getTodoById(pool, req.params.id);
      if (!todo) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(todo);
    } catch (err) {
      console.error("Todo get error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/todos
  app.post("/api/todos", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    const parsed = createTodoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    try {
      const todo = await createTodo(pool, parsed.data);
      res.status(201).json(todo);
    } catch (err) {
      console.error("Todo create error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // PUT /api/todos/:id
  app.put("/api/todos/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    const parsed = updateTodoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    try {
      const todo = await updateTodo(pool, req.params.id, parsed.data);
      if (!todo) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(todo);
    } catch (err) {
      console.error("Todo update error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/todos/:id/complete
  app.post("/api/todos/:id/complete", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const todo = await completeTodo(pool, req.params.id);
      if (!todo) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(todo);
    } catch (err) {
      console.error("Todo complete error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/todos/focus
  app.post("/api/todos/focus", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      if (req.body.clear) {
        await setTodoFocus(pool);
        res.json({ status: "cleared" });
        return;
      }
      if (!req.body.id) {
        res.status(400).json({ error: "Provide id or clear: true" });
        return;
      }
      const todo = await setTodoFocus(pool, req.body.id);
      if (!todo) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(todo);
    } catch (err) {
      console.error("Todo focus error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/todos/:id
  app.delete("/api/todos/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res)) return;

    try {
      const deleted = await deleteTodo(pool, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ status: "deleted" });
    } catch (err) {
      console.error("Todo delete error:", err);
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
