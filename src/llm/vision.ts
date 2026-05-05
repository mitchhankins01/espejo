import OpenAI from "openai";
import { config } from "../config.js";

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

export interface ExtractTextFromImageOptions {
  buffer: Buffer;
  caption?: string;
  model?: string;
  maxTokens?: number;
}

export async function extractTextFromImage(
  opts: ExtractTextFromImageOptions
): Promise<string> {
  const prompt = opts.caption
    ? `Extract all readable text from this image. Caption/context: ${opts.caption}`
    : "Extract all readable text from this image.";

  const response = await getOpenAI().chat.completions.create({
    model: opts.model ?? "gpt-4.1",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${opts.buffer.toString("base64")}`,
            },
          },
        ],
      },
    ],
    max_tokens: opts.maxTokens ?? 1200,
  });

  return (response.choices[0]?.message?.content ?? "").trim();
}

export interface ExtractTextFromPdfOptions {
  buffer: Buffer;
  filename: string;
  caption?: string;
  model?: string;
  maxTokens?: number;
}

export async function extractTextFromPdf(
  opts: ExtractTextFromPdfOptions
): Promise<string> {
  const prompt = opts.caption
    ? `Extract all readable text from this PDF document. Caption/context: ${opts.caption}`
    : "Extract all readable text from this PDF document.";

  const response = await getOpenAI().responses.create({
    model: opts.model ?? config.openai.chatModel,
    input: [
      {
        role: "system",
        content:
          "You are an OCR extractor. Return only extracted text in reading order.",
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_file",
            filename: opts.filename,
            file_data: `data:application/pdf;base64,${opts.buffer.toString("base64")}`,
          },
        ],
      },
    ],
    max_output_tokens: opts.maxTokens ?? 4000,
  });

  return response.output_text.trim();
}
