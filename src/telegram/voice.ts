import OpenAI, { toFile } from "openai";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { logApiUsage } from "../db/queries.js";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

const TELEGRAM_API = "https://api.telegram.org";

/**
 * Download a voice message from Telegram and transcribe via Whisper.
 * Returns the transcribed text and the voice duration in seconds.
 */
export async function transcribeVoiceMessage(
  fileId: string,
  durationSeconds: number
): Promise<string> {
  const startMs = Date.now();

  // 1. Get file path from Telegram
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

  // 2. Download the .ogg file
  const downloadRes = await fetch(
    `${TELEGRAM_API}/file/bot${config.telegram.botToken}/${filePath}`
  );
  const buffer = Buffer.from(await downloadRes.arrayBuffer());

  // 3. Transcribe via Whisper
  const file = await toFile(buffer, "voice.ogg", { type: "audio/ogg" });
  const transcription = await getOpenAI().audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "text",
  });

  const latencyMs = Date.now() - startMs;
  /* v8 ignore next -- defensive fallback */
  const costUsd = (durationSeconds / 60) * (config.apiRates["whisper-1"]?.input ?? 0.006);

  // 4. Log usage
  await logApiUsage(pool, {
    provider: "openai",
    model: "whisper-1",
    purpose: "transcription",
    inputTokens: 0,
    outputTokens: 0,
    durationSeconds,
    costUsd,
    latencyMs,
  });

  return transcription as unknown as string;
}
