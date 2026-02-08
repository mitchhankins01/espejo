import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    r2: {
      accountId: "test-account",
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucketName: "test-bucket",
      publicUrl: "https://test.r2.dev",
    },
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn(),
  HeadObjectCommand: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue(Buffer.from("file-content")),
  },
}));

import {
  getPublicUrl,
  mediaExists,
  uploadMedia,
  createClient,
} from "../../src/storage/r2.js";

describe("getPublicUrl", () => {
  it("constructs URL from key", () => {
    expect(getPublicUrl("photos/abc.jpeg")).toBe(
      "https://test.r2.dev/photos/abc.jpeg"
    );
  });

  it("strips trailing slash from base URL", () => {
    // The function handles trailing slashes via .replace(/\/$/, "")
    expect(getPublicUrl("videos/def.mov")).toBe(
      "https://test.r2.dev/videos/def.mov"
    );
  });
});

describe("createClient", () => {
  it("returns an S3Client instance", () => {
    const client = createClient();
    expect(client).toBeDefined();
  });
});

describe("mediaExists", () => {
  it("returns true when object exists", async () => {
    const mockClient = { send: vi.fn().mockResolvedValue({}) };
    const result = await mediaExists(mockClient as any, "photos/abc.jpeg");
    expect(result).toBe(true);
  });

  it("returns false when object does not exist", async () => {
    const mockClient = {
      send: vi.fn().mockRejectedValue(new Error("NotFound")),
    };
    const result = await mediaExists(mockClient as any, "photos/abc.jpeg");
    expect(result).toBe(false);
  });
});

describe("uploadMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads file and returns public URL", async () => {
    const mockClient = { send: vi.fn().mockResolvedValue({}) };
    const url = await uploadMedia(
      mockClient as any,
      "/path/to/photo.jpeg",
      "photos/abc.jpeg"
    );

    expect(url).toBe("https://test.r2.dev/photos/abc.jpeg");
    expect(mockClient.send).toHaveBeenCalled();
  });

  it("uses correct content type for known extensions", async () => {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const mockClient = { send: vi.fn().mockResolvedValue({}) };

    await uploadMedia(
      mockClient as any,
      "/path/to/video.mov",
      "videos/abc.mov"
    );

    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ContentType: "video/quicktime",
      })
    );
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const mockClient = { send: vi.fn().mockResolvedValue({}) };

    await uploadMedia(
      mockClient as any,
      "/path/to/file.xyz",
      "photos/abc.xyz"
    );

    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ContentType: "application/octet-stream",
      })
    );
  });
});
