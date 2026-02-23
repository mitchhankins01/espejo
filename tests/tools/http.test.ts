import { describe, it, expect, vi, beforeEach } from "vitest";

const mockApp = {
  set: vi.fn().mockReturnThis(),
  use: vi.fn().mockReturnThis(),
  get: vi.fn().mockReturnThis(),
  post: vi.fn().mockReturnThis(),
  listen: vi.fn().mockImplementation(
    (_port: number, _host: string, cb: () => void) => {
      cb();
    }
  ),
};

vi.mock("express", () => {
  const fn = vi.fn(() => mockApp);
  (fn as any).json = vi.fn(() => "json-middleware");
  (fn as any).urlencoded = vi.fn(() => "urlencoded-middleware");
  return { default: fn };
});

vi.mock("../../src/config.js", () => ({
  config: {
    server: { port: 3000, mcpSecret: "", oauthClientId: "", oauthClientSecret: "" },
    telegram: { botToken: "", secretToken: "", allowedChatId: "" },
  },
}));

vi.mock("../../src/transports/oauth.js", () => ({
  registerOAuthRoutes: vi.fn(),
  isValidOAuthToken: vi.fn(() => false),
}));

const { mockPool, mockUpsertDailyMetric, mockGetActivityLog, mockGetRecentActivityLogs } = vi.hoisted(() => ({
  mockPool: {},
  mockUpsertDailyMetric: vi.fn(),
  mockGetActivityLog: vi.fn(),
  mockGetRecentActivityLogs: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  pool: mockPool,
}));

vi.mock("../../src/db/queries.js", () => ({
  upsertDailyMetric: mockUpsertDailyMetric,
  getActivityLog: mockGetActivityLog,
  getRecentActivityLogs: mockGetRecentActivityLogs,
}));

const mockHandleRequest = vi.fn();
vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(() => ({
    handleRequest: mockHandleRequest,
  })),
}));

import { startHttpServer } from "../../src/transports/http.js";

describe("startHttpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertDailyMetric.mockReset();
    mockGetActivityLog.mockReset();
    mockGetRecentActivityLogs.mockReset();
    // Restore mock implementations after clearAllMocks
    mockApp.set.mockReturnThis();
    mockApp.use.mockReturnThis();
    mockApp.get.mockReturnThis();
    mockApp.post.mockReturnThis();
    mockApp.listen.mockImplementation(
      (_port: number, _host: string, cb: () => void) => {
        cb();
      }
    );
  });

  it("creates express app and listens on configured port", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    expect(mockApp.listen).toHaveBeenCalledWith(
      3000,
      "0.0.0.0",
      expect.any(Function)
    );
  });

  it("sets trust proxy", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    expect(mockApp.set).toHaveBeenCalledWith("trust proxy", 1);
  });

  it("registers json middleware", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    expect(mockApp.use).toHaveBeenCalled();
  });

  it("registers health endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    expect(mockApp.get).toHaveBeenCalledWith("/health", expect.any(Function));
  });

  it("health endpoint returns status ok", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const healthCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/health"
    );
    const healthHandler = healthCall![1];
    const mockRes = { json: vi.fn() };
    healthHandler({}, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith({ status: "ok" });
  });

  it("registers MCP endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    expect(mockApp.post).toHaveBeenCalledWith("/mcp", expect.any(Function));
  });

  it("MCP endpoint creates transport and handles request", async () => {
    const mockConnect = vi.fn();
    const mockFactory = vi.fn(() => ({ connect: mockConnect }));
    await startHttpServer(mockFactory as any);

    const mcpCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/mcp"
    );
    const mcpHandler = mcpCall![1];
    const mockReq = { body: { test: true } };
    const mockRes = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() };

    await mcpHandler(mockReq, mockRes);

    expect(mockFactory).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(mockHandleRequest).toHaveBeenCalledWith(
      mockReq,
      mockRes,
      mockReq.body
    );
  });

  it("auth middleware skips when no secret or oauthClientId configured", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const authCall = mockApp.use.mock.calls.find(
      (c: any[]) => c[0] === "/mcp"
    );
    const authMiddleware = authCall![1];

    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    authMiddleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("auth middleware rejects missing bearer token when secret is set", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const authCall = mockApp.use.mock.calls.find(
      (c: any[]) => c[0] === "/mcp"
    );
    const authMiddleware = authCall![1];

    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    authMiddleware(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(401);

    (config as any).server.mcpSecret = "";
  });

  it("auth middleware accepts valid secret token", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const authCall = mockApp.use.mock.calls.find(
      (c: any[]) => c[0] === "/mcp"
    );
    const authMiddleware = authCall![1];

    const mockReq = { headers: { authorization: "Bearer test-secret" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    authMiddleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();

    (config as any).server.mcpSecret = "";
  });

  it("auth middleware rejects invalid token", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const authCall = mockApp.use.mock.calls.find(
      (c: any[]) => c[0] === "/mcp"
    );
    const authMiddleware = authCall![1];

    const mockReq = { headers: { authorization: "Bearer wrong-token" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    authMiddleware(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(401);

    (config as any).server.mcpSecret = "";
  });

  it("MCP endpoint returns 500 on error", async () => {
    const mockConnect = vi.fn().mockRejectedValue(new Error("connection failed"));
    const mockFactory = vi.fn(() => ({ connect: mockConnect }));
    await startHttpServer(mockFactory as any);

    const mcpCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/mcp"
    );
    const mcpHandler = mcpCall![1];
    const mockReq = { body: {} };
    const mockRes = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() };

    await mcpHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        error: expect.objectContaining({ code: -32603 }),
      })
    );
  });

  it("MCP endpoint skips response if headers already sent", async () => {
    const mockConnect = vi.fn().mockRejectedValue(new Error("oops"));
    const mockFactory = vi.fn(() => ({ connect: mockConnect }));
    await startHttpServer(mockFactory as any);

    const mcpCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/mcp"
    );
    const mcpHandler = mcpCall![1];
    const mockReq = { body: {} };
    const mockRes = { headersSent: true, status: vi.fn().mockReturnThis(), json: vi.fn() };

    await mcpHandler(mockReq, mockRes);

    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("CORS middleware sets headers for non-OPTIONS requests", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    // Find the CORS middleware (a use() call with a function argument)
    const corsCall = mockApp.use.mock.calls.find(
      (c: any[]) => typeof c[0] === "function"
    );
    const corsMiddleware = corsCall![0];

    const mockReq = { method: "GET" };
    const mockRes = { header: vi.fn(), sendStatus: vi.fn() };
    const mockNext = vi.fn();

    corsMiddleware(mockReq, mockRes, mockNext);

    expect(mockRes.header).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "*"
    );
    expect(mockRes.header).toHaveBeenCalledWith(
      "Access-Control-Allow-Methods",
      "GET, POST, DELETE, OPTIONS"
    );
    expect(mockRes.header).toHaveBeenCalledWith(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    expect(mockNext).toHaveBeenCalled();
  });

  it("registers /api/metrics endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const metricsCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/metrics"
    );
    expect(metricsCall).toBeTruthy();
  });

  it("/api/metrics accepts valid weight data", async () => {
    mockUpsertDailyMetric.mockResolvedValue(undefined);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const metricsCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/metrics"
    );
    const metricsHandler = metricsCall![1];

    const mockReq = {
      headers: {},
      body: { date: "2026-02-21", weight_kg: 82.3 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await metricsHandler(mockReq, mockRes);

    expect(mockUpsertDailyMetric).toHaveBeenCalledWith(mockPool, "2026-02-21", 82.3);
    expect(mockRes.json).toHaveBeenCalledWith({
      status: "ok",
      count: 1,
      items: [{ date: "2026-02-21", weight_kg: 82.3 }],
    });
  });

  it("/api/metrics accepts an array of weight records", async () => {
    mockUpsertDailyMetric.mockResolvedValue(undefined);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const metricsCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/metrics"
    );
    const metricsHandler = metricsCall![1];

    const mockReq = {
      headers: {},
      body: [
        { date: "2026-02-14", weight_kg: 76.6 },
        { date: "2026-02-15", weight_kg: 76.8 },
        { date: "2026-02-16", weight_kg: 76.5 },
      ],
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await metricsHandler(mockReq, mockRes);

    expect(mockUpsertDailyMetric).toHaveBeenCalledTimes(3);
    expect(mockUpsertDailyMetric).toHaveBeenCalledWith(mockPool, "2026-02-14", 76.6);
    expect(mockUpsertDailyMetric).toHaveBeenCalledWith(mockPool, "2026-02-15", 76.8);
    expect(mockUpsertDailyMetric).toHaveBeenCalledWith(mockPool, "2026-02-16", 76.5);
    expect(mockRes.json).toHaveBeenCalledWith({
      status: "ok",
      count: 3,
      items: mockReq.body,
    });
  });

  it("/api/metrics rejects invalid date format", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const metricsCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/metrics"
    );
    const metricsHandler = metricsCall![1];

    const mockReq = {
      headers: {},
      body: { date: "not-a-date", weight_kg: 82.3 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await metricsHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/metrics rejects missing weight_kg", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const metricsCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/metrics"
    );
    const metricsHandler = metricsCall![1];

    const mockReq = {
      headers: {},
      body: { date: "2026-02-21" },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await metricsHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/metrics rejects unauthorized when secret is set", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const metricsCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/metrics"
    );
    const metricsHandler = metricsCall![1];

    const mockReq = {
      headers: {},
      body: { date: "2026-02-21", weight_kg: 82.3 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await metricsHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockUpsertDailyMetric).not.toHaveBeenCalled();

    (config as any).server.mcpSecret = "";
  });

  it("/api/metrics accepts valid bearer token when secret is set", async () => {
    mockUpsertDailyMetric.mockResolvedValue(undefined);
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const metricsCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/metrics"
    );
    const metricsHandler = metricsCall![1];

    const mockReq = {
      headers: { authorization: "Bearer test-secret" },
      body: { date: "2026-02-21", weight_kg: 82.3 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await metricsHandler(mockReq, mockRes);

    expect(mockUpsertDailyMetric).toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok" })
    );

    (config as any).server.mcpSecret = "";
  });

  it("/api/metrics returns 500 on database error", async () => {
    mockUpsertDailyMetric.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const metricsCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/metrics"
    );
    const metricsHandler = metricsCall![1];

    const mockReq = {
      headers: {},
      body: { date: "2026-02-21", weight_kg: 82.3 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await metricsHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("registers /api/activity endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity"
    );
    expect(activityCall).toBeTruthy();
  });

  it("registers /api/activity/:id endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity/:id"
    );
    expect(activityCall).toBeTruthy();
  });

  it("/api/activity returns recent logs", async () => {
    const mockLogs = [
      { id: 1, chat_id: "100", memories: [], tool_calls: [], cost_usd: null, created_at: new Date() },
    ];
    mockGetRecentActivityLogs.mockResolvedValue(mockLogs);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetRecentActivityLogs).toHaveBeenCalledWith(mockPool, {
      toolName: undefined,
      since: undefined,
      limit: 20,
    });
    expect(mockRes.json).toHaveBeenCalledWith(mockLogs);
  });

  it("/api/activity passes query filters", async () => {
    mockGetRecentActivityLogs.mockResolvedValue([]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity"
    );
    const handler = activityCall![1];

    const mockReq = {
      headers: {},
      query: { tool: "search_entries", limit: "5", since: "2026-02-20" },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetRecentActivityLogs).toHaveBeenCalledWith(mockPool, {
      toolName: "search_entries",
      since: new Date("2026-02-20"),
      limit: 5,
    });
  });

  it("/api/activity rejects unauthorized when secret is set", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockGetRecentActivityLogs).not.toHaveBeenCalled();

    (config as any).server.mcpSecret = "";
  });

  it("/api/activity rejects wrong bearer token", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity"
    );
    const handler = activityCall![1];

    const mockReq = { headers: { authorization: "Bearer wrong-token" }, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("/api/activity defaults limit for NaN input", async () => {
    mockGetRecentActivityLogs.mockResolvedValue([]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, query: { limit: "abc" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetRecentActivityLogs).toHaveBeenCalledWith(mockPool, {
      toolName: undefined,
      since: undefined,
      limit: 20,
    });
  });

  it("/api/activity returns 500 on database error", async () => {
    mockGetRecentActivityLogs.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("/api/activity/:id returns a single log", async () => {
    const mockLog = {
      id: 42,
      chat_id: "100",
      memories: [{ id: 1, content: "test", kind: "fact", confidence: 0.8, score: 0.5 }],
      tool_calls: [{ name: "search_entries", args: { query: "test" }, result: "full", truncated_result: "trun" }],
      cost_usd: 0.05,
      created_at: new Date(),
    };
    mockGetActivityLog.mockResolvedValue(mockLog);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity/:id"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, params: { id: "42" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetActivityLog).toHaveBeenCalledWith(mockPool, 42);
    expect(mockRes.json).toHaveBeenCalledWith(mockLog);
  });

  it("/api/activity/:id returns 404 when not found", async () => {
    mockGetActivityLog.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity/:id"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, params: { id: "999" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("/api/activity/:id returns 400 for invalid ID", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity/:id"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, params: { id: "not-a-number" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/activity/:id rejects unauthorized when secret is set", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity/:id"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, params: { id: "42" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockGetActivityLog).not.toHaveBeenCalled();

    (config as any).server.mcpSecret = "";
  });

  it("/api/activity/:id rejects wrong bearer token", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity/:id"
    );
    const handler = activityCall![1];

    const mockReq = { headers: { authorization: "Bearer wrong-token" }, params: { id: "42" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("/api/activity/:id returns 500 on database error", async () => {
    mockGetActivityLog.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity/:id"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, params: { id: "42" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("CORS middleware returns 204 for OPTIONS requests", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const corsCall = mockApp.use.mock.calls.find(
      (c: any[]) => typeof c[0] === "function"
    );
    const corsMiddleware = corsCall![0];

    const mockReq = { method: "OPTIONS" };
    const mockRes = { header: vi.fn(), sendStatus: vi.fn() };
    const mockNext = vi.fn();

    corsMiddleware(mockReq, mockRes, mockNext);

    expect(mockRes.sendStatus).toHaveBeenCalledWith(204);
    expect(mockNext).not.toHaveBeenCalled();
  });
});
