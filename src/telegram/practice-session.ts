import { randomUUID } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/client.js";
import { getMessagesSince, type ChatMessageRow } from "../db/queries/chat.js";
import { upsertObsidianArtifact } from "../db/queries/obsidian.js";
import { config } from "../config.js";
import { createClient, putObjectContent } from "../storage/r2.js";
import {
  ESPANOL_VIVO_PATH,
  EXTRACTION_PROMPT,
  getEspanolVivoBody,
} from "../prompts/spanish-practice.js";
import { getAnthropic } from "./agent/constants.js";

const VAULT_BUCKET = "artifacts";

interface PracticeSession {
  sessionId: string;
  startedAt: Date;
}

const activeSessions = new Map<string, PracticeSession>();

export function startPracticeSession(chatId: string): PracticeSession {
  const session: PracticeSession = {
    sessionId: randomUUID().slice(0, 8),
    startedAt: new Date(),
  };
  activeSessions.set(chatId, session);
  return session;
}

export function endPracticeSession(chatId: string): PracticeSession | null {
  const session = activeSessions.get(chatId) ?? null;
  activeSessions.delete(chatId);
  return session;
}

export function getPracticeSession(chatId: string): PracticeSession | null {
  return activeSessions.get(chatId) ?? null;
}

export function isPracticeSessionActive(chatId: string): boolean {
  return activeSessions.has(chatId);
}

function formatTranscript(messages: ChatMessageRow[]): string {
  return messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");
}

export interface ExtractionResult {
  diffSummary: string;
  messageCount: number;
  wrotePersisted: boolean;
  error?: string;
}

/**
 * Run post-session extraction: read transcript, propose updates, write back
 * to R2 and Postgres. Non-destructive on failure — original state is untouched.
 */
export async function runPracticeExtraction(
  chatId: string,
  session: PracticeSession
): Promise<ExtractionResult> {
  const messages = await getMessagesSince(pool, chatId, session.startedAt);

  if (messages.length === 0) {
    return {
      diffSummary: "No messages in this session — nothing to extract.",
      messageCount: 0,
      wrotePersisted: false,
    };
  }

  const currentBody = await getEspanolVivoBody(pool);
  if (!currentBody) {
    return {
      diffSummary: `Could not find ${ESPANOL_VIVO_PATH} in Obsidian sync. State not updated.`,
      messageCount: messages.length,
      wrotePersisted: false,
    };
  }

  const transcript = formatTranscript(messages);
  const userMessage = `CURRENT ESPAÑOL VIVO.md:\n\n${currentBody}\n\n---\n\nSESSION ID: ${session.sessionId}\nSESSION STARTED: ${session.startedAt.toISOString()}\n\nTRANSCRIPT:\n\n${transcript}`;

  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 8192,
    system: EXTRACTION_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  const raw = textBlocks.map((b) => b.text).join("\n").trim();

  const parsed = parseExtractionJson(raw);
  if (!parsed) {
    return {
      diffSummary: "Extraction returned unparseable output. Raw:\n" + raw.slice(0, 500),
      messageCount: messages.length,
      wrotePersisted: false,
    };
  }

  const { updated_body, diff_summary } = parsed;

  // Write back to R2 (source of truth for Obsidian vault)
  try {
    const r2Client = createClient();
    await putObjectContent(r2Client, VAULT_BUCKET, ESPANOL_VIVO_PATH, updated_body);
  } catch (err) {
    return {
      diffSummary: `Extraction succeeded but R2 write failed: ${err instanceof Error ? err.message : String(err)}`,
      messageCount: messages.length,
      wrotePersisted: false,
    };
  }

  // Update Postgres copy immediately so the next session sees the new state
  // without waiting for the scheduled obsidian sync.
  try {
    await upsertObsidianArtifact(pool, {
      sourcePath: ESPANOL_VIVO_PATH,
      title: "Español Vivo",
      body: updated_body,
      kind: "project",
      contentHash: `practice-${session.sessionId}-${Date.now()}`,
    });
  } catch (err) {
    console.error(`[practice-session] Postgres update failed for ${chatId}:`, err);
  }

  return {
    diffSummary: diff_summary,
    messageCount: messages.length,
    wrotePersisted: true,
  };
}

function parseExtractionJson(
  raw: string
): { updated_body: string; diff_summary: string } | null {
  // Strip common code fence wrappers the model sometimes adds
  const stripped = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const obj = JSON.parse(stripped) as unknown;
    if (
      typeof obj === "object" &&
      obj !== null &&
      "updated_body" in obj &&
      "diff_summary" in obj &&
      typeof (obj as Record<string, unknown>).updated_body === "string" &&
      typeof (obj as Record<string, unknown>).diff_summary === "string"
    ) {
      return {
        updated_body: (obj as { updated_body: string }).updated_body,
        diff_summary: (obj as { diff_summary: string }).diff_summary,
      };
    }
    return null;
  } catch {
    return null;
  }
}
