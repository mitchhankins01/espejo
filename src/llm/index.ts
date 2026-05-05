export { chat } from "./chat.js";
export type {
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ToolCallEvent,
  ToolResultEvent,
} from "./chat.js";

export { embedText, embedTextSimple } from "./embed.js";
export type { EmbedResult } from "./embed.js";

export { transcribeAudio } from "./transcribe.js";
export type { TranscribeOptions } from "./transcribe.js";

export {
  extractTextFromImage as visionExtractText,
  extractTextFromPdf as visionExtractPdfText,
} from "./vision.js";

export { synthesizeSpeech } from "./tts.js";
export type { SynthesizeSpeechOptions } from "./tts.js";
