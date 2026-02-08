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
  return { default: fn };
});

vi.mock("../../src/config.js", () => ({
  config: {
    server: { port: 3000, mcpSecret: "" },
  },
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
    await startHttpServer({ connect: vi.fn() } as any);

    expect(mockApp.listen).toHaveBeenCalledWith(
      3000,
      "0.0.0.0",
      expect.any(Function)
    );
  });

  it("sets trust proxy", async () => {
    await startHttpServer({ connect: vi.fn() } as any);
    expect(mockApp.set).toHaveBeenCalledWith("trust proxy", 1);
  });

  it("registers json middleware", async () => {
    await startHttpServer({ connect: vi.fn() } as any);
    expect(mockApp.use).toHaveBeenCalled();
  });

  it("registers health endpoint", async () => {
    await startHttpServer({ connect: vi.fn() } as any);
    expect(mockApp.get).toHaveBeenCalledWith("/health", expect.any(Function));
  });

  it("health endpoint returns status ok", async () => {
    await startHttpServer({ connect: vi.fn() } as any);

    const healthCall = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/health"
    );
    const healthHandler = healthCall![1];
    const mockRes = { json: vi.fn() };
    healthHandler({}, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith({ status: "ok" });
  });

  it("registers MCP endpoint", async () => {
    await startHttpServer({ connect: vi.fn() } as any);
    expect(mockApp.post).toHaveBeenCalledWith("/mcp", expect.any(Function));
  });

  it("MCP endpoint creates transport and handles request", async () => {
    const mockConnect = vi.fn();
    await startHttpServer({ connect: mockConnect } as any);

    const mcpCall = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/mcp"
    );
    const mcpHandler = mcpCall![1];
    const mockReq = { body: { test: true } };
    const mockRes = {};

    await mcpHandler(mockReq, mockRes);

    expect(mockConnect).toHaveBeenCalled();
    expect(mockHandleRequest).toHaveBeenCalledWith(
      mockReq,
      mockRes,
      mockReq.body
    );
  });

  it("CORS middleware sets headers for non-OPTIONS requests", async () => {
    await startHttpServer({ connect: vi.fn() } as any);

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

  it("CORS middleware returns 204 for OPTIONS requests", async () => {
    await startHttpServer({ connect: vi.fn() } as any);

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
