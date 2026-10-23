import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, statfs, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable, type TransformCallback } from "node:stream";

/** Thrown when an upload exceeds the byte cap — distinguished so the service maps ONLY this to HTTP 413. */
export class ArtifactTooLargeError extends Error {}

// Hub-mediated staging: the untrusted source host streams an artifact here, the hub computes its byte count
// + SHA-256 itself (never trusting a host-supplied hash), and later a short-lived signed URL serves the file
// to the target agent's restore. Paths are built ONLY from hub-side cuids (opId, taskId) — never from the
// host-chosen itemRef or filename — so there is no path-traversal surface.

export const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024; // sized to finish within the 5-min restore timeout (S6 scales this)

export function stagingDir(): string {
  return process.env.MIGRATION_STAGING_DIR || path.join(os.tmpdir(), "tugra-migration");
}

function opDir(opId: string): string {
  return path.join(stagingDir(), opId);
}
function binPath(opId: string, taskId: string): string {
  return path.join(opDir(opId), `${taskId}.bin`);
}
function metaPath(opId: string, taskId: string): string {
  return path.join(opDir(opId), `${taskId}.meta.json`);
}

export interface StagedMeta {
  sha256: string;
  bytes: number;
  gzip: boolean;
  engine: string;
  pgFormat?: "custom" | "sql";
  stagedAt: string;
}

/** Counts bytes + hashes while passing data through, and aborts the stream the moment it exceeds the cap. */
class ByteCapSha256 extends Transform {
  bytes = 0;
  readonly head: number[] = [];
  private readonly hash: Hash = createHash("sha256");
  constructor(private readonly cap: number) {
    super();
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.cap) return cb(new ArtifactTooLargeError("artifact exceeds the size cap"));
    if (this.head.length < 8) for (const b of chunk.subarray(0, 8 - this.head.length)) this.head.push(b);
    this.hash.update(chunk);
    cb(null, chunk);
  }
  digest(): string {
    return this.hash.digest("hex");
  }
}

/** True if the first bytes are the gzip magic (1f 8b) — a cheap reject of a mislabelled upload before restore. */
export function looksGzip(head: number[]): boolean {
  return head[0] === 0x1f && head[1] === 0x8b;
}

/** Refuse to stage when free disk is under 2x the declared length (leaves headroom for the restore read). */
export async function assertDiskHeadroom(declaredBytes: number): Promise<void> {
  try {
    await mkdir(stagingDir(), { recursive: true, mode: 0o700 }); // ensure the dir exists so statfs works on a fresh deploy
    const fs = await statfs(stagingDir());
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < declaredBytes * 2) {
      const err = new Error("insufficient staging disk space");
      (err as { code?: string }).code = "ENOSPC";
      throw err;
    }
  } catch (e) {
    if ((e as { code?: string }).code === "ENOSPC") throw e;
    // statfs unsupported is not fatal — the cap + per-op lock still bound the write.
  }
}

/**
 * Stream `src` to a UNIQUE `.part` file (so concurrent uploads never share an inode), returning the
 * hub-computed bytes + sha256 + the part path. The caller VALIDATES (length, gzip) and only then calls
 * {@link finalizePart} to atomically rename it over `<op>/<task>.bin`; on rejection it calls
 * {@link discardPart} — so a bad upload never clobbers a previously-good staged artifact.
 */
export async function stageToPart(
  opId: string,
  taskId: string,
  src: Readable,
  cap: number,
): Promise<{ bytes: number; sha256: string; head: number[]; partPath: string }> {
  await mkdir(opDir(opId), { recursive: true, mode: 0o700 });
  const partPath = `${binPath(opId, taskId)}.${randomUUID()}.part`;
  const counter = new ByteCapSha256(cap);
  try {
    await pipeline(src, counter, createWriteStream(partPath, { flags: "wx", mode: 0o600 }));
  } catch (e) {
    await rm(partPath, { force: true });
    throw e;
  }
  return { bytes: counter.bytes, sha256: counter.digest(), head: counter.head, partPath };
}

/** Atomically promote a validated .part to the canonical `<op>/<task>.bin` (replaces any prior staging). */
export async function finalizePart(partPath: string, opId: string, taskId: string): Promise<void> {
  await rename(partPath, binPath(opId, taskId));
}

/** Remove a rejected .part (best-effort) — never touches the canonical .bin. */
export async function discardPart(partPath: string): Promise<void> {
  await rm(partPath, { force: true }).catch(() => undefined);
}

/** Delete ALL of an op's staged artifacts (on cancel/rollback). opDir is built only from the op cuid. */
export async function cleanupOpStaging(opId: string): Promise<void> {
  await rm(opDir(opId), { recursive: true, force: true }).catch(() => undefined);
}

export async function writeStagedMeta(opId: string, taskId: string, meta: StagedMeta): Promise<void> {
  await writeFile(metaPath(opId, taskId), JSON.stringify(meta), { mode: 0o600 });
}

export async function readStagedMeta(opId: string, taskId: string): Promise<StagedMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(opId, taskId), "utf8")) as StagedMeta;
  } catch {
    return null;
  }
}

/** The staged bytes, or null if the file is gone — used to confirm the artifact still exists before restore. */
export async function stagedSize(opId: string, taskId: string): Promise<number | null> {
  try {
    return (await stat(binPath(opId, taskId))).size;
  } catch {
    return null;
  }
}

export function openStagedArtifact(opId: string, taskId: string): Readable {
  return createReadStream(binPath(opId, taskId));
}

/** Delete one artifact's bin + meta (best-effort) — called after a terminal restore result or on abort. */
export async function cleanupArtifact(opId: string, taskId: string): Promise<void> {
  await rm(binPath(opId, taskId), { force: true }).catch(() => undefined);
  await rm(metaPath(opId, taskId), { force: true }).catch(() => undefined);
}
