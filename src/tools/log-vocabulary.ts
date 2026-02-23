import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { upsertSpanishVocabulary, upsertSpanishProgressSnapshot } from "../db/queries.js";
import { config } from "../config.js";

function todayInTimezone(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function handleLogVocabulary(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("log_vocabulary", input);
  const { row, inserted } = await upsertSpanishVocabulary(pool, {
    chatId: params.chat_id,
    word: params.word,
    translation: params.translation,
    partOfSpeech: params.part_of_speech,
    region: params.region,
    exampleSentence: params.example_sentence,
    notes: params.notes,
    source: params.source,
  });
  await upsertSpanishProgressSnapshot(pool, params.chat_id, todayInTimezone());

  return JSON.stringify(
    {
      status: inserted ? "created" : "updated",
      vocabulary: {
        id: row.id,
        word: row.word,
        translation: row.translation,
        region: row.region || null,
        part_of_speech: row.part_of_speech,
        state: row.state,
      },
    },
    null,
    2
  );
}

