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
  },
}));

vi.mock("../../src/transports/oauth.js", () => ({
  registerOAuthRoutes: vi.fn(),
  isValidOAuthToken: vi.fn(() => false),
}));

const { mockPool, mockUpsertDailyMetric } = vi.hoisted(() => ({
  mockPool: {},
  mockUpsertDailyMetric: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  pool: mockPool,
}));

vi.mock("../../src/db/queries.js", () => ({
  upsertDailyMetric: mockUpsertDailyMetric,
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
