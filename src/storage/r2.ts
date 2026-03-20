import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { config } from "../config.js";

const CONTENT_TYPES: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  heic: "image/heic",
  tiff: "image/tiff",
  webp: "image/webp",
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  avi: "video/x-msvideo",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  caf: "audio/x-caf",
};

function createClient(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
}

export function getPublicUrl(key: string): string {
  const base = config.r2.publicUrl.replace(/\/$/, "");
  return `${base}/${key}`;
}

export async function mediaExists(
  client: S3Client,
  key: string
): Promise<boolean> {
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: config.r2.bucketName,
        Key: key,
      })
    );
    return true;
  } catch {
    return false;
  }
}

export async function uploadMedia(
  client: S3Client,
  filePath: string,
  key: string
): Promise<string> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

  const body = fs.readFileSync(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: config.r2.bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  return getPublicUrl(key);
}

export async function uploadMediaBuffer(
  client: S3Client,
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  await client.send(
    new PutObjectCommand({
      Bucket: config.r2.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return getPublicUrl(key);
}

export async function deleteMediaObject(
  client: S3Client,
  key: string
): Promise<void> {
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.r2.bucketName,
        Key: key,
      })
    );
  } catch {
    // Best-effort delete — log but don't throw
  }
}

// ============================================================================
// Generic object operations (used by Obsidian vault sync)
// ============================================================================

/** Metadata for an R2 object from ListObjectsV2 */
export interface R2ObjectMeta {
  key: string;
  etag: string;
  size: number;
}

/** List all objects in a bucket, handling pagination (>1000 files) */
export async function listAllObjects(
  client: S3Client,
  bucket: string,
  prefix?: string
): Promise<R2ObjectMeta[]> {
  const results: R2ObjectMeta[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of response.Contents ?? []) {
      if (obj.Key && obj.ETag) {
        results.push({
          key: obj.Key,
          etag: obj.ETag.replace(/"/g, ""),
          size: obj.Size ?? 0,
        });
      }
    }
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return results;
}

/** Download object content as UTF-8 string */
export async function getObjectContent(
  client: S3Client,
  bucket: string,
  key: string
): Promise<string> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  return await response.Body!.transformToString("utf-8");
}

/** Upload UTF-8 text content (e.g. markdown notes) to a bucket */
export async function putObjectContent(
  client: S3Client,
  bucket: string,
  key: string,
  content: string,
  contentType = "text/markdown; charset=utf-8"
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(content, "utf-8"),
      ContentType: contentType,
    })
  );
}

export { createClient, CONTENT_TYPES };
export type { S3Client };
