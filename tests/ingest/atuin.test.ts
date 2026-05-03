import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readAtuinHistory } from "../../src/ingest/atuin.js";

let tmp: string;
let dbPath: string;

function makeDb(): Database.Database {
  const db = new Database(dbPath);
  // Mirror atuin's history table (current shape: post-deleted_at migration).
  db.exec(`
    CREATE TABLE history (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      exit INTEGER NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      session TEXT NOT NULL,
      hostname TEXT NOT NULL,
      deleted_at INTEGER
    );
  `);
  return db;
}

const insert = (
  db: Database.Database,
  row: {
    id: string;
    timestamp: bigint;
    duration: bigint;
    exit: number;
    command: string;
    cwd?: string;
    session?: string;
    hostname?: string;
    deleted_at?: number | null;
  }
): void => {
  db.prepare(
    "INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    row.id,
    row.timestamp.toString(),
    row.duration.toString(),
    row.exit,
    row.command,
    row.cwd ?? "/Users/mitch",
    row.session ?? "sess1",
    row.hostname ?? "mitch-mbp",
    row.deleted_at ?? null
  );
};

// Helper: epoch nanoseconds for an ISO date string.
const ns = (iso: string): bigint => BigInt(new Date(iso).getTime()) * 1_000_000n;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atuin-test-"));
  dbPath = join(tmp, "history.db");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readAtuinHistory", () => {
  it("returns [] when DB is missing", () => {
    expect(readAtuinHistory({ dbPath: join(tmp, "missing.db") })).toEqual([]);
  });

  it("normalizes timestamp/duration from ns and extracts the verb", () => {
    const db = makeDb();
    insert(db, {
      id: "a1",
      timestamp: ns("2026-05-02T10:00:00.000Z"),
      duration: 1_500_000_000n, // 1.5s
      exit: 0,
      command: "git status",
      cwd: "/Users/mitch/Projects/espejo",
      hostname: "mitch-mbp",
    });
    db.close();

    const out = readAtuinHistory({ dbPath });
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row.ts.toISOString()).toBe("2026-05-02T10:00:00.000Z");
    expect(row.durationMs).toBe(1500);
    expect(row.verb).toBe("git");
    expect(row.cmd).toBe("git status");
    expect(row.exit).toBe(0);
    expect(row.atuinId).toBe("a1");
    expect(row.hostname).toBe("mitch-mbp");
    expect(row.cwd).toBe("/Users/mitch/Projects/espejo");
  });

  it("filters by since (ns comparison)", () => {
    const db = makeDb();
    insert(db, {
      id: "old",
      timestamp: ns("2026-05-01T10:00:00Z"),
      duration: 0n,
      exit: 0,
      command: "ls",
    });
    insert(db, {
      id: "new",
      timestamp: ns("2026-05-03T10:00:00Z"),
      duration: 0n,
      exit: 0,
      command: "pwd",
    });
    db.close();

    const out = readAtuinHistory({
      dbPath,
      since: new Date("2026-05-02T00:00:00Z"),
    });
    expect(out).toHaveLength(1);
    expect(out[0].atuinId).toBe("new");
  });

  it("drops tombstoned rows", () => {
    const db = makeDb();
    insert(db, {
      id: "live",
      timestamp: ns("2026-05-02T10:00:00Z"),
      duration: 0n,
      exit: 0,
      command: "ls",
    });
    insert(db, {
      id: "gone",
      timestamp: ns("2026-05-02T10:01:00Z"),
      duration: 0n,
      exit: 0,
      command: "rm secrets.txt",
      deleted_at: 123,
    });
    db.close();

    const out = readAtuinHistory({ dbPath });
    expect(out.map((r) => r.atuinId)).toEqual(["live"]);
  });

  it("drops commands that look like they carry secrets", () => {
    const db = makeDb();
    insert(db, {
      id: "1",
      timestamp: ns("2026-05-02T10:00:00Z"),
      duration: 0n,
      exit: 0,
      command: "API_KEY=xyz npm run start",
    });
    insert(db, {
      id: "2",
      timestamp: ns("2026-05-02T10:01:00Z"),
      duration: 0n,
      exit: 0,
      command: "echo password=hunter2 | base64",
    });
    insert(db, {
      id: "3",
      timestamp: ns("2026-05-02T10:02:00Z"),
      duration: 0n,
      exit: 0,
      command: "vault read secret: my/path",
    });
    insert(db, {
      id: "4",
      timestamp: ns("2026-05-02T10:03:00Z"),
      duration: 0n,
      exit: 0,
      command: "psql -U mitch espejo -c 'select count(*) from entries'",
    });
    db.close();

    const out = readAtuinHistory({ dbPath });
    // Only the benign psql command survives; the three secret-shaped ones drop.
    expect(out.map((r) => r.atuinId)).toEqual(["4"]);
  });

  it("truncates very long commands and clamps negative duration to 0", () => {
    const db = makeDb();
    const huge = "echo " + "x".repeat(10_000);
    insert(db, {
      id: "huge",
      timestamp: ns("2026-05-02T10:00:00Z"),
      duration: -1n, // atuin sentinel for unfinished commands
      exit: 0,
      command: huge,
    });
    db.close();

    const out = readAtuinHistory({ dbPath });
    expect(out).toHaveLength(1);
    expect(out[0].cmd.length).toBe(4096);
    expect(out[0].durationMs).toBe(0);
    expect(out[0].verb).toBe("echo");
  });

  it("skips empty/whitespace-only commands", () => {
    const db = makeDb();
    insert(db, {
      id: "blank",
      timestamp: ns("2026-05-02T10:00:00Z"),
      duration: 0n,
      exit: 0,
      command: "   ",
    });
    insert(db, {
      id: "real",
      timestamp: ns("2026-05-02T10:01:00Z"),
      duration: 0n,
      exit: 0,
      command: "ls",
    });
    db.close();

    const out = readAtuinHistory({ dbPath });
    expect(out.map((r) => r.atuinId)).toEqual(["real"]);
  });
});
