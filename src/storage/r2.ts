import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
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

export { createClient };
export type { S3Client };
