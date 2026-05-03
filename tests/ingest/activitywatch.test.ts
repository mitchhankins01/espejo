import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readActivityWatchEvents } from "../../src/ingest/activitywatch.js";

let tmp: string;
let dbPath: string;

function makeDb(): Database.Database {
  const db = new Database(dbPath);
  // Mirror peewee's actual layout: bucketmodel.key is the INTEGER PK,
  // bucketmodel.id is the string bucket name. eventmodel.bucket_id FKs key.
  db.exec(`
    CREATE TABLE bucketmodel (
      key INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      created TEXT NOT NULL,
      name TEXT,
      type TEXT NOT NULL,
      client TEXT NOT NULL,
      hostname TEXT NOT NULL,
      datastr TEXT
    );
    CREATE TABLE eventmodel (
      id INTEGER PRIMARY KEY,
      bucket_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      duration REAL NOT NULL,
      datastr TEXT NOT NULL
    );
  `);
  return db;
}

function insertBucket(
  db: Database.Database,
  key: number,
  id: string,
  type: string,
  hostname: string
): void {
  db.prepare(
    "INSERT INTO bucketmodel (key, id, created, type, client, hostname) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(key, id, "2026-05-01T00:00:00+00:00", type, id.split("_")[0], hostname);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aw-test-"));
  dbPath = join(tmp, "peewee-sqlite.v2.db");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readActivityWatchEvents", () => {
  it("returns [] when DB is missing", () => {
    expect(readActivityWatchEvents({ dbPath: join(tmp, "missing.db") })).toEqual([]);
  });

  it("normalizes window, web, and afk buckets", () => {
    const db = makeDb();
    insertBucket(db, 1, "aw-watcher-window_h", "currentwindow", "h");
    insertBucket(db, 2, "aw-watcher-web-firefox", "web.tab.current", "h");
    insertBucket(db, 3, "aw-watcher-afk_h", "afkstatus", "h");

    db.prepare("INSERT INTO eventmodel VALUES (10, 1, ?, ?, ?)").run(
      "2026-05-02T10:00:00.000+00:00",
      120.5,
      JSON.stringify({ app: "Code", title: "espejo — main.ts" })
    );
    db.prepare("INSERT INTO eventmodel VALUES (11, 2, ?, ?, ?)").run(
      "2026-05-02T10:05:00.000+00:00",
      30,
      JSON.stringify({ url: "https://news.ycombinator.com/item?id=1", title: "HN", app: "Firefox" })
    );
    db.prepare("INSERT INTO eventmodel VALUES (12, 3, ?, ?, ?)").run(
      "2026-05-02T10:10:00.000+00:00",
      60,
      JSON.stringify({ status: "not-afk" })
    );
    db.close();

    const out = readActivityWatchEvents({ dbPath });
    expect(out).toHaveLength(3);
    const window = out.find((e) => e.bucket === "window")!;
    expect(window.app).toBe("Code");
    expect(window.title).toBe("espejo — main.ts");
    expect(window.durationMs).toBe(120500);
    expect(window.endedAt).not.toBeNull();
    expect(window.sourceEventId).toBe("aw-watcher-window_h/10");
    expect(window.hostname).toBe("h");

    const web = out.find((e) => e.bucket === "web")!;
    expect(web.url).toBe("https://news.ycombinator.com/item?id=1");
    expect(web.hostname).toBe("news.ycombinator.com");
    expect(web.app).toBe("Firefox");

    const afk = out.find((e) => e.bucket === "afk")!;
    expect(afk.app).toBeNull();
    expect(afk.data).toEqual({ status: "not-afk" });
  });

  it("redacts sensitive hosts to protocol+host only and drops password-manager titles", () => {
    const db = makeDb();
    insertBucket(db, 1, "aw-watcher-window_h", "currentwindow", "h");
    insertBucket(db, 2, "aw-watcher-web-firefox", "web.tab.current", "h");

    db.prepare("INSERT INTO eventmodel VALUES (1, 1, ?, ?, ?)").run(
      "2026-05-02T10:00:00.000+00:00",
      30,
      JSON.stringify({ app: "1Password", title: "Vault — Personal" })
    );
    db.prepare("INSERT INTO eventmodel VALUES (2, 2, ?, ?, ?)").run(
      "2026-05-02T10:00:00.000+00:00",
      30,
      JSON.stringify({ url: "https://secure.chase.com/account/123?token=abc", title: "Chase" })
    );
    db.prepare("INSERT INTO eventmodel VALUES (3, 2, ?, ?, ?)").run(
      "2026-05-02T10:01:00.000+00:00",
      30,
      JSON.stringify({ url: "https://example.com/page?q=1", title: "ok", incognito: true })
    );
    db.close();

    const out = readActivityWatchEvents({ dbPath });
    // incognito web event dropped
    expect(out).toHaveLength(2);
    const pw = out.find((e) => e.app === "1Password")!;
    expect(pw.title).toBeNull();
    const chase = out.find((e) => e.bucket === "web")!;
    expect(chase.url).toBe("https://secure.chase.com");
    expect(chase.hostname).toBe("secure.chase.com");
  });

  it("filters by since (lex compare on ISO)", () => {
    const db = makeDb();
    insertBucket(db, 1, "aw-watcher-window_h", "currentwindow", "h");
    db.prepare("INSERT INTO eventmodel VALUES (1, 1, ?, ?, ?)").run(
      "2026-05-01T10:00:00.000Z",
      10,
      JSON.stringify({ app: "A", title: "old" })
    );
    db.prepare("INSERT INTO eventmodel VALUES (2, 1, ?, ?, ?)").run(
      "2026-05-03T10:00:00.000Z",
      10,
      JSON.stringify({ app: "B", title: "new" })
    );
    db.close();

    const out = readActivityWatchEvents({
      dbPath,
      since: new Date("2026-05-02T00:00:00Z"),
    });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("new");
  });
});
