import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockLogApiUsage,
  mockChatCreate,
  mockResponsesCreate,
} = vi.hoisted(() => ({
  mockLogApiUsage: vi.fn(),
  mockChatCreate: vi.fn(),
  mockResponsesCreate: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: { botToken: "123:ABC" },
    openai: { apiKey: "sk-test", chatModel: "gpt-5-mini" },
    apiRates: {
      "gpt-4.1": { input: 2, output: 8 },
    },
  },
}));

vi.mock("../../src/db/client.js", () => ({
  pool: {},
}));

vi.mock("../../src/db/queries.js", () => ({
  logApiUsage: mockLogApiUsage,
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockChatCreate,
      },
    },
    responses: {
      create: mockResponsesCreate,
    },
  })),
}));

import { extractTextFromDocument, extractTextFromImage } from "../../src/telegram/media.js";

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  mockLogApiUsage.mockReset();
  mockChatCreate.mockReset();
  mockResponsesCreate.mockReset();
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("extractTextFromDocument", () => {
  it("extracts text from standalone image messages", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "photos/img_1.jpg" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("fake-image"), { status: 200 })
    );

    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Readable sign text" } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });

    const result = await extractTextFromImage("img-1", "");

    expect(result).toBe("Readable sign text");
    expect(mockChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4.1",
      })
    );
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        purpose: "vision_ocr",
      })
    );
    const usageArgs = mockLogApiUsage.mock.calls[0]?.[1];
    expect(usageArgs.costUsd).toBeGreaterThan(0);
  });

  it("passes caption context into image OCR prompt", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "photos/img_2.jpg" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("fake-image-2"), { status: 200 })
    );

    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Caption-aware OCR text" } }],
      usage: { prompt_tokens: 90, completion_tokens: 10 },
    });

    await extractTextFromImage("img-2", "menu board");

    expect(mockChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Caption/context: menu board"),
              }),
            ]),
          }),
        ]),
      })
    );
  });

  it("extracts full PDF text via Responses API", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/report.pdf" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("%PDF-fake"), { status: 200 })
    );

    mockResponsesCreate.mockResolvedValueOnce({
      output_text: "Page 1 text\nPage 2 text",
      usage: { input_tokens: 400, output_tokens: 120 },
    });

    const result = await extractTextFromDocument({
      fileId: "pdf-123",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      caption: "monthly report",
    });

    expect(result).toBe("Page 1 text\nPage 2 text");
    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5-mini",
        input: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({ role: "user" }),
        ]),
      })
    );
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "openai",
        purpose: "pdf_ocr",
      })
    );
  });

  it("extracts full PDF text without caption context", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/plain.pdf" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("%PDF-plain"), { status: 200 })
    );

    mockResponsesCreate.mockResolvedValueOnce({
      output_text: "PDF plain text",
      usage: { input_tokens: 200, output_tokens: 40 },
    });

    await extractTextFromDocument({
      fileId: "pdf-plain",
      fileName: "plain.pdf",
      mimeType: "application/pdf",
      caption: "",
    });

    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "input_text",
                text: "Extract all readable text from this PDF document.",
              }),
            ]),
          }),
        ]),
      })
    );
  });

  it("handles PDF OCR responses without usage metadata", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/no-usage.pdf" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("%PDF-no-usage"), { status: 200 })
    );

    mockResponsesCreate.mockResolvedValueOnce({
      output_text: "text without usage",
    });

    await extractTextFromDocument({
      fileId: "pdf-no-usage",
      mimeType: "application/pdf",
      caption: "",
    });

    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
      })
    );
  });

  it("returns text directly for plain text documents", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/notes.txt" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("line one\nline two"), { status: 200 })
    );

    const result = await extractTextFromDocument({
      fileId: "txt-1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      caption: "",
    });

    expect(result).toBe("line one\nline two");
    expect(mockResponsesCreate).not.toHaveBeenCalled();
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it("treats application/json as text document", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/data.json" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("{\"ok\":true}"), { status: 200 })
    );

    const result = await extractTextFromDocument({
      fileId: "json-1",
      fileName: "data.json",
      mimeType: "application/json",
      caption: "",
    });

    expect(result).toBe("{\"ok\":true}");
  });

  it("returns image OCR for image documents", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/screenshot.png" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("fake-png"), { status: 200 })
    );
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Image doc text" } }],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    });

    const result = await extractTextFromDocument({
      fileId: "img-doc-1",
      fileName: "screenshot.png",
      mimeType: "image/png",
      caption: "",
    });

    expect(result).toBe("Image doc text");
    expect(mockChatCreate).toHaveBeenCalled();
  });

  it("handles image OCR responses without usage and content", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "photos/img_3.jpg" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("fake-image-3"), { status: 200 })
    );

    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: {} }],
    });

    const result = await extractTextFromImage("img-3", "");
    expect(result).toBe("");
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
      })
    );
  });

  it("returns error when Telegram file path lookup fails", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: {} }), { status: 200 })
    );

    await expect(
      extractTextFromDocument({
        fileId: "bad-doc",
        fileName: "bad.pdf",
        mimeType: "application/pdf",
        caption: "",
      })
    ).rejects.toThrow("Failed to get file path");
  });

  it("returns size warning for oversized text documents", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/huge.txt" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.alloc(10 * 1024 * 1024 + 1), { status: 200 })
    );

    const result = await extractTextFromDocument({
      fileId: "txt-big",
      fileName: "huge.txt",
      mimeType: "text/plain",
      caption: "",
    });

    expect(result).toContain("too large for inline text extraction");
  });

  it("returns size warning for oversized PDFs", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/huge.pdf" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.alloc(20 * 1024 * 1024 + 1), { status: 200 })
    );

    const result = await extractTextFromDocument({
      fileId: "pdf-big",
      fileName: "huge.pdf",
      mimeType: "application/pdf",
      caption: "",
    });

    expect(result).toContain("PDF is too large for inline OCR");
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });

  it("returns fallback for unsupported document format", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/archive.docx" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("fake-docx"), { status: 200 })
    );

    const result = await extractTextFromDocument({
      fileId: "docx-1",
      fileName: "archive.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      caption: "",
    });

    expect(result).toContain("not supported for text extraction yet");
    expect(mockResponsesCreate).not.toHaveBeenCalled();
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it("uses Telegram file path as fallback name for unsupported docs", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/no-name.bin" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("raw-bytes"), { status: 200 })
    );

    const result = await extractTextFromDocument({
      fileId: "doc-no-name",
      mimeType: "application/octet-stream",
      caption: "",
    });

    expect(result).toContain("docs/no-name.bin");
  });

  it("handles missing mime type as non-text document", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "docs/unknown.bin" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("raw"), { status: 200 })
    );

    const result = await extractTextFromDocument({
      fileId: "unknown-1",
      caption: "",
    });

    expect(result).toContain("docs/unknown.bin");
  });
});
