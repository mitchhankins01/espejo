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
    oura: { accessToken: "" },
  },
}));

vi.mock("../../src/transports/oauth.js", () => ({
  registerOAuthRoutes: vi.fn(),
  isValidOAuthToken: vi.fn(() => false),
}));

const {
  mockPool,
  mockUpsertDailyMetric,
  mockGetActivityLog,
  mockGetRecentActivityLogs,
  mockGetRetentionByInterval,
  mockGetVocabularyFunnel,
  mockGetGradeTrend,
  mockGetLapseRateTrend,
  mockGetProgressTimeSeries,
  mockGetRetentionByContext,
  mockGetSpanishQuizStats,
  mockGetSpanishAdaptiveContext,
  mockGetSpanishAssessments,
  mockGetLatestSpanishAssessment,
} = vi.hoisted(() => ({
  mockPool: {},
  mockUpsertDailyMetric: vi.fn(),
  mockGetActivityLog: vi.fn(),
  mockGetRecentActivityLogs: vi.fn(),
  mockGetRetentionByInterval: vi.fn(),
  mockGetVocabularyFunnel: vi.fn(),
  mockGetGradeTrend: vi.fn(),
  mockGetLapseRateTrend: vi.fn(),
  mockGetProgressTimeSeries: vi.fn(),
  mockGetRetentionByContext: vi.fn(),
  mockGetSpanishQuizStats: vi.fn(),
  mockGetSpanishAdaptiveContext: vi.fn(),
  mockGetSpanishAssessments: vi.fn(),
  mockGetLatestSpanishAssessment: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  pool: mockPool,
}));

vi.mock("../../src/db/queries.js", () => ({
  upsertDailyMetric: mockUpsertDailyMetric,
  getActivityLog: mockGetActivityLog,
  getRecentActivityLogs: mockGetRecentActivityLogs,
  getRetentionByInterval: mockGetRetentionByInterval,
  getVocabularyFunnel: mockGetVocabularyFunnel,
  getGradeTrend: mockGetGradeTrend,
  getLapseRateTrend: mockGetLapseRateTrend,
  getProgressTimeSeries: mockGetProgressTimeSeries,
  getRetentionByContext: mockGetRetentionByContext,
  getSpanishQuizStats: mockGetSpanishQuizStats,
  getSpanishAdaptiveContext: mockGetSpanishAdaptiveContext,
  getSpanishAssessments: mockGetSpanishAssessments,
  getLatestSpanishAssessment: mockGetLatestSpanishAssessment,
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
    mockGetRetentionByInterval.mockReset();
    mockGetVocabularyFunnel.mockReset();
    mockGetGradeTrend.mockReset();
    mockGetLapseRateTrend.mockReset();
    mockGetProgressTimeSeries.mockReset();
    mockGetRetentionByContext.mockReset();
    mockGetSpanishQuizStats.mockReset();
    mockGetSpanishAdaptiveContext.mockReset();
    mockGetSpanishAssessments.mockReset();
    mockGetLatestSpanishAssessment.mockReset();
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

    const mockReq = { headers: {}, params: { id: "42" }, query: {} };
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

    const mockReq = { headers: { authorization: "Bearer wrong-token" }, params: { id: "42" }, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("/api/activity/:id accepts valid query token when secret is set", async () => {
    const mockLog = { id: 42, chat_id: "100", memories: [], tool_calls: [], cost_usd: null, created_at: new Date() };
    mockGetActivityLog.mockResolvedValue(mockLog);
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity/:id"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, params: { id: "42" }, query: { token: "test-secret" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetActivityLog).toHaveBeenCalledWith(mockPool, 42);
    expect(mockRes.json).toHaveBeenCalledWith(mockLog);

    (config as any).server.mcpSecret = "";
  });

  it("/api/activity/:id rejects wrong query token", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const activityCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/activity/:id"
    );
    const handler = activityCall![1];

    const mockReq = { headers: {}, params: { id: "42" }, query: { token: "wrong-token" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockGetActivityLog).not.toHaveBeenCalled();

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

  // =========================================================================
  // Spanish analytics endpoints
  // =========================================================================

  it("registers /api/spanish/:chatId/dashboard endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const dashboardCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/dashboard"
    );
    expect(dashboardCall).toBeTruthy();
  });

  it("/api/spanish/:chatId/dashboard returns aggregated data", async () => {
    const mockStats = { total_words: 50, due_now: 3, new_words: 10, learning_words: 15, review_words: 20, relearning_words: 5, reviews_today: 4, average_grade: 3.2 };
    const mockAdaptive = { recent_avg_grade: 3.0, recent_lapse_rate: 0.1, avg_difficulty: 4.0, total_reviews: 100, mastered_count: 10, struggling_count: 2 };
    mockGetSpanishQuizStats.mockResolvedValue(mockStats);
    mockGetSpanishAdaptiveContext.mockResolvedValue(mockAdaptive);
    mockGetRetentionByInterval.mockResolvedValue([]);
    mockGetVocabularyFunnel.mockResolvedValue([]);
    mockGetGradeTrend.mockResolvedValue([]);
    mockGetLapseRateTrend.mockResolvedValue([]);
    mockGetProgressTimeSeries.mockResolvedValue([]);
    mockGetRetentionByContext.mockResolvedValue([]);
    mockGetLatestSpanishAssessment.mockResolvedValue(null);

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const dashboardCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/dashboard"
    );
    const handler = dashboardCall![1];

    const mockReq = { params: { chatId: "100" }, headers: {}, query: { days: "30" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: mockStats,
        adaptive: mockAdaptive,
        retention: [],
        funnel: [],
        grade_trend: [],
        lapse_trend: [],
        progress: [],
        context_retention: [],
        latest_assessment: null,
      })
    );
  });

  it("/api/spanish/:chatId/dashboard rejects unauthorized when secret is set", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const dashboardCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/dashboard"
    );
    const handler = dashboardCall![1];

    const mockReq = { params: { chatId: "100" }, headers: { authorization: "Bearer wrong-token" }, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("/api/spanish/:chatId/dashboard defaults to 90 days for NaN input", async () => {
    mockGetSpanishQuizStats.mockResolvedValue({ total_words: 0, due_now: 0, new_words: 0, learning_words: 0, review_words: 0, relearning_words: 0, reviews_today: 0, average_grade: 0 });
    mockGetSpanishAdaptiveContext.mockResolvedValue({ recent_avg_grade: 0, recent_lapse_rate: 0, avg_difficulty: 0, total_reviews: 0, mastered_count: 0, struggling_count: 0 });
    mockGetRetentionByInterval.mockResolvedValue([]);
    mockGetVocabularyFunnel.mockResolvedValue([]);
    mockGetGradeTrend.mockResolvedValue([]);
    mockGetLapseRateTrend.mockResolvedValue([]);
    mockGetProgressTimeSeries.mockResolvedValue([]);
    mockGetRetentionByContext.mockResolvedValue([]);
    mockGetLatestSpanishAssessment.mockResolvedValue(null);

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const dashboardCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/dashboard"
    );
    const handler = dashboardCall![1];

    const mockReq = { params: { chatId: "100" }, headers: {}, query: { days: "abc" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetGradeTrend).toHaveBeenCalledWith(mockPool, "100", 90);
  });

  it("/api/spanish/:chatId/dashboard returns 500 on error", async () => {
    mockGetSpanishQuizStats.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const dashboardCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/dashboard"
    );
    const handler = dashboardCall![1];

    const mockReq = { params: { chatId: "100" }, headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("/api/spanish/:chatId/assessments rejects unauthorized when secret is set", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const assessCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/assessments"
    );
    const handler = assessCall![1];

    const mockReq = { params: { chatId: "100" }, headers: { authorization: "Bearer wrong-token" }, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("registers /api/spanish/:chatId/assessments endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const assessCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/assessments"
    );
    expect(assessCall).toBeTruthy();
  });

  it("/api/spanish/:chatId/assessments returns assessment list", async () => {
    const mockAssessments = [
      { id: 1, chat_id: "100", overall_score: 3.6, assessed_at: new Date() },
    ];
    mockGetSpanishAssessments.mockResolvedValue(mockAssessments);

    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const assessCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/assessments"
    );
    const handler = assessCall![1];

    const mockReq = { params: { chatId: "100" }, headers: {}, query: { days: "90" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetSpanishAssessments).toHaveBeenCalledWith(mockPool, "100", 90);
    expect(mockRes.json).toHaveBeenCalledWith(mockAssessments);
  });

  it("/api/spanish/:chatId/assessments defaults to 90 days", async () => {
    mockGetSpanishAssessments.mockResolvedValue([]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const assessCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/assessments"
    );
    const handler = assessCall![1];

    const mockReq = { params: { chatId: "100" }, headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetSpanishAssessments).toHaveBeenCalledWith(mockPool, "100", 90);
  });

  it("/api/spanish/:chatId/assessments defaults to 90 days for NaN input", async () => {
    mockGetSpanishAssessments.mockResolvedValue([]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const assessCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/assessments"
    );
    const handler = assessCall![1];

    const mockReq = { params: { chatId: "100" }, headers: {}, query: { days: "abc" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetSpanishAssessments).toHaveBeenCalledWith(mockPool, "100", 90);
  });

  it("/api/spanish/:chatId/assessments returns 500 on error", async () => {
    mockGetSpanishAssessments.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const assessCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/spanish/:chatId/assessments"
    );
    const handler = assessCall![1];

    const mockReq = { params: { chatId: "100" }, headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
  });
});
