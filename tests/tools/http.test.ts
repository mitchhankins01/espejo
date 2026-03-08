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
  (fn as any).static = vi.fn(() => "static-middleware");
  return { default: fn };
});

vi.mock("../../src/config.js", () => ({
  config: {
    server: { port: 3000, mcpSecret: "", oauthClientId: "", oauthClientSecret: "" },
    telegram: { botToken: "", secretToken: "", allowedChatId: "" },
    oura: { accessToken: "" },
    checkins: { enabled: false, intervalMinutes: 15, ignoreThreshold: 3 },
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

vi.mock("multer", () => {
  const multerFn = vi.fn(() => ({
    single: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  }));
  (multerFn as any).memoryStorage = vi.fn();
  (multerFn as any).MulterError = class MulterError extends Error {};
  return { default: multerFn };
});

vi.mock("../../src/storage/r2.js", () => ({
  createClient: vi.fn(),
  uploadMediaBuffer: vi.fn().mockResolvedValue("https://r2.example.com/test.jpg"),
  deleteMediaObject: vi.fn().mockResolvedValue(undefined),
  getPublicUrl: vi.fn((key: string) => `https://r2.example.com/${key}`),
}));

vi.mock("../../src/checkins/scheduler.js", () => ({
  startCheckinTimer: vi.fn(),
}));

vi.mock("../../src/telegram/notify.js", () => ({
  notifyError: vi.fn(),
}));

const {
  mockPool,
  mockUpsertDailyMetric,
  mockUpsertWeight,
  mockDeleteWeight,
  mockListWeights,
  mockGetWeightPatterns,
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
  mockCreateArtifact,
  mockUpdateArtifact,
  mockDeleteArtifact,
  mockGetArtifactById,
  mockListArtifacts,
  mockCountArtifacts,
  mockSearchArtifacts,
  mockSearchArtifactsKeyword,
  mockListArtifactTags,
  mockListArtifactTitles,
  mockResolveArtifactTitleToId,
  mockSyncExplicitLinks,
  mockFindSimilarArtifacts,
  mockGetExplicitLinks,
  mockGetExplicitBacklinks,
  mockGetArtifactGraph,
  mockSearchContent,
  mockSearchEntriesForPicker,
  mockListTodos,
  mockGetTodoById,
  mockCreateTodo,
  mockUpdateTodo,
  mockDeleteTodo,
  mockCompleteTodo,
  mockSetTodoFocus,
  mockGetFocusTodo,
  mockGenerateEmbedding,
  mockUpsertUserSettings,
  mockListObservableTables,
  mockListObservableTableRows,
  mockListRecentDbChanges,
  mockIsObservableDbTableName,
  mockCreateEntry,
  mockUpdateEntry,
  mockDeleteEntry,
  mockListEntries,
  mockGetEntryByUuid,
  mockGetEntryIdByUuid,
  mockInsertMedia,
  mockDeleteMediaRow,
  mockListTemplates,
  mockGetTemplateById,
  mockCreateTemplate,
  mockUpdateTemplate,
  mockDeleteTemplate,
  mockUpdateEntryEmbeddingIfVersionMatches,
} = vi.hoisted(() => ({
  mockPool: {},
  mockUpsertDailyMetric: vi.fn(),
  mockUpsertWeight: vi.fn(),
  mockDeleteWeight: vi.fn(),
  mockListWeights: vi.fn(),
  mockGetWeightPatterns: vi.fn(),
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
  mockCreateArtifact: vi.fn(),
  mockUpdateArtifact: vi.fn(),
  mockDeleteArtifact: vi.fn(),
  mockGetArtifactById: vi.fn(),
  mockListArtifacts: vi.fn(),
  mockCountArtifacts: vi.fn(),
  mockSearchArtifacts: vi.fn(),
  mockSearchArtifactsKeyword: vi.fn(),
  mockListArtifactTags: vi.fn(),
  mockListArtifactTitles: vi.fn(),
  mockResolveArtifactTitleToId: vi.fn(),
  mockSyncExplicitLinks: vi.fn(),
  mockFindSimilarArtifacts: vi.fn(),
  mockGetExplicitLinks: vi.fn(),
  mockGetExplicitBacklinks: vi.fn(),
  mockGetArtifactGraph: vi.fn(),
  mockSearchContent: vi.fn(),
  mockSearchEntriesForPicker: vi.fn(),
  mockListTodos: vi.fn(),
  mockGetTodoById: vi.fn(),
  mockCreateTodo: vi.fn(),
  mockUpdateTodo: vi.fn(),
  mockDeleteTodo: vi.fn(),
  mockCompleteTodo: vi.fn(),
  mockSetTodoFocus: vi.fn(),
  mockGetFocusTodo: vi.fn(),
  mockGenerateEmbedding: vi.fn(),
  mockUpsertUserSettings: vi.fn(),
  mockListObservableTables: vi.fn(),
  mockListObservableTableRows: vi.fn(),
  mockListRecentDbChanges: vi.fn(),
  mockIsObservableDbTableName: vi.fn(),
  mockCreateEntry: vi.fn(),
  mockUpdateEntry: vi.fn(),
  mockDeleteEntry: vi.fn(),
  mockListEntries: vi.fn(),
  mockGetEntryByUuid: vi.fn(),
  mockGetEntryIdByUuid: vi.fn(),
  mockInsertMedia: vi.fn(),
  mockDeleteMediaRow: vi.fn(),
  mockListTemplates: vi.fn(),
  mockGetTemplateById: vi.fn(),
  mockCreateTemplate: vi.fn(),
  mockUpdateTemplate: vi.fn(),
  mockDeleteTemplate: vi.fn(),
  mockUpdateEntryEmbeddingIfVersionMatches: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  pool: mockPool,
}));

vi.mock("../../src/db/embeddings.js", () => ({
  generateEmbedding: mockGenerateEmbedding,
}));

vi.mock("../../src/db/queries.js", () => ({
  upsertDailyMetric: mockUpsertDailyMetric,
  upsertWeight: mockUpsertWeight,
  deleteWeight: mockDeleteWeight,
  listWeights: mockListWeights,
  getWeightPatterns: mockGetWeightPatterns,
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
  createArtifact: mockCreateArtifact,
  updateArtifact: mockUpdateArtifact,
  deleteArtifact: mockDeleteArtifact,
  getArtifactById: mockGetArtifactById,
  listArtifacts: mockListArtifacts,
  countArtifacts: mockCountArtifacts,
  searchArtifacts: mockSearchArtifacts,
  searchArtifactsKeyword: mockSearchArtifactsKeyword,
  listArtifactTags: mockListArtifactTags,
  listArtifactTitles: mockListArtifactTitles,
  resolveArtifactTitleToId: mockResolveArtifactTitleToId,
  syncExplicitLinks: mockSyncExplicitLinks,
  findSimilarArtifacts: mockFindSimilarArtifacts,
  getExplicitLinks: mockGetExplicitLinks,
  getExplicitBacklinks: mockGetExplicitBacklinks,
  getArtifactGraph: mockGetArtifactGraph,
  searchContent: mockSearchContent,
  searchEntriesForPicker: mockSearchEntriesForPicker,
  listTodos: mockListTodos,
  getTodoById: mockGetTodoById,
  createTodo: mockCreateTodo,
  updateTodo: mockUpdateTodo,
  deleteTodo: mockDeleteTodo,
  completeTodo: mockCompleteTodo,
  setTodoFocus: mockSetTodoFocus,
  getFocusTodo: mockGetFocusTodo,
  upsertUserSettings: mockUpsertUserSettings,
  listObservableTables: mockListObservableTables,
  listObservableTableRows: mockListObservableTableRows,
  listRecentDbChanges: mockListRecentDbChanges,
  isObservableDbTableName: mockIsObservableDbTableName,
  createEntry: mockCreateEntry,
  updateEntry: mockUpdateEntry,
  deleteEntry: mockDeleteEntry,
  listEntries: mockListEntries,
  getEntryByUuid: mockGetEntryByUuid,
  getEntryIdByUuid: mockGetEntryIdByUuid,
  insertMedia: mockInsertMedia,
  deleteMedia: mockDeleteMediaRow,
  listTemplates: mockListTemplates,
  getTemplateById: mockGetTemplateById,
  createTemplate: mockCreateTemplate,
  updateTemplate: mockUpdateTemplate,
  deleteTemplate: mockDeleteTemplate,
  updateEntryEmbeddingIfVersionMatches: mockUpdateEntryEmbeddingIfVersionMatches,
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
    mockUpsertWeight.mockReset();
    mockDeleteWeight.mockReset();
    mockListWeights.mockReset();
    mockGetWeightPatterns.mockReset();
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
    mockListArtifactTitles.mockReset();
    mockResolveArtifactTitleToId.mockReset();
    mockSyncExplicitLinks.mockReset();
    mockFindSimilarArtifacts.mockReset();
    mockGetExplicitLinks.mockReset();
    mockGetExplicitBacklinks.mockReset();
    mockGetArtifactGraph.mockReset();
    mockSearchArtifactsKeyword.mockReset();
    mockListTodos.mockReset();
    mockGetTodoById.mockReset();
    mockCreateTodo.mockReset();
    mockUpdateTodo.mockReset();
    mockDeleteTodo.mockReset();
    mockCompleteTodo.mockReset();
    mockSetTodoFocus.mockReset();
    mockGetFocusTodo.mockReset();
    mockUpsertUserSettings.mockReset();
    mockListObservableTables.mockReset();
    mockListObservableTableRows.mockReset();
    mockListRecentDbChanges.mockReset();
    mockIsObservableDbTableName.mockReset();
    mockIsObservableDbTableName.mockImplementation(
      (table: string) =>
        table === "todos" ||
        table === "activity_logs" ||
        table === "knowledge_artifacts"
    );
    mockServer.on.mockReset();
    // Restore mock implementations after clearAllMocks
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
      "GET, POST, PUT, DELETE, OPTIONS"
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

  it("registers /api/weights endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights");
    expect(call).toBeTruthy();
  });

  it("/api/weights returns list data", async () => {
    mockListWeights.mockResolvedValue({
      rows: [{ date: new Date("2026-02-21"), weight_kg: 82.3, created_at: new Date("2026-02-21") }],
      count: 1,
    });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights");
    const handler = call![1];
    const mockReq = {
      headers: {},
      query: { from: "2026-02-01", to: "2026-02-28", limit: "50", offset: "10" },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockListWeights).toHaveBeenCalledWith(mockPool, {
      from: "2026-02-01",
      to: "2026-02-28",
      limit: 50,
      offset: 10,
    });
    expect(mockRes.json).toHaveBeenCalledWith({
      items: expect.any(Array),
      total: 1,
    });
  });

  it("/api/weights falls back to default pagination for invalid values", async () => {
    mockListWeights.mockResolvedValue({ rows: [], count: 0 });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights");
    const handler = call![1];
    const mockReq = { headers: {}, query: { limit: "NaN", offset: "NaN" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockListWeights).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        limit: 100,
        offset: 0,
      })
    );
  });

  it("/api/weights validates from date", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights");
    const handler = call![1];
    const mockReq = { headers: {}, query: { from: "bad-date" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/weights validates to date", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights");
    const handler = call![1];
    const mockReq = { headers: {}, query: { to: "bad-date" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/weights returns 500 on query failure", async () => {
    mockListWeights.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights");
    const handler = call![1];
    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("/api/weights rejects unauthorized requests", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights");
    const handler = call![1];
    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("registers /api/weights/patterns endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights/patterns");
    expect(call).toBeTruthy();
  });

  it("/api/weights/patterns returns aggregate metrics", async () => {
    mockGetWeightPatterns.mockResolvedValue({
      latest: { date: new Date("2026-02-21"), weight_kg: 82.3, created_at: new Date("2026-02-21") },
      delta_7d: -0.2,
      delta_30d: -1.1,
      weekly_pace_kg: -0.25,
      consistency: 0.8,
      streak_days: 4,
      volatility_14d: 0.18,
      plateau: false,
      range_days: 30,
      logged_days: 24,
    });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights/patterns");
    const handler = call![1];
    const mockReq = { headers: {}, query: { from: "2026-02-01", to: "2026-02-21" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGetWeightPatterns).toHaveBeenCalledWith(mockPool, {
      from: "2026-02-01",
      to: "2026-02-21",
    });
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        latest: { date: "2026-02-21", weight_kg: 82.3 },
        delta_30d: -1.1,
      })
    );
  });

  it("/api/weights/patterns returns latest: null when no data exists", async () => {
    mockGetWeightPatterns.mockResolvedValue({
      latest: null,
      delta_7d: null,
      delta_30d: null,
      weekly_pace_kg: null,
      consistency: null,
      streak_days: 0,
      volatility_14d: null,
      plateau: false,
      range_days: 0,
      logged_days: 0,
    });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights/patterns");
    const handler = call![1];
    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        latest: null,
        logged_days: 0,
      })
    );
  });

  it("/api/weights/patterns validates from date", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights/patterns");
    const handler = call![1];
    const mockReq = { headers: {}, query: { from: "bad-date" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/weights/patterns validates to date", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights/patterns");
    const handler = call![1];
    const mockReq = { headers: {}, query: { to: "bad-date" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/weights/patterns returns 500 on query failure", async () => {
    mockGetWeightPatterns.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights/patterns");
    const handler = call![1];
    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("/api/weights/patterns rejects unauthorized requests", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/weights/patterns");
    const handler = call![1];
    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("registers /api/weights/:date PUT endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    expect(call).toBeTruthy();
  });

  it("/api/weights/:date upserts a weight value", async () => {
    mockUpsertWeight.mockResolvedValue({
      date: new Date("2026-02-21"),
      weight_kg: 82.3,
      created_at: new Date("2026-02-21"),
    });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = {
      headers: {},
      params: { date: "2026-02-21" },
      body: { weight_kg: 82.3 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockUpsertWeight).toHaveBeenCalledWith(mockPool, "2026-02-21", 82.3);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ weight_kg: 82.3 })
    );
  });

  it("/api/weights/:date PUT validates date", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = { headers: {}, params: { date: "bad-date" }, body: { weight_kg: 82.3 } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/weights/:date PUT validates body", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = { headers: {}, params: { date: "2026-02-21" }, body: { weight_kg: 0 } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/weights/:date PUT returns 500 on failure", async () => {
    mockUpsertWeight.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = { headers: {}, params: { date: "2026-02-21" }, body: { weight_kg: 82.3 } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("/api/weights/:date PUT rejects unauthorized requests", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = { headers: {}, params: { date: "2026-02-21" }, body: { weight_kg: 82.3 } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("registers /api/weights/:date DELETE endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    expect(call).toBeTruthy();
  });

  it("/api/weights/:date DELETE removes a measurement", async () => {
    mockDeleteWeight.mockResolvedValue(true);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = { headers: {}, params: { date: "2026-02-21" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockDeleteWeight).toHaveBeenCalledWith(mockPool, "2026-02-21");
    expect(mockRes.json).toHaveBeenCalledWith({ status: "deleted" });
  });

  it("/api/weights/:date DELETE returns 404 when missing", async () => {
    mockDeleteWeight.mockResolvedValue(false);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = { headers: {}, params: { date: "2026-02-21" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("/api/weights/:date DELETE validates date", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = { headers: {}, params: { date: "bad-date" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/weights/:date DELETE returns 500 on failure", async () => {
    mockDeleteWeight.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = { headers: {}, params: { date: "2026-02-21" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("/api/weights/:date DELETE rejects unauthorized requests", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/weights/:date");
    const handler = call![1];
    const mockReq = { headers: {}, params: { date: "2026-02-21" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
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
  // DB observability endpoints
  // =========================================================================

  it("registers /api/db/tables endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/db/tables");
    expect(call).toBeTruthy();
  });

  it("/api/db/tables returns metadata", async () => {
    const rows = [
      {
        name: "todos",
        row_count: 2,
        last_changed_at: new Date("2026-03-01T12:00:00Z"),
        default_sort_column: "updated_at",
      },
    ];
    mockListObservableTables.mockResolvedValue(rows);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/db/tables");
    const handler = call![1];
    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockListObservableTables).toHaveBeenCalledWith(mockPool);
    expect(mockRes.json).toHaveBeenCalledWith(rows);
  });

  it("/api/db/tables rejects unauthorized requests", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/db/tables");
    const handler = call![1];
    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockListObservableTables).not.toHaveBeenCalled();
    (config as any).server.mcpSecret = "";
  });

  it("/api/db/tables returns 500 on query failure", async () => {
    mockListObservableTables.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/db/tables");
    const handler = call![1];
    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("/api/db/tables/:table/rows validates table allowlist", async () => {
    mockIsObservableDbTableName.mockReturnValue(false);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/db/tables/:table/rows"
    );
    const handler = call![1];
    const mockReq = { headers: {}, params: { table: "bad_table" }, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockListObservableTableRows).not.toHaveBeenCalled();
  });

  it("/api/db/tables/:table/rows validates timestamp and order params", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/db/tables/:table/rows"
    );
    const handler = call![1];

    const badFromReq = {
      headers: {},
      params: { table: "todos" },
      query: { from: "2026-03-01" },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(badFromReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);

    const badOrderReq = {
      headers: {},
      params: { table: "todos" },
      query: { order: "sideways" },
    };
    await handler(badOrderReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/db/tables/:table/rows returns row data", async () => {
    mockListObservableTableRows.mockResolvedValue({
      items: [{ id: "todo-1", title: "Write tests" }],
      total: 1,
      columns: [{ name: "id", type: "uuid", hidden: false }],
    });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/db/tables/:table/rows"
    );
    const handler = call![1];
    const mockReq = {
      headers: {},
      params: { table: "todos" },
      query: {
        limit: "25",
        offset: "10",
        sort: "updated_at",
        order: "asc",
        q: "write",
      },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockListObservableTableRows).toHaveBeenCalledWith(mockPool, "todos", {
      limit: 25,
      offset: 10,
      sort: "updated_at",
      order: "asc",
      q: "write",
      from: undefined,
      to: undefined,
    });
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 1,
      })
    );
  });

  it("/api/db/tables/:table/rows maps unsupported errors to 400", async () => {
    mockListObservableTableRows.mockRejectedValue(
      new Error("Unsupported sort column")
    );
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/db/tables/:table/rows"
    );
    const handler = call![1];
    const mockReq = { headers: {}, params: { table: "todos" }, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/db/changes validates filters and returns changes", async () => {
    mockListRecentDbChanges.mockResolvedValue([
      {
        changed_at: new Date("2026-03-01T12:00:00Z"),
        table: "activity_logs",
        operation: "tool_call",
        row_id: "1",
        summary: "Tool calls: search_entries",
      },
    ]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/db/changes");
    const handler = call![1];
    const mockReq = {
      headers: {},
      query: {
        table: "activity_logs",
        operation: "tool_call",
        limit: "12",
        since: "2026-03-01T00:00:00.000Z",
      },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockListRecentDbChanges).toHaveBeenCalledWith(mockPool, {
      limit: 12,
      since: new Date("2026-03-01T00:00:00.000Z"),
      table: "activity_logs",
      operation: "tool_call",
    });
    expect(mockRes.json).toHaveBeenCalledWith(expect.any(Array));
  });

  it("/api/db/changes validates table, operation, and since", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/db/changes");
    const handler = call![1];
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    mockIsObservableDbTableName.mockReturnValue(false);
    await handler({ headers: {}, query: { table: "bad_table" } }, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);

    await handler({ headers: {}, query: { operation: "wrong" } }, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);

    await handler({ headers: {}, query: { since: "not-timestamp" } }, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("/api/db/changes returns 500 on query failure", async () => {
    mockListRecentDbChanges.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/db/changes");
    const handler = call![1];
    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
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

  // =========================================================================
  // Knowledge artifact endpoints
  // =========================================================================

  const mockArtifact = {
    id: "art-001",
    kind: "insight",
    title: "Test",
    body: "Body",
    tags: ["test"],
    has_embedding: true,
    created_at: new Date("2025-01-15"),
    updated_at: new Date("2025-01-15"),
    version: 1,
    source_entry_uuids: [],
  };

  it("registers artifact GET endpoint", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    expect(call).toBeTruthy();
  });

  it("GET /api/artifacts lists artifacts", async () => {
    mockListArtifacts.mockResolvedValue([mockArtifact]);
    mockCountArtifacts.mockResolvedValue(1);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockListArtifacts).toHaveBeenCalled();
    expect(mockCountArtifacts).toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalledWith({ items: [mockArtifact], total: 1 });
  });

  it("GET /api/artifacts searches when q provided", async () => {
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockSearchArtifacts.mockResolvedValue([mockArtifact]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = { headers: {}, query: { q: "dopamine" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockGenerateEmbedding).toHaveBeenCalledWith("dopamine");
    expect(mockSearchArtifacts).toHaveBeenCalled();
  });

  it("GET /api/artifacts uses keyword search when semantic=false", async () => {
    mockSearchArtifactsKeyword.mockResolvedValue([mockArtifact]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = { headers: {}, query: { q: "class", semantic: "false" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockSearchArtifacts).not.toHaveBeenCalled();
    expect(mockSearchArtifactsKeyword).toHaveBeenCalledWith(
      mockPool,
      "class",
      { kind: undefined, tags: undefined, tags_mode: "any" },
      20
    );
    expect(mockRes.json).toHaveBeenCalledWith([mockArtifact]);
  });

  it("GET /api/artifacts accepts semantic=true explicitly", async () => {
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockSearchArtifacts.mockResolvedValue([mockArtifact]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = { headers: {}, query: { q: "class", semantic: "true" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);

    expect(mockGenerateEmbedding).toHaveBeenCalledWith("class");
    expect(mockSearchArtifacts).toHaveBeenCalled();
    expect(mockSearchArtifactsKeyword).not.toHaveBeenCalled();
  });

  it("GET /api/artifacts returns 500 on error", async () => {
    mockCountArtifacts.mockResolvedValue(0);
    mockListArtifacts.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/artifacts rejects unauthorized", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";

    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("GET /api/artifacts accepts valid bearer token", async () => {
    const { config } = await import("../../src/config.js");
    (config as any).server.mcpSecret = "test-secret";
    mockListArtifacts.mockResolvedValue([]);
    mockCountArtifacts.mockResolvedValue(0);

    await startHttpServer((() => ({ connect: vi.fn() })) as any);
    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = { headers: { authorization: "Bearer test-secret" }, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalledWith(401);
    (config as any).server.mcpSecret = "";
  });

  it("GET /api/artifacts/tags returns tag list", async () => {
    mockListArtifactTags.mockResolvedValue([{ name: "health", count: 3 }]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/tags");
    const handler = call![1];

    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockListArtifactTags).toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalledWith([{ name: "health", count: 3 }]);
  });

  it("GET /api/artifacts/tags returns 500 on error", async () => {
    mockListArtifactTags.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/tags");
    const handler = call![1];

    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/artifacts/titles returns artifact titles", async () => {
    mockListArtifactTitles.mockResolvedValue([
      { id: "art-001", title: "First", kind: "insight" },
    ]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/artifacts/titles"
    );
    const handler = call![1];

    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockListArtifactTitles).toHaveBeenCalledWith(mockPool);
    expect(mockRes.json).toHaveBeenCalledWith([
      { id: "art-001", title: "First", kind: "insight" },
    ]);
  });

  it("GET /api/artifacts/titles returns 500 on error", async () => {
    mockListArtifactTitles.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/artifacts/titles"
    );
    const handler = call![1];

    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/artifacts/graph returns graph payload", async () => {
    mockGetArtifactGraph.mockResolvedValue({
      artifacts: [
        {
          id: "art-001",
          title: "One",
          kind: "insight",
          tags: ["health"],
          has_embedding: true,
        },
        {
          id: "art-002",
          title: "Two",
          kind: "theory",
          tags: ["health", "sleep"],
          has_embedding: true,
        },
      ],
      explicitLinks: [{ source_id: "art-001", target_id: "art-002" }],
      sharedSources: [{ artifact_id_1: "art-001", artifact_id_2: "art-002" }],
      similarities: [{ id_1: "art-001", id_2: "art-002", similarity: 0.8 }],
    });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/artifacts/graph"
    );
    const handler = call![1];
    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.any(Array),
        edges: expect.any(Array),
      })
    );
  });

  it("GET /api/artifacts/graph returns 500 on error", async () => {
    mockGetArtifactGraph.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/artifacts/graph"
    );
    const handler = call![1];
    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/artifacts/:id/related returns semantic and explicit links", async () => {
    mockFindSimilarArtifacts.mockResolvedValue([
      { id: "art-002", title: "Two", kind: "theory", similarity: 0.65 },
    ]);
    mockGetExplicitLinks.mockResolvedValue([
      { id: "art-003", title: "Three", kind: "model" },
    ]);
    mockGetExplicitBacklinks.mockResolvedValue([
      { id: "art-004", title: "Four", kind: "note" },
    ]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/artifacts/:id/related"
    );
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "art-001" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockFindSimilarArtifacts).toHaveBeenCalledWith(
      mockPool,
      "art-001",
      10,
      0.3
    );
    expect(mockRes.json).toHaveBeenCalledWith({
      semantic: [{ id: "art-002", title: "Two", kind: "theory", similarity: 0.65 }],
      explicit: [
        {
          id: "art-003",
          title: "Three",
          kind: "model",
          direction: "outgoing",
        },
        {
          id: "art-004",
          title: "Four",
          kind: "note",
          direction: "incoming",
        },
      ],
    });
  });

  it("GET /api/artifacts/:id/related returns 500 on error", async () => {
    mockFindSimilarArtifacts.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find(
      (c: any[]) => c[0] === "/api/artifacts/:id/related"
    );
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "art-001" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/artifacts/:id returns artifact", async () => {
    mockGetArtifactById.mockResolvedValue(mockArtifact);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = { headers: {}, params: { id: "art-001" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(mockArtifact);
  });

  it("GET /api/artifacts/:id returns 404", async () => {
    mockGetArtifactById.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = { headers: {}, params: { id: "missing" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("GET /api/artifacts/:id returns 500 on error", async () => {
    mockGetArtifactById.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = { headers: {}, params: { id: "art-001" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("POST /api/artifacts creates artifact", async () => {
    mockCreateArtifact.mockResolvedValue(mockArtifact);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = {
      headers: {},
      body: { kind: "insight", title: "Test", body: "Body" },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(mockArtifact);
    expect(mockSyncExplicitLinks).toHaveBeenCalledWith(mockPool, "art-001", []);
  });

  it("POST /api/artifacts resolves and syncs wiki links", async () => {
    mockCreateArtifact.mockResolvedValue({
      ...mockArtifact,
      body: "[[Theory A]] and [[Note B]]",
    });
    mockResolveArtifactTitleToId
      .mockResolvedValueOnce("art-002")
      .mockResolvedValueOnce("art-003");
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = {
      headers: {},
      body: { kind: "insight", title: "Test", body: "[[Theory A]] and [[Note B]]" },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockResolveArtifactTitleToId).toHaveBeenNthCalledWith(
      1,
      mockPool,
      "Theory A"
    );
    expect(mockResolveArtifactTitleToId).toHaveBeenNthCalledWith(
      2,
      mockPool,
      "Note B"
    );
    expect(mockSyncExplicitLinks).toHaveBeenCalledWith(mockPool, "art-001", [
      "art-002",
      "art-003",
    ]);
  });

  it("POST /api/artifacts rejects invalid body", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = { headers: {}, body: { kind: "invalid" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("POST /api/artifacts returns 500 on error", async () => {
    mockCreateArtifact.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/artifacts");
    const handler = call![1];

    const mockReq = { headers: {}, body: { kind: "insight", title: "T", body: "B" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("PUT /api/artifacts/:id updates artifact", async () => {
    mockUpdateArtifact.mockResolvedValue(mockArtifact);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = {
      headers: {},
      params: { id: "art-001" },
      body: { title: "Updated", expected_version: 1 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(mockArtifact);
    expect(mockSyncExplicitLinks).toHaveBeenCalledWith(mockPool, "art-001", []);
  });

  it("PUT /api/artifacts/:id returns 409 on version conflict", async () => {
    mockUpdateArtifact.mockResolvedValue("version_conflict");
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = {
      headers: {},
      params: { id: "art-001" },
      body: { title: "Updated", expected_version: 1 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(409);
  });

  it("PUT /api/artifacts/:id returns 404 when not found", async () => {
    mockUpdateArtifact.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = {
      headers: {},
      params: { id: "missing" },
      body: { title: "Updated", expected_version: 1 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("PUT /api/artifacts/:id rejects invalid body", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = {
      headers: {},
      params: { id: "art-001" },
      body: { title: "Updated" }, // missing expected_version
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("PUT /api/artifacts/:id returns 500 on error", async () => {
    mockUpdateArtifact.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = {
      headers: {},
      params: { id: "art-001" },
      body: { title: "Updated", expected_version: 1 },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("DELETE /api/artifacts/:id deletes artifact", async () => {
    mockDeleteArtifact.mockResolvedValue(true);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = { headers: {}, params: { id: "art-001" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ status: "deleted" });
  });

  it("DELETE /api/artifacts/:id returns 404 when not found", async () => {
    mockDeleteArtifact.mockResolvedValue(false);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = { headers: {}, params: { id: "missing" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("DELETE /api/artifacts/:id returns 500 on error", async () => {
    mockDeleteArtifact.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/artifacts/:id");
    const handler = call![1];

    const mockReq = { headers: {}, params: { id: "art-001" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/entries/search returns results", async () => {
    const entries = [{ uuid: "ENTRY-001", created_at: new Date(), preview: "Test" }];
    mockSearchEntriesForPicker.mockResolvedValue(entries);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/entries/search");
    const handler = call![1];

    const mockReq = { headers: {}, query: { q: "test" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(entries);
  });

  it("GET /api/entries/search rejects missing q", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/entries/search");
    const handler = call![1];

    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("GET /api/entries/search returns 500 on error", async () => {
    mockSearchEntriesForPicker.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/entries/search");
    const handler = call![1];

    const mockReq = { headers: {}, query: { q: "test" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/content/search returns unified results", async () => {
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockSearchContent.mockResolvedValue([{ content_type: "journal_entry", id: "ENTRY-001" }]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/content/search");
    const handler = call![1];

    const mockReq = { headers: {}, query: { q: "test" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockSearchContent).toHaveBeenCalled();
  });

  it("GET /api/content/search passes content_types filter", async () => {
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockSearchContent.mockResolvedValue([]);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/content/search");
    const handler = call![1];

    const mockReq = { headers: {}, query: { q: "test", content_types: "journal_entry,knowledge_artifact" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockSearchContent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "test",
      { content_types: ["journal_entry", "knowledge_artifact"] },
      10
    );
  });

  it("GET /api/content/search rejects missing q", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/content/search");
    const handler = call![1];

    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("GET /api/content/search returns 500 on error", async () => {
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockSearchContent.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/content/search");
    const handler = call![1];

    const mockReq = { headers: {}, query: { q: "test" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/todos returns paginated todo list", async () => {
    const items = [
      {
        id: "todo-1",
        title: "Task",
        status: "active",
        next_step: null,
        body: "",
        tags: [],
        urgent: false,
        important: false,
        is_focus: false,
        parent_id: null,
        sort_order: 0,
        completed_at: null,
      },
    ];
    mockListTodos.mockResolvedValue({ rows: items, count: 1 });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/todos");
    const handler = call![1];
    const mockReq = { headers: {}, query: { status: "active", urgent: "true", important: "false", parent_id: "root", limit: "5", offset: "10" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockListTodos).toHaveBeenCalledWith(mockPool, {
      status: "active",
      urgent: true,
      important: false,
      parent_id: "root",
      focus_only: undefined,
      include_children: undefined,
      limit: 5,
      offset: 10,
    });
    expect(mockRes.json).toHaveBeenCalledWith({ items, total: 1 });
  });

  it("GET /api/todos/:id returns 404 for missing todo", async () => {
    mockGetTodoById.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("GET /api/todos returns 500 on query error", async () => {
    mockListTodos.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/todos");
    const handler = call![1];
    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/todos/:id returns a todo", async () => {
    const todo = {
      id: "todo-1",
      title: "Task",
      status: "active",
      next_step: null,
      body: "",
      tags: [],
    };
    mockGetTodoById.mockResolvedValue(todo);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(todo);
  });

  it("GET /api/todos/:id returns 500 on error", async () => {
    mockGetTodoById.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("POST /api/todos creates a todo", async () => {
    const todo = {
      id: "todo-1",
      title: "Task",
      status: "active",
      next_step: null,
      body: "",
      tags: [],
    };
    mockCreateTodo.mockResolvedValue(todo);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos");
    const handler = call![1];
    const mockReq = { headers: {}, body: { title: "Task" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(todo);
  });

  it("POST /api/todos returns 500 on error", async () => {
    mockCreateTodo.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos");
    const handler = call![1];
    const mockReq = { headers: {}, body: { title: "Task" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("POST /api/todos rejects invalid body", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos");
    const handler = call![1];
    const mockReq = { headers: {}, body: { title: "" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("PUT /api/todos/:id updates a todo", async () => {
    const todo = {
      id: "todo-1",
      title: "Updated",
      status: "done",
      next_step: null,
      body: "",
      tags: [],
    };
    mockUpdateTodo.mockResolvedValue(todo);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = {
      headers: {},
      params: { id: "todo-1" },
      body: { status: "done" },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(todo);
  });

  it("PUT /api/todos/:id returns 404 when missing", async () => {
    mockUpdateTodo.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" }, body: { title: "X" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("PUT /api/todos/:id rejects invalid body", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" }, body: { title: "" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("PUT /api/todos/:id returns 500 on error", async () => {
    mockUpdateTodo.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" }, body: { title: "X" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("DELETE /api/todos/:id deletes a todo", async () => {
    mockDeleteTodo.mockResolvedValue(true);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ status: "deleted" });
  });

  it("DELETE /api/todos/:id returns 404 for missing todo", async () => {
    mockDeleteTodo.mockResolvedValue(false);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("DELETE /api/todos/:id returns 500 on error", async () => {
    mockDeleteTodo.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("POST /api/todos/:id/complete completes a todo", async () => {
    const todo = { id: "todo-1", title: "Task", status: "done", completed_at: "2026-01-01T00:00:00Z" };
    mockCompleteTodo.mockResolvedValue(todo);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id/complete");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockCompleteTodo).toHaveBeenCalledWith(mockPool, "todo-1");
    expect(mockRes.json).toHaveBeenCalledWith(todo);
  });

  it("POST /api/todos/:id/complete returns 404 for missing todo", async () => {
    mockCompleteTodo.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id/complete");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("POST /api/todos/:id/complete returns 500 on error", async () => {
    mockCompleteTodo.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos/:id/complete");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("POST /api/todos/focus sets focus", async () => {
    const todo = { id: "todo-1", title: "Task", is_focus: true };
    mockSetTodoFocus.mockResolvedValue(todo);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos/focus");
    const handler = call![1];
    const mockReq = { headers: {}, body: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockSetTodoFocus).toHaveBeenCalledWith(mockPool, "todo-1");
    expect(mockRes.json).toHaveBeenCalledWith(todo);
  });

  it("POST /api/todos/focus clears focus", async () => {
    mockSetTodoFocus.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos/focus");
    const handler = call![1];
    const mockReq = { headers: {}, body: { clear: true } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ status: "cleared" });
  });

  it("POST /api/todos/focus returns 400 when no id or clear", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos/focus");
    const handler = call![1];
    const mockReq = { headers: {}, body: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("POST /api/todos/focus returns 404 for missing todo", async () => {
    mockSetTodoFocus.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos/focus");
    const handler = call![1];
    const mockReq = { headers: {}, body: { id: "missing-id" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("POST /api/todos/focus returns 500 on error", async () => {
    mockSetTodoFocus.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/todos/focus");
    const handler = call![1];
    const mockReq = { headers: {}, body: { id: "todo-1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/todos/focus returns current focus todo", async () => {
    const todo = { id: "todo-1", title: "Task", is_focus: true };
    mockGetFocusTodo.mockResolvedValue(todo);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/todos/focus");
    const handler = call![1];
    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(todo);
  });

  it("GET /api/todos/focus returns null when no focus set", async () => {
    mockGetFocusTodo.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/todos/focus");
    const handler = call![1];
    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(null);
  });

  it("GET /api/todos/focus returns 500 on error", async () => {
    mockGetFocusTodo.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/todos/focus");
    const handler = call![1];
    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  // =========================================================================
  // POST /api/settings/timezone
  // =========================================================================

  it("POST /api/settings/timezone updates timezone", async () => {
    mockUpsertUserSettings.mockResolvedValue({ timezone: "America/New_York" });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/settings/timezone"
    );
    const handler = call![1];
    const mockReq = {
      headers: {},
      body: { timezone: "America/New_York" },
    };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockUpsertUserSettings).toHaveBeenCalledWith(
      mockPool,
      "0",
      { timezone: "America/New_York" }
    );
    expect(mockRes.json).toHaveBeenCalledWith({
      status: "ok",
      timezone: "America/New_York",
    });
  });

  it("POST /api/settings/timezone rejects missing timezone", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/settings/timezone"
    );
    const handler = call![1];
    const mockReq = { headers: {}, body: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("POST /api/settings/timezone rejects invalid timezone", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/settings/timezone"
    );
    const handler = call![1];
    const mockReq = { headers: {}, body: { timezone: "Invalid/Zone" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("POST /api/settings/timezone returns 500 on error", async () => {
    mockUpsertUserSettings.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find(
      (c: any[]) => c[0] === "/api/settings/timezone"
    );
    const handler = call![1];
    const mockReq = { headers: {}, body: { timezone: "Europe/Madrid" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  // ====================================================================
  // Journal Entries CRUD
  // ====================================================================

  it("GET /api/entries returns paginated list", async () => {
    const items = [{ uuid: "e1", text: "hello", source: "web", version: 1, tags: [] }];
    mockListEntries.mockResolvedValue({ rows: items, count: 1 });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/entries");
    const handler = call![1];
    const mockReq = { headers: {}, query: { limit: "10", offset: "0", source: "web" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockListEntries).toHaveBeenCalledWith(mockPool, expect.objectContaining({ source: "web", limit: 10, offset: 0 }));
    expect(mockRes.json).toHaveBeenCalledWith({ items, total: 1 });
  });

  it("GET /api/entries returns 500 on error", async () => {
    mockListEntries.mockRejectedValue(new Error("db error"));
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/entries");
    const handler = call![1];
    const mockReq = { headers: {}, query: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it("GET /api/entries/:uuid returns single entry", async () => {
    const entry = { uuid: "e1", text: "test", source: "web", version: 1 };
    mockGetEntryByUuid.mockResolvedValue(entry);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/entries/:uuid");
    const handler = call![1];
    const mockReq = { headers: {}, params: { uuid: "e1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(entry);
  });

  it("GET /api/entries/:uuid returns 404 for missing", async () => {
    mockGetEntryByUuid.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/entries/:uuid");
    const handler = call![1];
    const mockReq = { headers: {}, params: { uuid: "missing" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("POST /api/entries creates entry", async () => {
    const entry = { uuid: "new-1", text: "hello", source: "web", version: 1, tags: [] };
    mockCreateEntry.mockResolvedValue(entry);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/entries");
    const handler = call![1];
    const mockReq = { headers: {}, body: { text: "hello", tags: ["test"] } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockCreateEntry).toHaveBeenCalledWith(mockPool, expect.objectContaining({ text: "hello", tags: ["test"] }));
    expect(mockRes.status).toHaveBeenCalledWith(201);
  });

  it("POST /api/entries returns 400 for invalid body", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/entries");
    const handler = call![1];
    const mockReq = { headers: {}, body: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("PUT /api/entries/:uuid updates entry", async () => {
    const entry = { uuid: "e1", text: "updated", source: "web", version: 2 };
    mockUpdateEntry.mockResolvedValue(entry);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/entries/:uuid");
    const handler = call![1];
    const mockReq = { headers: {}, params: { uuid: "e1" }, body: { text: "updated", expected_version: 1 } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(entry);
  });

  it("PUT /api/entries/:uuid returns 409 on version conflict", async () => {
    mockUpdateEntry.mockResolvedValue("version_conflict");
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/entries/:uuid");
    const handler = call![1];
    const mockReq = { headers: {}, params: { uuid: "e1" }, body: { text: "x", expected_version: 1 } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(409);
  });

  it("PUT /api/entries/:uuid returns 404 when not found", async () => {
    mockUpdateEntry.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/entries/:uuid");
    const handler = call![1];
    const mockReq = { headers: {}, params: { uuid: "missing" }, body: { text: "x", expected_version: 1 } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("DELETE /api/entries/:uuid deletes entry", async () => {
    mockDeleteEntry.mockResolvedValue(true);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/entries/:uuid");
    const handler = call![1];
    const mockReq = { headers: {}, params: { uuid: "e1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ status: "deleted" });
  });

  it("DELETE /api/entries/:uuid returns 404 when not found", async () => {
    mockDeleteEntry.mockResolvedValue(false);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/entries/:uuid");
    const handler = call![1];
    const mockReq = { headers: {}, params: { uuid: "missing" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  // ====================================================================
  // Media endpoints
  // ====================================================================

  it("DELETE /api/media/:id deletes media", async () => {
    mockDeleteMediaRow.mockResolvedValue({ deleted: true, storage_key: "entries/e1/test.jpg" });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/media/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "42" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ status: "deleted" });
  });

  it("DELETE /api/media/:id returns 404 when not found", async () => {
    mockDeleteMediaRow.mockResolvedValue({ deleted: false, storage_key: null });
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/media/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "999" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("DELETE /api/media/:id returns 400 for invalid id", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/media/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "abc" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  // ====================================================================
  // Template CRUD
  // ====================================================================

  it("GET /api/templates returns template list", async () => {
    const templates = [{ id: "t1", slug: "morning", name: "Morning" }];
    mockListTemplates.mockResolvedValue(templates);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/templates");
    const handler = call![1];
    const mockReq = { headers: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(templates);
  });

  it("GET /api/templates/:id returns single template", async () => {
    const template = { id: "t1", slug: "morning", name: "Morning" };
    mockGetTemplateById.mockResolvedValue(template);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/templates/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "t1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(template);
  });

  it("GET /api/templates/:id returns 404 when not found", async () => {
    mockGetTemplateById.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.get.mock.calls.find((c: any[]) => c[0] === "/api/templates/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "nonexistent" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("POST /api/templates creates template", async () => {
    const template = { id: "t1", slug: "weekly", name: "Weekly Review" };
    mockCreateTemplate.mockResolvedValue(template);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/templates");
    const handler = call![1];
    const mockReq = { headers: {}, body: { slug: "weekly", name: "Weekly Review" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(201);
  });

  it("POST /api/templates returns 400 for invalid body", async () => {
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.post.mock.calls.find((c: any[]) => c[0] === "/api/templates");
    const handler = call![1];
    const mockReq = { headers: {}, body: {} };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("PUT /api/templates/:id updates template", async () => {
    const template = { id: "t1", slug: "morning", name: "Morning Updated" };
    mockUpdateTemplate.mockResolvedValue(template);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/templates/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "t1" }, body: { name: "Morning Updated" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(template);
  });

  it("PUT /api/templates/:id returns 404 when not found", async () => {
    mockUpdateTemplate.mockResolvedValue(null);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.put.mock.calls.find((c: any[]) => c[0] === "/api/templates/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "missing" }, body: { name: "x" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("DELETE /api/templates/:id deletes template", async () => {
    mockDeleteTemplate.mockResolvedValue(true);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/templates/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "t1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ status: "deleted" });
  });

  it("DELETE /api/templates/:id returns 404 when not found", async () => {
    mockDeleteTemplate.mockResolvedValue(false);
    await startHttpServer((() => ({ connect: vi.fn() })) as any);

    const call = mockApp.delete.mock.calls.find((c: any[]) => c[0] === "/api/templates/:id");
    const handler = call![1];
    const mockReq = { headers: {}, params: { id: "missing" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });
});
