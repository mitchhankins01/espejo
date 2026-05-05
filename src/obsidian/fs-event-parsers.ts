/**
 * Parsers for FS-event streams (fswatch -x output, eslogger JSON). Pulled out
 * of scripts/vault-fs-watcher.ts so they're unit-testable independently of
 * stdin / Postgres / launchd.
 *
 * Both parsers normalize to VaultFsEventInput (without ts) and apply the
 * shared shouldSkip filter. Watcher tops them up with `process` attribution
 * (eslogger) before insert.
 */
import path from "path";
import type {
  VaultFsEventInput,
  VaultFsEventType,
} from "../db/queries/vault-fs.js";

const SKIP_PATH_FRAGMENTS = [
  "/.obsidian/",
  "/.trash/",
  "/.smart-env/",
  "/.git/",
  "/.claude/",
  "/.DS_Store",
];

export function shouldSkipVaultPath(absPath: string, vaultRoot: string): boolean {
  if (!absPath.startsWith(vaultRoot)) return true;
  return SKIP_PATH_FRAGMENTS.some((frag) => absPath.includes(frag));
}

/**
 * fswatch -x emits "PATH FLAG1 FLAG2 ...". Flags are CamelCase. Map to
 * eventType in priority Removed > Renamed > Created > Updated. Drop:
 *   - directory Updated events (chatty noise)
 *   - xattr-only / owner-only modifications
 */
export function parseFswatchLine(
  line: string,
  vaultRoot: string
): VaultFsEventInput | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  let flagStart = tokens.length;
  while (flagStart > 0 && /^[A-Z][a-zA-Z]+$/.test(tokens[flagStart - 1])) {
    flagStart--;
  }
  if (flagStart === tokens.length || flagStart === 0) return null;
  const absPath = tokens.slice(0, flagStart).join(" ");
  const flags = tokens.slice(flagStart);
  if (shouldSkipVaultPath(absPath, vaultRoot)) return null;

  let eventType: VaultFsEventType;
  if (flags.includes("Removed")) eventType = "unlink";
  else if (flags.includes("Renamed")) eventType = "rename";
  else if (flags.includes("Created")) eventType = "create";
  else if (flags.includes("Updated")) eventType = "modify";
  else eventType = "other";

  const isDir = flags.includes("IsDir");
  if (eventType === "modify" && isDir) return null;
  if (
    flags.length === 1 &&
    (flags[0] === "OwnerModified" ||
      flags[0] === "AttributeModified" ||
      flags[0] === "XattrModified")
  )
    return null;

  return {
    source: "fswatch",
    eventType,
    path: absPath,
    raw: { flags },
  };
}

interface EsloggerEvent {
  event?: {
    create?: {
      destination?: {
        existing_file?: { path?: string };
        new_path?: { dir?: { path?: string }; filename?: string };
      };
    };
    unlink?: { target?: { path?: string } };
    rename?: {
      source?: { path?: string };
      destination?: {
        existing_file?: { path?: string };
        new_path?: { dir?: { path?: string }; filename?: string };
      };
    };
  };
  process?: {
    executable?: { path?: string };
    audit_token?: { pid?: number };
    original_ppid?: number;
    parent_audit_token?: { pid?: number };
  };
}

function pickEsloggerPath(ev: EsloggerEvent): {
  type: VaultFsEventType;
  path: string | null;
} {
  const e = ev.event ?? {};
  if (e.create) {
    const d = e.create.destination ?? {};
    const p =
      d.existing_file?.path ??
      (d.new_path?.dir?.path && d.new_path.filename
        ? path.join(d.new_path.dir.path, d.new_path.filename)
        : null);
    return { type: "create", path: p };
  }
  if (e.unlink) return { type: "unlink", path: e.unlink.target?.path ?? null };
  if (e.rename) {
    const d = e.rename.destination ?? {};
    const p =
      d.existing_file?.path ??
      (d.new_path?.dir?.path && d.new_path.filename
        ? path.join(d.new_path.dir.path, d.new_path.filename)
        : null) ??
      e.rename.source?.path ??
      null;
    return { type: "rename", path: p };
  }
  return { type: "other", path: null };
}

/**
 * eslogger emits one JSON object per line. We extract the path (event-shape
 * varies) plus process attribution and drop the rest. Returns null on parse
 * failure or skip-path.
 */
export function parseEsloggerLine(
  line: string,
  vaultRoot: string
): VaultFsEventInput | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: EsloggerEvent;
  try {
    parsed = JSON.parse(trimmed) as EsloggerEvent;
  } catch {
    return null;
  }
  const { type, path: absPath } = pickEsloggerPath(parsed);
  if (!absPath || shouldSkipVaultPath(absPath, vaultRoot)) return null;
  const exe = parsed.process?.executable?.path ?? null;
  return {
    source: "eslogger",
    eventType: type,
    path: absPath,
    processName: exe ? path.basename(exe) : null,
    pid: parsed.process?.audit_token?.pid ?? null,
    ppid:
      parsed.process?.parent_audit_token?.pid ??
      parsed.process?.original_ppid ??
      null,
    raw: { exe, original_ppid: parsed.process?.original_ppid },
  };
}
