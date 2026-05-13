import OpenAI, { toFile } from "openai";
import { config } from "../config.js";

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

export interface TranscribeOptions {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
  model?: string;
}

export async function transcribeAudio(opts: TranscribeOptions): Promise<string> {
  const file = await toFile(opts.buffer, opts.filename ?? "audio.ogg", {
    type: opts.mimeType ?? "audio/ogg",
  });
  const transcription = await getOpenAI().audio.transcriptions.create({
    model: opts.model ?? config.models.openaiTranscribe,
    file,
    response_format: "text",
  });
  return transcription as unknown as string;
}
