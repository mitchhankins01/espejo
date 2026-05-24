import OpenAI, { toFile } from "openai";
import { config } from "../config.js";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

const TELEGRAM_API = "https://api.telegram.org";

// Whisper keys format detection off the multipart filename extension, not the
// raw bytes. Map each supported extension to a content type so we can hand the
// API a filename that matches the actual audio (e.g. forwarded .m4a files that
// arrive as Telegram `audio`, not `voice`).
const EXT_MIME: Record<string, string> = {
  flac: "audio/flac",
  m4a: "audio/m4a",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
};

/**
 * Pick the filename + content type to hand Whisper. Tries the message's own
 * file name first (most authoritative), then the Telegram file_path, then
 * falls back to voice.ogg for native voice notes.
 */
export function resolveAudioMeta(
  hintName: string | undefined,
  filePath: string
): { filename: string; mimeType: string } {
  for (const candidate of [hintName, filePath]) {
    if (!candidate) continue;
    const base = candidate.split("/").pop() ?? "";
    const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
    const mime = EXT_MIME[ext];
    if (mime) return { filename: base, mimeType: mime };
  }
  return { filename: "voice.ogg", mimeType: "audio/ogg" };
}

/**
 * Convert Telegram HTML output into clean plain text suitable for speech.
 */
export function normalizeVoiceText(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Download a voice message from Telegram and transcribe via Whisper.
 * Returns the transcribed text and the voice duration in seconds.
 */
export async function transcribeVoiceMessage(
  fileId: string,
  _durationSeconds: number,
  hintName?: string
): Promise<string> {
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

  // 3. Transcribe via Whisper — label the file with its real extension so
  // Whisper's format detection accepts non-ogg payloads (e.g. forwarded .m4a).
  const { filename, mimeType } = resolveAudioMeta(hintName, filePath);
  const file = await toFile(buffer, filename, { type: mimeType });
  const transcription = await getOpenAI().audio.transcriptions.create({
    model: config.models.openaiTranscribe,
    file,
    response_format: "text",
  });

  return transcription as unknown as string;
}

