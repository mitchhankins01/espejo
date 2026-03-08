import type pg from "pg";
import crypto from "crypto";
import { validateToolInput } from "../../specs/tools.spec.js";
import { extractPatternsFromChat, rememberPattern } from "../memory/extraction.js";

export async function handleSaveChat(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("save_chat", input);

  const extracted = await extractPatternsFromChat(pool, {
    messages: params.messages,
    context: params.context,
  });

  let stored = 0;
  let reinforced = 0;
  const skipped = 0;
  const sourceId = crypto.createHash("sha256").update(params.messages).digest("hex").slice(0, 24);

  for (const pattern of extracted) {
    const result = await rememberPattern(pool, {
      content: pattern.content,
      kind: pattern.kind,
      confidence: pattern.confidence,
      evidence: pattern.evidence,
      entryUuids: pattern.entry_uuids,
      temporal: pattern.temporal,
      sourceType: "mcp_chat_archive",
      sourceId: `save_chat:${sourceId}`,
    });

    if (result.action === "inserted") {
      stored++;
    } else {
      reinforced++;
    }
  }

  return JSON.stringify(
    {
      extracted: extracted.length,
      stored,
      reinforced,
      skipped,
      patterns: extracted,
    },
    null,
    2
  );
}
