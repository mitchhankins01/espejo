import { describe, it, expect, vi, beforeEach } from "vitest";

const mockServer = { on: vi.fn() };

const mockApp = {
  set: vi.fn().mockReturnThis(),
  use: vi.fn().mockReturnThis(),
  get: vi.fn().mockReturnThis(),
  post: vi.fn().mockReturnThis(),
  put: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  listen: vi.fn().mockImplementation(
    (_port: number, _host: string, cb: () => void) => {
      cb();
      return mockServer;
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
    onThisDay: { enabled: false, targetHour: 8 },
    r2: { accountId: "", accessKeyId: "", secretAccessKey: "", bucketName: "", publicUrl: "" },
  },
}));

vi.mock("../../src/transports/oauth.js", () => ({
  registerOAuthRoutes: vi.fn(),
  isValidOAuthToken: vi.fn(() => false),
}));

vi.mock("../../src/oura/sync.js", () => ({
  startOuraSyncTimer: vi.fn(),
}));

vi.mock("../../src/obsidian/sync.js", () => ({
  startObsidianSyncTimer: vi.fn(),
}));

vi.mock("../../src/notifications/on-this-day.js", () => ({
  startOnThisDayTimer: vi.fn(),
}));

vi.mock("../../src/db/embed-pending.js", () => ({
  embedPending: vi.fn().mockResolvedValue({ entries: 0, artifacts: 0, skipped: [] }),
}));

vi.mock("../../src/telegram/notify.js", () => ({
  notifyError: vi.fn(),
}));

vi.mock("../../src/telegram/client.js", () => ({
  sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
}));

const { mockPool, mockLogUsage } = vi.hoisted(() => ({
  mockPool: {},
  mockLogUsage: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  pool: mockPool,
}));

vi.mock("../../src/db/queries/usage.js", () => ({
  logUsage: mockLogUsage,
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
    mockLogUsage.mockReset();
    mockServer.on.mockReset();
    mockApp.set.mockReturnThis();
    mockApp.use.mockReturnThis();
    mockApp.get.mockReturnThis();
    mockApp.post.mockReturnThis();
    mockApp.put.mockReturnThis();
    mockApp.delete.mockReturnThis();
    mockApp.listen.mockImplementation(
      (_port: number, _host: string, cb: () => void) => {
        cb();
        return mockServer;
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
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    expect(mockRes.header).toHaveBeenCalledWith(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    expect(mockNext).toHaveBeenCalled();
  });

  it("CORS middleware short-circuits OPTIONS preflight", async () => {
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

  it("usage middleware skips /health", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const useCalls = mockApp.use.mock.calls.filter(
      (c: any[]) => typeof c[0] === "function"
    );
    // Two function-only middlewares: CORS first, usage second
    const usageMiddleware = useCalls[1]![0];

    const mockReq = { path: "/health", method: "GET", headers: {}, query: {} };
    const mockRes = { on: vi.fn() };
    const mockNext = vi.fn();
    usageMiddleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.on).not.toHaveBeenCalled();
    expect(mockLogUsage).not.toHaveBeenCalled();
  });

  it("usage middleware logs an MCP request as mcp-http surface", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const useCalls = mockApp.use.mock.calls.filter(
      (c: any[]) => typeof c[0] === "function"
    );
    const usageMiddleware = useCalls[1]![0];

    const finishHandlers: Array<() => void> = [];
    const mockReq = {
      path: "/mcp",
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.1" },
      query: {},
    };
    const mockRes = {
      statusCode: 200,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") finishHandlers.push(cb);
      }),
    };
    const mockNext = vi.fn();
    usageMiddleware(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();

    // Trigger the finish callback to run logUsage
    finishHandlers.forEach((cb) => cb());

    expect(mockLogUsage).toHaveBeenCalledTimes(1);
    const [, payload] = mockLogUsage.mock.calls[0];
    expect(payload.source).toBe("http");
    expect(payload.surface).toBe("mcp-http");
    expect(payload.actor).toBe("203.0.113.4");
    expect(payload.action).toBe("POST /mcp");
    expect(payload.ok).toBe(true);
    expect(payload.meta.status).toBe(200);
  });

  it("usage middleware tags telegram webhook + records 5xx as not ok", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const useCalls = mockApp.use.mock.calls.filter(
      (c: any[]) => typeof c[0] === "function"
    );
    const usageMiddleware = useCalls[1]![0];

    const finishHandlers: Array<() => void> = [];
    const mockReq = {
      path: "/api/telegram",
      method: "POST",
      headers: {},
      ip: "10.0.0.5",
      query: {},
    };
    const mockRes = {
      statusCode: 500,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") finishHandlers.push(cb);
      }),
    };
    usageMiddleware(mockReq, mockRes, vi.fn());
    finishHandlers.forEach((cb) => cb());

    const [, payload] = mockLogUsage.mock.calls[0];
    expect(payload.surface).toBe("webhook");
    expect(payload.actor).toBe("10.0.0.5");
    expect(payload.ok).toBe(false);
    expect(payload.meta.status).toBe(500);
  });

  it("usage middleware tags other paths as rest surface", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const useCalls = mockApp.use.mock.calls.filter(
      (c: any[]) => typeof c[0] === "function"
    );
    const usageMiddleware = useCalls[1]![0];

    const finishHandlers: Array<() => void> = [];
    const mockReq = {
      path: "/oauth/authorize",
      method: "GET",
      headers: {},
      query: { client_id: "abc" },
    };
    const mockRes = {
      statusCode: 302,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") finishHandlers.push(cb);
      }),
    };
    usageMiddleware(mockReq, mockRes, vi.fn());
    finishHandlers.forEach((cb) => cb());

    const [, payload] = mockLogUsage.mock.calls[0];
    expect(payload.surface).toBe("rest");
    expect(payload.meta.query).toEqual({ client_id: "abc" });
  });
});
