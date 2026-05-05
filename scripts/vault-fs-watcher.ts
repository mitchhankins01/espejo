/**
 * vault-fs-watcher
 *
 * Reads newline-delimited FS events on stdin and writes them to vault_fs_events.
 *
 * Two upstream sources:
 *   --source fswatch    expects fswatch -x output (path + space-separated flags)
 *   --source eslogger   expects eslogger JSON, one object per line
 *
 * Why two sources:
 *   fswatch (brew, no sudo) gives us reliable path + event-type. eslogger
 *   (built-in macOS, root only) adds process attribution. Run both in parallel
 *   so the diagnostic stream is layered: fswatch tells us what changed, eslogger
 *   tells us who. See specs/Vault-Sync-Conflicts and Note/Vault Sync Conflicts —
 *   Problem Statement.md.
 *
 * Filters: only events under VAULT_ROOT (default ~/Documents/Artifacts) are
 * written; .obsidian/, .trash/, .smart-env/, .DS_Store, .git/ are dropped.
 *
 * Batching: events are flushed every BATCH_INTERVAL_MS or when BATCH_MAX_SIZE
 * is reached, whichever comes first. Final flush on stdin EOF.
 */
import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}

import readline from "readline";
import path from "path";
import os from "os";
import pg from "pg";
import {
  insertVaultFsEvents,
  type VaultFsEventInput,
} from "../src/db/queries/vault-fs.js";
import {
  parseFswatchLine,
  parseEsloggerLine,
} from "../src/obsidian/fs-event-parsers.js";

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://dev:dev@localhost:5434/journal_dev";

const VAULT_ROOT =
  process.env.VAULT_FS_ROOT || path.join(os.homedir(), "Documents", "Artifacts");

const BATCH_INTERVAL_MS = 2000;
const BATCH_MAX_SIZE = 100;

function parseArgs(argv: string[]): { source: "fswatch" | "eslogger" } {
  const idx = argv.indexOf("--source");
  if (idx === -1 || idx + 1 >= argv.length) {
    console.error(
      "[vault-fs-watcher] required: --source <fswatch|eslogger>"
    );
    process.exit(2);
  }
  const value = argv[idx + 1];
  if (value !== "fswatch" && value !== "eslogger") {
    console.error(`[vault-fs-watcher] unknown source: ${value}`);
    process.exit(2);
  }
  return { source: value };
}

async function main(): Promise<void> {
  const { source } = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: databaseUrl });

  const queue: VaultFsEventInput[] = [];
  let flushing = false;
  let totalWritten = 0;
  let totalDropped = 0;

  async function flush(): Promise<void> {
    if (flushing || queue.length === 0) return;
    flushing = true;
    const batch = queue.splice(0, queue.length);
    try {
      await insertVaultFsEvents(pool, batch);
      totalWritten += batch.length;
    } catch (err) {
      console.error("[vault-fs-watcher] flush failed:", err);
    } finally {
      flushing = false;
    }
  }

  const interval = setInterval(() => {
    void flush();
  }, BATCH_INTERVAL_MS);

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    const event =
      source === "fswatch"
        ? parseFswatchLine(line, VAULT_ROOT)
        : parseEsloggerLine(line, VAULT_ROOT);
    if (!event) {
      totalDropped++;
      return;
    }
    queue.push(event);
    if (queue.length >= BATCH_MAX_SIZE) void flush();
  });

  rl.on("close", async () => {
    clearInterval(interval);
    await flush();
    console.error(
      `[vault-fs-watcher] stream closed: source=${source} written=${totalWritten} dropped=${totalDropped}`
    );
    await pool.end();
  });

  // Periodic stats so the launchd log shows we're alive.
  setInterval(() => {
    console.error(
      `[vault-fs-watcher] heartbeat: source=${source} written=${totalWritten} dropped=${totalDropped} queued=${queue.length}`
    );
  }, 5 * 60_000).unref();

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, async () => {
      clearInterval(interval);
      await flush();
      await pool.end();
      process.exit(0);
    });
  }
}

void main();
