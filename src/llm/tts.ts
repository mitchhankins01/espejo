import OpenAI from "openai";
import { config } from "../config.js";

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

export interface SynthesizeSpeechOptions {
  text: string;
  voice?: string;
  model?: string;
}

export async function synthesizeSpeech(
  opts: SynthesizeSpeechOptions
): Promise<Buffer> {
  if (!opts.text.trim()) {
    throw new Error("Cannot synthesize empty text.");
  }
  const response = await getOpenAI().audio.speech.create({
    model: (opts.model ?? config.telegram.voiceModel) as never,
    voice: (opts.voice ?? config.telegram.voiceName) as never,
    input: opts.text,
    response_format: "mp3",
  });
  return Buffer.from(await response.arrayBuffer());
}
