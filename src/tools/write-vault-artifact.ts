import { createHash } from "crypto";
import type pg from "pg";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { validateToolInput } from "../../specs/tools.spec.js";
import { createClient, putObjectContent } from "../storage/r2.js";
import { upsertObsidianArtifact } from "../db/queries/obsidian.js";
import { parseObsidianNote } from "../obsidian/parser.js";
import { logUsage } from "../db/queries/usage.js";

const VAULT_BUCKET = "artifacts";
const FRONTMATTER_HEAD_LIMIT = 200;

function hasFrontmatter(content: string): boolean {
  const head = content.slice(0, FRONTMATTER_HEAD_LIMIT);
  if (!head.startsWith("---")) return false;
  return /^---\s*\n[\s\S]*?\bkind\s*:/m.test(head);
}

async function objectExists(
  client: ReturnType<typeof createClient>,
  bucket: string,
  key: string
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

export async function handleWriteVaultArtifact(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("write_vault_artifact", input);

  if (!hasFrontmatter(params.content)) {
    throw new Error(
      "Frontmatter required: file must start with `---\\nkind: ...\\n---` block."
    );
  }

  const parsed = parseObsidianNote(params.content, params.path);
  if (!parsed.kind) {
    throw new Error("Frontmatter `kind` could not be resolved from the content.");
  }

  const r2 = createClient();

  if (!params.overwrite) {
    const exists = await objectExists(r2, VAULT_BUCKET, params.path);
    if (exists) {
      throw new Error(
        `Refusing to overwrite existing vault file ${params.path} (set overwrite: true).`
      );
    }
  }

  await putObjectContent(r2, VAULT_BUCKET, params.path, params.content);

  const contentHash = createHash("sha256").update(params.content).digest("hex");
  try {
    await upsertObsidianArtifact(pool, {
      sourcePath: params.path,
      title: parsed.title,
      body: parsed.body,
      kind: parsed.kind,
      contentHash,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logUsage(pool, {
      source: "mcp",
      surface: "write_vault_artifact",
      action: "db_upsert_failed",
      args: { path: params.path },
      ok: false,
      error: message,
    });
    // Soft-fail: R2 already has the canonical file, the timer will reconcile.
  }

  return `Wrote ${params.path}.`;
}
