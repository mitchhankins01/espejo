import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readScreenpipeChunks } from "../../src/ingest/screenpipe.js";

let tmp: string;
let dbPath: string;

function makeDb(opts: { withAudio?: boolean } = {}): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE frames (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      app_name TEXT,
      window_name TEXT
    );
    CREATE TABLE ocr_text (
      frame_id INTEGER NOT NULL,
      text TEXT
    );
  `);
  if (opts.withAudio !== false) {
    db.exec(`
      CREATE TABLE audio_chunks (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE audio_transcriptions (
        audio_chunk_id INTEGER NOT NULL,
        transcription TEXT
      );
    `);
  }
  return db;
}

function insertFrame(
  db: Database.Database,
  id: number,
  ts: string,
  app: string,
  win: string,
  ocr: string | null
): void {
  db.prepare(
    "INSERT INTO frames (id, timestamp, app_name, window_name) VALUES (?, ?, ?, ?)"
  ).run(id, ts, app, win);
  if (ocr !== null) {
    db.prepare("INSERT INTO ocr_text (frame_id, text) VALUES (?, ?)").run(
      id,
      ocr
    );
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sp-test-"));
  dbPath = join(tmp, "db.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readScreenpipeChunks", () => {
  it("returns [] when DB is missing", () => {
    expect(
      readScreenpipeChunks({ dbPath: join(tmp, "missing.db") })
    ).toEqual([]);
  });

  it("groups frames into one chunk per (app, window, 30s bucket)", () => {
    const db = makeDb();
    // Three frames in the same 30s bucket, same app+window.
    insertFrame(db, 1, "2026-05-03T10:00:01Z", "Code", "main.ts", "hello");
    insertFrame(db, 2, "2026-05-03T10:00:10Z", "Code", "main.ts", "hello"); // dup, deduped
    insertFrame(db, 3, "2026-05-03T10:00:20Z", "Code", "main.ts", "world");
    // Same app, next bucket — separate chunk.
    insertFrame(db, 4, "2026-05-03T10:00:35Z", "Code", "main.ts", "later");
    // Same bucket as #1 but different window — separate chunk.
    insertFrame(db, 5, "2026-05-03T10:00:05Z", "Code", "other.ts", "side");
    db.close();

    const chunks = readScreenpipeChunks({ dbPath });
    expect(chunks).toHaveLength(3);

    const main00 = chunks.find(
      (c) => c.window === "main.ts" && c.startedAt.getUTCSeconds() === 0
    )!;
    expect(main00.app).toBe("Code");
    expect(main00.ocrText).toBe("hello\nworld"); // dup collapsed
    expect(main00.data.frame_count).toBe(3);
    expect(main00.data.frame_id_min).toBe(1);
    expect(main00.data.frame_id_max).toBe(3);
    expect(main00.endedAt.getTime() - main00.startedAt.getTime()).toBe(30_000);
    expect(main00.sourceChunkId).toMatch(/^chunk:Code\|main\.ts\|\d+$/);

    const main30 = chunks.find(
      (c) => c.window === "main.ts" && c.startedAt.getUTCSeconds() === 30
    )!;
    expect(main30.ocrText).toBe("later");

    const other = chunks.find((c) => c.window === "other.ts")!;
    expect(other.ocrText).toBe("side");
  });

  it("drops chunks for sensitive apps and window titles", () => {
    const db = makeDb();
    insertFrame(db, 1, "2026-05-03T10:00:00Z", "1Password", "Vault", "secret");
    insertFrame(db, 2, "2026-05-03T10:00:30Z", "Messages", "Mom", "love you");
    insertFrame(
      db,
      3,
      "2026-05-03T10:01:00Z",
      "Chrome",
      "Account — chase.com",
      "balance"
    );
    insertFrame(db, 4, "2026-05-03T10:01:30Z", "Code", "main.ts", "kept");
    db.close();

    const chunks = readScreenpipeChunks({ dbPath });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].app).toBe("Code");
  });

  it("attaches overlapping audio transcriptions to the chunk", () => {
    const db = makeDb({ withAudio: true });
    insertFrame(db, 1, "2026-05-03T10:00:00Z", "Code", "main.ts", "ocr a");
    // Two audio chunks within the same 30s bucket as frame 1.
    db.prepare(
      "INSERT INTO audio_chunks (id, timestamp) VALUES (?, ?)"
    ).run(1, "2026-05-03T10:00:05Z");
    db.prepare(
      "INSERT INTO audio_chunks (id, timestamp) VALUES (?, ?)"
    ).run(2, "2026-05-03T10:00:20Z");
    db.prepare(
      "INSERT INTO audio_transcriptions (audio_chunk_id, transcription) VALUES (?, ?)"
    ).run(1, "first");
    db.prepare(
      "INSERT INTO audio_transcriptions (audio_chunk_id, transcription) VALUES (?, ?)"
    ).run(2, "second");
    // One audio chunk far outside any frame bucket — should not attach.
    db.prepare(
      "INSERT INTO audio_chunks (id, timestamp) VALUES (?, ?)"
    ).run(3, "2026-05-03T11:00:00Z");
    db.prepare(
      "INSERT INTO audio_transcriptions (audio_chunk_id, transcription) VALUES (?, ?)"
    ).run(3, "orphan");
    db.close();

    const chunks = readScreenpipeChunks({ dbPath });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].audioText).toBe("first\nsecond");
    expect(chunks[0].data.audio_chars).toBe("first\nsecond".length);
  });

  it("skips chunks with no OCR text and no audio", () => {
    const db = makeDb({ withAudio: true });
    // A frame with empty OCR and no audio — pure dwell, AW already covers it.
    insertFrame(db, 1, "2026-05-03T10:00:00Z", "Code", "main.ts", null);
    db.close();

    const chunks = readScreenpipeChunks({ dbPath });
    expect(chunks).toEqual([]);
  });

  it("filters by since", () => {
    const db = makeDb();
    insertFrame(db, 1, "2026-05-01T10:00:00Z", "Code", "main.ts", "old");
    insertFrame(db, 2, "2026-05-03T10:00:00Z", "Code", "main.ts", "new");
    db.close();

    const chunks = readScreenpipeChunks({
      dbPath,
      since: new Date("2026-05-02T00:00:00Z"),
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].ocrText).toBe("new");
  });

  it("source_chunk_id is stable across re-reads (idempotency key)", () => {
    const db = makeDb();
    insertFrame(db, 1, "2026-05-03T10:00:01Z", "Code", "main.ts", "hi");
    db.close();

    const a = readScreenpipeChunks({ dbPath });
    const b = readScreenpipeChunks({ dbPath });
    expect(a[0].sourceChunkId).toBe(b[0].sourceChunkId);
  });

  it("works when audio tables are absent", () => {
    const db = makeDb({ withAudio: false });
    insertFrame(db, 1, "2026-05-03T10:00:00Z", "Code", "main.ts", "hi");
    db.close();

    const chunks = readScreenpipeChunks({ dbPath });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].audioText).toBeNull();
  });
});
