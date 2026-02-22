import OpenAI from "openai";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { logApiUsage } from "../db/queries.js";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_TEXT_DOC_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB
const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-ndjson",
]);

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const rates = config.apiRates?.[model] ?? { input: 0, output: 0 };
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

async function fetchTelegramFile(fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
  const fileRes = await fetch(
    `${TELEGRAM_API}/bot${config.telegram.botToken}/getFile?file_id=${fileId}`
  );
  const fileData = (await fileRes.json()) as {
    result?: { file_path?: string };
  };
  const filePath = fileData.result?.file_path;
  if (!filePath) {
    throw new Error(`Failed to get file path for file_id: ${fileId}`);
  }

  const downloadRes = await fetch(
    `${TELEGRAM_API}/file/bot${config.telegram.botToken}/${filePath}`
  );
  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  return { buffer, filePath };
}

function isTextDocument(mimeType?: string): boolean {
  if (!mimeType) return false;
  if (TEXT_MIME_TYPES.has(mimeType)) return true;
  return TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

export async function extractTextFromImage(
  fileId: string,
  caption: string
): Promise<string> {
  const { buffer } = await fetchTelegramFile(fileId);
  return extractTextFromImageBuffer(buffer, caption);
}

async function extractTextFromImageBuffer(
  buffer: Buffer,
  caption: string
): Promise<string> {
  const startMs = Date.now();
  const prompt = caption
    ? `Extract all readable text from this image. Caption/context: ${caption}`
    : "Extract all readable text from this image.";

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4.1",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${buffer.toString("base64")}`,
            },
          },
        ],
      },
    ],
    max_tokens: 1200,
  });

  const latencyMs = Date.now() - startMs;
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  await logApiUsage(pool, {
    provider: "openai",
    model: "gpt-4.1",
    purpose: "vision_ocr",
    inputTokens,
    outputTokens,
    costUsd: computeCost("gpt-4.1", inputTokens, outputTokens),
    latencyMs,
  });

  const text = response.choices[0]?.message?.content ?? "";
  return text.trim();
}

async function extractTextFromPdfBuffer(
  buffer: Buffer,
  fileName: string,
  caption: string
): Promise<string> {
  if (buffer.length > MAX_PDF_BYTES) {
    return "PDF is too large for inline OCR. Please send a smaller PDF.";
  }

  const startMs = Date.now();
  const prompt = caption
    ? `Extract all readable text from this PDF document. Caption/context: ${caption}`
    : "Extract all readable text from this PDF document.";

  const response = await getOpenAI().responses.create({
    model: config.openai.chatModel,
    input: [
      {
        role: "system",
        content: "You are an OCR extractor. Return only extracted text in reading order.",
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_file",
            filename: fileName,
            file_data: `data:application/pdf;base64,${buffer.toString("base64")}`,
          },
        ],
      },
    ],
    max_output_tokens: 4000,
  });

  const latencyMs = Date.now() - startMs;
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  await logApiUsage(pool, {
    provider: "openai",
    model: config.openai.chatModel,
    purpose: "pdf_ocr",
    inputTokens,
    outputTokens,
    costUsd: computeCost(config.openai.chatModel, inputTokens, outputTokens),
    latencyMs,
  });

  return response.output_text.trim();
}

export async function extractTextFromDocument(params: {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  caption: string;
}): Promise<string> {
  const { fileId, fileName, mimeType, caption } = params;
  const { buffer, filePath } = await fetchTelegramFile(fileId);
  const lowerPath = filePath.toLowerCase();

  if (
    (mimeType && mimeType.startsWith("image/")) ||
    lowerPath.endsWith(".jpg") ||
    lowerPath.endsWith(".jpeg") ||
    lowerPath.endsWith(".png") ||
    lowerPath.endsWith(".webp")
  ) {
    return extractTextFromImageBuffer(buffer, caption);
  }

  if (mimeType === "application/pdf" || lowerPath.endsWith(".pdf")) {
    const pdfName = fileName ?? "document.pdf";
    return extractTextFromPdfBuffer(buffer, pdfName, caption);
  }

  if (isTextDocument(mimeType)) {
    if (buffer.length > MAX_TEXT_DOC_BYTES) {
      return "Document is too large for inline text extraction. Please send a smaller text file.";
    }
    return buffer.toString("utf8").trim();
  }

  const name = fileName ?? filePath;
  return `I received document "${name}", but this format is not supported for text extraction yet. ` +
    "Send it as PDF, image/screenshot, or plain text.";
}
