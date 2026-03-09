import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { notifyError } from "../telegram/notify.js";
import { sendTelegramMessage } from "../telegram/client.js";
import { runMemoryConsolidation } from "../memory/consolidation.js";
import { registerOAuthRoutes, isValidOAuthToken } from "./oauth.js";
import { startInsightTimer } from "../insights/engine.js";
import { runOuraNotableCheck } from "../insights/oura-notable.js";
import { startOuraSyncTimer } from "../oura/sync.js";
import { startCheckinTimer } from "../checkins/scheduler.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerSpanishRoutes } from "./routes/spanish.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerWeightRoutes } from "./routes/weights.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerTodoRoutes } from "./routes/todos.js";
import { registerEntryRoutes } from "./routes/entries.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import type { RouteDeps } from "./routes/types.js";

type ServerFactory = () => McpServer;

export async function startHttpServer(createServer: ServerFactory): Promise<void> {
  const port = config.server.port;
  const app = express();

  app.set("trust proxy", 1);
  /* v8 ignore start -- background timer callback is runtime-only */
  const runMemoryMaintenance = async (): Promise<void> => {
    try {
      const result = await runMemoryConsolidation(pool, {
        minSimilarity: 0.78,
        maxPairs: 20,
        activeCap: 40,
      });
      if (result.notes.length === 0) return;
      if (!config.telegram.botToken || !config.telegram.allowedChatId) return;
      await sendTelegramMessage(
        config.telegram.allowedChatId,
        `Memory maintenance: ${result.notes.join(" ")}`
      );
    } catch (err) {
      notifyError("Memory consolidation", err);
    }
  };
  const runAfterSync = async (): Promise<void> => {
    await runMemoryMaintenance();
    await runOuraNotableCheck(pool);
  };
  /* v8 ignore stop */
  startOuraSyncTimer(pool, runAfterSync);
  startInsightTimer(pool);
  startCheckinTimer(pool);
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

  // Shared dependencies for route modules
  const deps: RouteDeps = { pool, secret };

  // Register all route modules — order matters for static-before-param routes
  registerHealthRoutes(app);
  registerMetricsRoutes(app, deps);
  registerActivityRoutes(app, deps);
  registerSpanishRoutes(app, deps);
  registerObservabilityRoutes(app, deps);
  registerWeightRoutes(app, deps);
  registerArtifactRoutes(app, deps);
  registerTodoRoutes(app, deps);
  registerEntryRoutes(app, deps);
  registerTemplateRoutes(app, deps);
  registerSettingsRoutes(app, deps);

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
