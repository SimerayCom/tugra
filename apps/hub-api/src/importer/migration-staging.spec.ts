import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mig-stage-test-"));
  process.env.MIGRATION_STAGING_DIR = dir;
});
afterAll(async () => {
  delete process.env.MIGRATION_STAGING_DIR;
  await rm(dir, { recursive: true, force: true });
});

// Imported AFTER the env is set so stagingDir() picks it up at call time (it reads process.env per call).
import {
  ArtifactTooLargeError,
  cleanupArtifact,
  cleanupOpStaging,
  discardPart,
  finalizePart,
  looksGzip,
  readStagedMeta,
  stageToPart,
  stagedSize,
  writeStagedMeta,
} from "./migration-staging";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("migration-staging", () => {
  it("streams to a unique .part and computes the hub's OWN byte count + sha256, then finalizes", async () => {
    const body = Buffer.from("PGDMP\x00\x01\x02 fixture dump bytes");
    const res = await stageToPart("op-x", "task-1", Readable.from(body), 1024);
    expect(res.bytes).toBe(body.length);
    expect(res.sha256).toBe(sha(body));
    expect(res.head.slice(0, 5)).toEqual([...body.subarray(0, 5)]);
    expect(res.partPath).toMatch(/\.part$/);
    expect(await stagedSize("op-x", "task-1")).toBeNull(); // not promoted yet
    await finalizePart(res.partPath, "op-x", "task-1");
    expect(await stagedSize("op-x", "task-1")).toBe(body.length);
  });

  it("concurrent uploads use distinct .part files (no shared inode)", async () => {
    const a = await stageToPart("op-c", "task-c", Readable.from(Buffer.from("aaaa")), 1024);
    const b = await stageToPart("op-c", "task-c", Readable.from(Buffer.from("bbbbbb")), 1024);
    expect(a.partPath).not.toBe(b.partPath);
    expect(a.bytes).toBe(4);
    expect(b.bytes).toBe(6);
    await discardPart(a.partPath);
    await discardPart(b.partPath);
  });

  it("aborts with ArtifactTooLargeError over the cap, leaving no .part and no .bin", async () => {
    await expect(stageToPart("op-x", "task-cap", Readable.from(Buffer.alloc(2048, 7)), 1024)).rejects.toThrow(ArtifactTooLargeError);
    expect(await stagedSize("op-x", "task-cap")).toBeNull();
  });

  it("looksGzip detects the 1f 8b magic", () => {
    expect(looksGzip([0x1f, 0x8b, 0x08])).toBe(true);
    expect(looksGzip([0x50, 0x47])).toBe(false);
    expect(looksGzip([])).toBe(false);
  });

  it("round-trips staged meta and cleans up (per-artifact and per-op)", async () => {
    const r = await stageToPart("op-y", "task-2", Readable.from(Buffer.from("x")), 1024);
    await finalizePart(r.partPath, "op-y", "task-2");
    await writeStagedMeta("op-y", "task-2", { sha256: sha(Buffer.from("x")), bytes: 1, gzip: false, engine: "POSTGRES", pgFormat: "custom", stagedAt: "t" });
    expect((await readStagedMeta("op-y", "task-2"))?.engine).toBe("POSTGRES");
    await cleanupArtifact("op-y", "task-2");
    expect(await stagedSize("op-y", "task-2")).toBeNull();
    expect(await readStagedMeta("op-y", "task-2")).toBeNull();

    const r2 = await stageToPart("op-z", "task-3", Readable.from(Buffer.from("y")), 1024);
    await finalizePart(r2.partPath, "op-z", "task-3");
    await cleanupOpStaging("op-z");
    expect(await stagedSize("op-z", "task-3")).toBeNull();
  });
});
