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
