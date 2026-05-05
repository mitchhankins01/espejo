import { describe, it, expect } from "vitest";
import {
  parseFswatchLine,
  parseEsloggerLine,
  shouldSkipVaultPath,
} from "../../src/obsidian/fs-event-parsers.js";

const ROOT = "/Users/test/Documents/Artifacts";

describe("shouldSkipVaultPath", () => {
  it("skips paths outside the vault root", () => {
    expect(shouldSkipVaultPath("/tmp/foo.md", ROOT)).toBe(true);
  });
  it("skips obsidian metadata folders", () => {
    expect(
      shouldSkipVaultPath(`${ROOT}/.obsidian/workspace.json`, ROOT)
    ).toBe(true);
  });
  it("skips the trash folder", () => {
    expect(shouldSkipVaultPath(`${ROOT}/.trash/old.md`, ROOT)).toBe(true);
  });
  it("skips DS_Store", () => {
    expect(shouldSkipVaultPath(`${ROOT}/Note/.DS_Store`, ROOT)).toBe(true);
  });
  it("keeps real vault paths", () => {
    expect(shouldSkipVaultPath(`${ROOT}/Note/Foo.md`, ROOT)).toBe(false);
  });
});

describe("parseFswatchLine", () => {
  it("parses an unlink event", () => {
    const line = `${ROOT}/Note/Foo.md Removed IsFile`;
    expect(parseFswatchLine(line, ROOT)).toEqual({
      source: "fswatch",
      eventType: "unlink",
      path: `${ROOT}/Note/Foo.md`,
      raw: { flags: ["Removed", "IsFile"] },
    });
  });

  it("parses a create event", () => {
    const line = `${ROOT}/Note/Bar.md Created IsFile`;
    const e = parseFswatchLine(line, ROOT);
    expect(e?.eventType).toBe("create");
    expect(e?.path).toBe(`${ROOT}/Note/Bar.md`);
  });

  it("parses a rename as rename when Renamed flag present", () => {
    const line = `${ROOT}/Note/Bar.md Renamed IsFile`;
    expect(parseFswatchLine(line, ROOT)?.eventType).toBe("rename");
  });

  it("parses an updated file as modify", () => {
    const line = `${ROOT}/Note/Bar.md Updated IsFile`;
    expect(parseFswatchLine(line, ROOT)?.eventType).toBe("modify");
  });

  it("Removed wins over Created when both present (Remotely Save churn)", () => {
    const line = `${ROOT}/Note/Foo.md Created Removed IsFile`;
    expect(parseFswatchLine(line, ROOT)?.eventType).toBe("unlink");
  });

  it("handles paths with spaces", () => {
    const line = `${ROOT}/Note/My Long File Name.md Removed IsFile`;
    expect(parseFswatchLine(line, ROOT)?.path).toBe(
      `${ROOT}/Note/My Long File Name.md`
    );
  });

  it("drops directory modify events", () => {
    const line = `${ROOT}/Note Updated IsDir`;
    expect(parseFswatchLine(line, ROOT)).toBeNull();
  });

  it("drops xattr-only churn", () => {
    const line = `${ROOT}/Note/Foo.md XattrModified`;
    expect(parseFswatchLine(line, ROOT)).toBeNull();
  });

  it("drops paths outside the vault root", () => {
    const line = `/tmp/elsewhere.md Removed IsFile`;
    expect(parseFswatchLine(line, ROOT)).toBeNull();
  });

  it("drops obsidian metadata churn", () => {
    const line = `${ROOT}/.obsidian/workspace.json Updated IsFile`;
    expect(parseFswatchLine(line, ROOT)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parseFswatchLine("", ROOT)).toBeNull();
    expect(parseFswatchLine("   ", ROOT)).toBeNull();
  });

  it("returns null when no flags detected", () => {
    expect(parseFswatchLine(`${ROOT}/Note/foo.md`, ROOT)).toBeNull();
  });

  it("falls through to 'other' when flag is unrecognized", () => {
    const line = `${ROOT}/Note/Foo.md SomeNewFlag IsFile`;
    expect(parseFswatchLine(line, ROOT)?.eventType).toBe("other");
  });
});

describe("parseEsloggerLine", () => {
  it("parses an unlink with process attribution", () => {
    const json = JSON.stringify({
      event: { unlink: { target: { path: `${ROOT}/Note/Foo.md` } } },
      process: {
        executable: { path: "/Applications/Obsidian.app/Contents/MacOS/Obsidian" },
        audit_token: { pid: 1234 },
        original_ppid: 1,
      },
    });
    expect(parseEsloggerLine(json, ROOT)).toEqual({
      source: "eslogger",
      eventType: "unlink",
      path: `${ROOT}/Note/Foo.md`,
      processName: "Obsidian",
      pid: 1234,
      ppid: 1,
      raw: {
        exe: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
        original_ppid: 1,
      },
    });
  });

  it("parses a create event with new_path destination", () => {
    const json = JSON.stringify({
      event: {
        create: {
          destination: {
            new_path: {
              dir: { path: `${ROOT}/Note` },
              filename: "Bar.md",
            },
          },
        },
      },
      process: {
        executable: { path: "/usr/bin/touch" },
        audit_token: { pid: 999 },
      },
    });
    const e = parseEsloggerLine(json, ROOT);
    expect(e?.eventType).toBe("create");
    expect(e?.path).toBe(`${ROOT}/Note/Bar.md`);
    expect(e?.processName).toBe("touch");
  });

  it("parses a create event with existing_file destination", () => {
    const json = JSON.stringify({
      event: {
        create: {
          destination: { existing_file: { path: `${ROOT}/Note/Bar.md` } },
        },
      },
      process: { executable: { path: "/bin/cp" } },
    });
    expect(parseEsloggerLine(json, ROOT)?.path).toBe(`${ROOT}/Note/Bar.md`);
  });

  it("parses a rename event with destination", () => {
    const json = JSON.stringify({
      event: {
        rename: {
          source: { path: `${ROOT}/Note/Old.md` },
          destination: {
            new_path: { dir: { path: `${ROOT}/Note` }, filename: "New.md" },
          },
        },
      },
      process: { executable: { path: "/bin/mv" } },
    });
    const e = parseEsloggerLine(json, ROOT);
    expect(e?.eventType).toBe("rename");
    expect(e?.path).toBe(`${ROOT}/Note/New.md`);
  });

  it("falls back to source path when rename has no destination", () => {
    const json = JSON.stringify({
      event: {
        rename: {
          source: { path: `${ROOT}/Note/Old.md` },
          destination: {},
        },
      },
    });
    expect(parseEsloggerLine(json, ROOT)?.path).toBe(`${ROOT}/Note/Old.md`);
  });

  it("returns null on malformed JSON", () => {
    expect(parseEsloggerLine("{not json", ROOT)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parseEsloggerLine("", ROOT)).toBeNull();
  });

  it("returns null when path falls outside the vault root", () => {
    const json = JSON.stringify({
      event: { unlink: { target: { path: "/tmp/elsewhere.md" } } },
    });
    expect(parseEsloggerLine(json, ROOT)).toBeNull();
  });

  it("returns null when event has no recognized shape", () => {
    expect(parseEsloggerLine(JSON.stringify({}), ROOT)).toBeNull();
  });

  it("returns null when create destination yields no path", () => {
    const json = JSON.stringify({ event: { create: { destination: {} } } });
    expect(parseEsloggerLine(json, ROOT)).toBeNull();
  });

  it("prefers parent_audit_token.pid over original_ppid for ppid", () => {
    const json = JSON.stringify({
      event: { unlink: { target: { path: `${ROOT}/Note/Foo.md` } } },
      process: {
        executable: { path: "/bin/zsh" },
        parent_audit_token: { pid: 42 },
        original_ppid: 1,
      },
    });
    expect(parseEsloggerLine(json, ROOT)?.ppid).toBe(42);
  });
});
