/**
 * One-off scratch helper for the Curate-vs-Extract council A/B test.
 *
 * Usage:
 *   NODE_ENV=production tsx scripts/_stage-pending.ts --dir <srcDir> --action stage
 *   NODE_ENV=production tsx scripts/_stage-pending.ts --dir <srcDir> --action unstage
 *
 * Stage: writes each <srcDir>/*.md into Artifacts/Pending/, R2 (bucket=artifacts,
 * key=Pending/<filename>), and knowledge_artifacts via upsertObsidianArtifact().
 * content_hash = MD5(body) — matches R2's etag for non-multipart PUTs so the
 * scheduled obsidian sync sees "no change, skip" rather than re-running upsert
 * with embedding=NULL and clobbering the just-generated embedding.
 *
 * Unstage: rm local + R2 delete + DB hard-delete by source_path. Symmetric.
 *
 * Delete after the test — this is intentionally not in src/ or wired into specs.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import "dotenv/config";
import { pool } from "../src/db/client.js";
import { upsertObsidianArtifact } from "../src/db/queries/obsidian.js";
import { createClient, putObjectContent } from "../src/storage/r2.js";
import { parseObsidianNote } from "../src/obsidian/parser.js";

const args = process.argv.slice(2);
const arg = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const srcDir = arg("--dir");
const action = arg("--action") || "stage";

if (!srcDir) {
  console.error("usage: tsx scripts/_stage-pending.ts --dir <srcDir> --action <stage|unstage>");
  process.exit(1);
}
if (action !== "stage" && action !== "unstage") {
  console.error(`unknown action: ${action} (use stage|unstage)`);
  process.exit(1);
}

const VAULT_PENDING = "Artifacts/Pending";
const VAULT_BUCKET = "artifacts";
const r2 = createClient();

const files = readdirSync(srcDir).filter((f) => f.endsWith(".md"));
console.log(`${action}: ${files.length} files from ${srcDir}`);

async function stage(f: string): Promise<void> {
  const body = readFileSync(join(srcDir, f), "utf8");
  const localPath = join(VAULT_PENDING, f);
  const r2Key = `Pending/${f}`;

  writeFileSync(localPath, body);
  await putObjectContent(r2, VAULT_BUCKET, r2Key, body);

  const parsed = parseObsidianNote(body, r2Key);
  const md5 = createHash("md5").update(body).digest("hex");
  const id = await upsertObsidianArtifact(pool, {
    sourcePath: r2Key,
    title: parsed.title,
    body: parsed.body,
    kind: parsed.kind,
    contentHash: md5,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  });
  console.log(`  + ${f.slice(0, 70)} → ${id.slice(0, 8)}`);
}

async function unstage(f: string): Promise<void> {
  const localPath = join(VAULT_PENDING, f);
  const r2Key = `Pending/${f}`;

  if (existsSync(localPath)) unlinkSync(localPath);
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: VAULT_BUCKET, Key: r2Key }));
  } catch (err) {
    console.warn(`  ⚠️ R2 delete failed for ${f}: ${err instanceof Error ? err.message : err}`);
  }
  await pool.query(
    `DELETE FROM knowledge_artifacts WHERE source_path = $1 AND source = 'obsidian'`,
    [r2Key]
  );
  console.log(`  - ${f.slice(0, 70)}`);
}

async function main(): Promise<void> {
  for (const f of files) {
    if (action === "stage") await stage(f);
    else await unstage(f);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
