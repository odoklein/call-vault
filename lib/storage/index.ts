// File storage abstraction — same shape as captainprospect-crm's lib/storage/storage-service.ts
// (StorageProvider.upload/download/delete). Recordings are fetched from the provider exactly once
// and pushed through here; after that, only this store is ever read from.

import { existsSync, mkdirSync } from "fs";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import path from "path";

export interface StorageProvider {
  upload(file: Buffer, key: string, mimeType: string): Promise<string>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Byte stream (optionally one HTTP Range) — for serving audio through the app with seeking. */
  stream(key: string, range?: string): Promise<StoredStream>;
}

export interface StoredStream {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number;
  /** Set for a partial (206) response. */
  contentRange?: string;
  totalSize?: number;
}

/** Parses "bytes=a-b" against a known size. Returns null for absent/unsatisfiable ranges. */
export function parseRange(range: string | undefined, size: number): { start: number; end: number } | null {
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

function mimeFromKey(key: string): string {
  return key.endsWith(".wav") ? "audio/wav" : key.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg";
}

// ============================================
// LOCAL (dev)
// ============================================

class LocalStorageProvider implements StorageProvider {
  private basePath = "./uploads";

  private ensureDir() {
    if (!existsSync(this.basePath)) mkdirSync(this.basePath, { recursive: true });
  }

  async upload(file: Buffer, key: string): Promise<string> {
    this.ensureDir();
    const filePath = path.join(this.basePath, key);
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(filePath, file);
    return `/uploads/${key}`;
  }

  async download(key: string): Promise<Buffer> {
    return readFile(path.join(this.basePath, key));
  }

  async delete(key: string): Promise<void> {
    await unlink(path.join(this.basePath, key));
  }

  async stream(key: string, range?: string): Promise<StoredStream> {
    const full = await readFile(path.join(this.basePath, key));
    const r = parseRange(range, full.length);
    const bytes = r ? full.subarray(r.start, r.end + 1) : full;
    return {
      body: new Blob([new Uint8Array(bytes)]).stream(),
      contentType: mimeFromKey(key),
      contentLength: bytes.length,
      contentRange: r ? `bytes ${r.start}-${r.end}/${full.length}` : undefined,
      totalSize: full.length,
    };
  }
}

// ============================================
// S3 (production)
// ============================================

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";

class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = process.env.ASW_S3_BUCKET || "";
    this.client = new S3Client({
      region: process.env.ASW_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.ASW_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.ASW_SECRET_ACCESS_KEY || "",
      },
    });
  }

  async upload(file: Buffer, key: string, mimeType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: file, ContentType: mimeType }),
    );
    return `https://${this.bucket}.s3.${process.env.ASW_REGION}.amazonaws.com/${key}`;
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return streamToBuffer(response.Body);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return getS3SignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  async stream(key: string, range?: string): Promise<StoredStream> {
    return s3Stream(this.client, this.bucket, key, range);
  }
}

async function s3Stream(client: S3Client, bucket: string, key: string, range?: string): Promise<StoredStream> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
  if (!res.Body) throw new Error(`empty object ${key}`);
  const total = res.ContentRange ? Number(res.ContentRange.split("/")[1]) : res.ContentLength;
  return {
    body: res.Body.transformToWebStream() as ReadableStream<Uint8Array>,
    contentType: res.ContentType || mimeFromKey(key),
    contentLength: res.ContentLength,
    contentRange: res.ContentRange,
    totalSize: Number.isFinite(total) ? total : undefined,
  };
}

async function streamToBuffer(stream: GetObjectCommandOutput["Body"]): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ============================================
// MINIO (self-hosted S3-compatible — same env var names as captainprospect-crm's
// lib/storage/minio.ts, so Odo doesn't have to learn a second naming scheme)
// ============================================

class MinioStorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private endpoint: string;

  constructor() {
    this.bucket = process.env.MINIO_BUCKET || "call-vault";
    this.endpoint = (process.env.MINIO_ENDPOINT || "").replace(/\/+$/, "");
    this.client = new S3Client({
      endpoint: this.endpoint,
      region: process.env.MINIO_REGION || "us-east-1",
      // MinIO is not virtual-hosted-style like AWS S3 — bucket must be in the path, not the host.
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.MINIO_SECRET_ACCESS_KEY || "",
      },
    });
  }

  async upload(file: Buffer, key: string, mimeType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: file, ContentType: mimeType }),
    );
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return `${this.endpoint}/${encodeURIComponent(this.bucket)}/${encodedKey}`;
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return streamToBuffer(response.Body);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return getS3SignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  async stream(key: string, range?: string): Promise<StoredStream> {
    return s3Stream(this.client, this.bucket, key, range);
  }
}

// ============================================
// SINGLETON, provider chosen by STORAGE_PROVIDER
// ============================================

let provider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (provider) return provider;
  const kind = process.env.STORAGE_PROVIDER;
  provider = kind === "minio" ? new MinioStorageProvider() : kind === "s3" ? new S3StorageProvider() : new LocalStorageProvider();
  return provider;
}

/** Signed URL for a stored recording. Falls back to a plain path for local dev storage. */
export async function getRecordingUrl(key: string): Promise<string> {
  const p = getStorageProvider();
  if (p instanceof S3StorageProvider || p instanceof MinioStorageProvider) return p.getSignedUrl(key);
  return `/uploads/${key}`;
}
