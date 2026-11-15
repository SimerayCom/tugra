import { HttpException } from "@nestjs/common";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable, type TransformCallback } from "node:stream";

// Hub-side staging for file UPLOADS: the browser streams its body here, the hub computes the byte count and
// SHA-256 itself (never trusting a client hash), and the agent later pulls the staged file over an HMAC-signed
// URL. This module is deliberately self-contained (own byte-cap transform) and independent of the migration
// staging — a cap or path change here can never touch a migration.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const ABS_MAX_UPLOAD = 2 * GIB;

/** Thrown when an upload exceeds its byte cap; the caller maps ONLY this to 413/400. */
export class StagedTooLargeError extends Error {}

function envBytes(name: string, fallback: number, ceiling: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), ceiling) : fallback;
}

/** The size policy (env-tunable, with hard ceilings). `maxEditBytes` is a client-side policy exposed via meta. */
export function filesLimits(): { maxUploadBytes: number; maxDownloadBytes: number; maxEditBytes: number } {
  return {
    maxUploadBytes: envBytes("FILES_MAX_UPLOAD_BYTES", 256 * MIB, ABS_MAX_UPLOAD),
    maxDownloadBytes: envBytes("FILES_MAX_DOWNLOAD_BYTES", 1 * GIB, 64 * GIB),
    maxEditBytes: 1 * MIB,
  };
}

export function stagingDir(): string {
  return process.env.FILES_STAGING_DIR || path.join(os.tmpdir(), "tugra-files");
}

/** Counts bytes + hashes while passing data through, and aborts the stream the moment it exceeds the cap. */
export class ByteCapSha256 extends Transform {
  bytes = 0;
  private readonly hash: Hash = createHash("sha256");
  constructor(private readonly cap: number) {
    super();
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.cap) return cb(new StagedTooLargeError("upload exceeds its size"));
    this.hash.update(chunk);
    cb(null, chunk);
  }
  digest(): string {
    return this.hash.digest("hex");
  }
}

async function ensureDir(): Promise<void> {
  await mkdir(stagingDir(), { recursive: true, mode: 0o700 });
}

/** Refuse to stage when free disk is under 2x the declared length (headroom for the agent's read). 507 on shortage. */
export async function assertDiskHeadroom(declaredBytes: number): Promise<void> {
  try {
    await ensureDir();
    const fs = await statfs(stagingDir());
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < declaredBytes * 2) {
      throw new HttpException({ statusCode: 507, code: "staging_full", message: "insufficient staging disk space" }, 507);
    }
  } catch (e) {
    if (e instanceof HttpException) throw e;
    // statfs unsupported is not fatal — the byte cap + reservation counter still bound the write.
  }
}

/** Total bytes the hub is willing to hold in staging at once (reserved from the DECLARED Content-Length). */
export class StagingBudget {
  private reserved = 0;
  constructor(private readonly max: number = envBytes("FILES_STAGING_MAX_BYTES", 2 * GIB, 64 * GIB)) {}

  /** Reserve `bytes` or throw 507 `staging_full`. Returns a release function (idempotent). */
  reserve(bytes: number): () => void {
    if (this.reserved + bytes > this.max) {
      throw new HttpException({ statusCode: 507, code: "staging_full", message: "the hub's upload staging is full — retry shortly" }, 507);
    }
    this.reserved += bytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.reserved = Math.max(0, this.reserved - bytes);
      }
    };
  }

  get inUse(): number {
    return this.reserved;
  }
}

export interface StagedUpload {
  bytes: number;
  sha256: string;
  path: string;
}

/**
 * Stream `src` into a UNIQUE `.part` file (mode 0600, exclusive create) under the staging dir, hashing and
 * counting as it goes. On any failure (cap exceeded, client abort, disk error) the partial file is removed.
 */
export async function stageUpload(src: Readable, cap: number): Promise<StagedUpload> {
  // An abort between now and the pipeline attaching its own listeners (the dir creation below is async) must not
  // surface as an unhandled 'error'; pipeline() still fails on the destroyed source.
  src.on("error", () => undefined);
  await ensureDir();
  const filePath = path.join(stagingDir(), `${randomUUID()}.part`);
  const counter = new ByteCapSha256(cap);
  try {
    await pipeline(src, counter, createWriteStream(filePath, { flags: "wx", mode: 0o600 }));
  } catch (e) {
    await rm(filePath, { force: true });
    throw e;
  }
  return { bytes: counter.bytes, sha256: counter.digest(), path: filePath };
}

/** Remove a staged file (best-effort, idempotent). */
export async function discardStaged(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  await rm(filePath, { force: true }).catch(() => undefined);
}

/** Delete `.part` files older than `maxAgeMs` (boot + hourly). Only our own `<uuid>.part` names are touched. */
export async function sweepStaging(maxAgeMs = 60 * 60 * 1000, now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(stagingDir())) {
      if (!/^[0-9a-f-]{36}\.part$/.test(name)) continue;
      const p = path.join(stagingDir(), name);
      try {
        if (now - (await stat(p)).mtimeMs > maxAgeMs) {
          await rm(p, { force: true });
          removed++;
        }
      } catch {
        /* raced with a concurrent delete */
      }
    }
  } catch {
    /* staging dir not created yet */
  }
  return removed;
}
