import { HttpException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { assertDiskHeadroom, defaultStallPolicy, discardStaged, filesLimits, stageUpload, StagedStalledError, StagedTooLargeError, StagingBudget, stagingDir, sweepStaging } from "./fs-staging";

describe("fs-staging", () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "fs-stage-"));
    process.env.FILES_STAGING_DIR = dir;
  });
  afterEach(async () => {
    process.env = { ...saved };
    await rm(dir, { recursive: true, force: true });
  });

  it("stages a body, computing bytes and sha256 itself, as a private .part file", async () => {
    const r = await stageUpload(Readable.from([Buffer.from("hel"), Buffer.from("lo")]), 100);
    expect(r.bytes).toBe(5);
    expect(r.sha256).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(path.dirname(r.path)).toBe(dir);
    expect(r.path).toMatch(/[0-9a-f-]{36}\.part$/);
    expect((await stat(r.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(r.path, "utf8")).toBe("hello");
    await discardStaged(r.path);
    expect(await readdir(dir)).toEqual([]);
    await discardStaged(r.path); // idempotent
    await discardStaged(undefined);
  });

  it("enforces the byte cap (413-class error) and leaves no .part behind", async () => {
    await expect(stageUpload(Readable.from([Buffer.from("abcdef")]), 5)).rejects.toBeInstanceOf(StagedTooLargeError);
    expect(await readdir(dir)).toEqual([]);
  });

  it("removes the partial file when the client aborts mid-body", async () => {
    const body = new PassThrough();
    const p = stageUpload(body, 100);
    body.write("abc");
    await new Promise((r) => setImmediate(r));
    body.destroy(new Error("client aborted"));
    await expect(p).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it("cancels a trickled body (one byte per window beats an idle timeout, not the throughput floor) and removes the partial file", async () => {
    const body = new PassThrough();
    const p = stageUpload(body, 1000, { graceMs: 30, windowMs: 10, minBytesPerWindow: 100, deadlineMs: 10_000 });
    const tick = setInterval(() => body.write("x"), 3);
    try {
      await expect(p).rejects.toBeInstanceOf(StagedStalledError);
    } finally {
      clearInterval(tick);
    }
    expect(body.destroyed).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it("cancels a body that overruns its overall deadline even when it keeps meeting the floor", async () => {
    const body = new PassThrough();
    const p = stageUpload(body, 10_000_000, { graceMs: 1000, windowMs: 10, minBytesPerWindow: 1, deadlineMs: 60 });
    const tick = setInterval(() => body.write("xxxx"), 2);
    try {
      await expect(p).rejects.toMatchObject({ message: "upload deadline exceeded" });
    } finally {
      clearInterval(tick);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("lets a body that keeps up with the floor finish", async () => {
    const body = new PassThrough();
    const p = stageUpload(body, 1000, { graceMs: 20, windowMs: 10, minBytesPerWindow: 10, deadlineMs: 5000 });
    for (let i = 0; i < 20; i++) {
      body.write("0123456789");
      await new Promise((r) => setTimeout(r, 5));
    }
    body.end();
    const r = await p;
    expect(r.bytes).toBe(200);
    await discardStaged(r.path);
  });

  it("derives the default floor: 20 s grace, 16 KiB per 10 s, deadline = size / 64 KiB/s + 60 s capped at 10 min", () => {
    expect(defaultStallPolicy(0)).toEqual({ graceMs: 20_000, windowMs: 10_000, minBytesPerWindow: 16 * 1024, deadlineMs: 60_000 });
    expect(defaultStallPolicy(6.4 * 1024 * 1024).deadlineMs).toBe(60_000 + 102_400);
    expect(defaultStallPolicy(256 * 1024 * 1024).deadlineMs).toBe(10 * 60_000);
  });

  it("reserves staging bytes from the declared length and 507s when full; release is idempotent", () => {
    const b = new StagingBudget(100);
    const r1 = b.reserve(60);
    expect(() => b.reserve(60)).toThrow(HttpException);
    try {
      b.reserve(60);
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(507);
      expect((e as HttpException).getResponse()).toMatchObject({ code: "staging_full" });
    }
    r1();
    r1(); // double release must not go negative or free someone else's bytes
    expect(b.inUse).toBe(0);
    const r2 = b.reserve(100);
    expect(b.inUse).toBe(100);
    r2();
  });

  it("refuses to stage when the disk cannot hold 2x the declared length", async () => {
    await expect(assertDiskHeadroom(1024)).resolves.toBeUndefined();
    const err = await assertDiskHeadroom(Number.MAX_SAFE_INTEGER / 4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(507);
  });

  it("sweeps only our own stale <uuid>.part files", async () => {
    const old = new Date(Date.now() - 3 * 3600_000);
    const mk = async (name: string, age?: Date) => {
      await writeFile(path.join(dir, name), "x");
      if (age) await utimes(path.join(dir, name), age, age);
    };
    await mk("11111111-1111-1111-1111-111111111111.part", old); // stale, ours
    await mk("22222222-2222-2222-2222-222222222222.part"); // fresh
    await mk("keep.txt", old); // not ours
    await mk("33333333-3333-3333-3333-33333333333.part", old); // wrong length
    expect(await sweepStaging(3600_000)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(["22222222-2222-2222-2222-222222222222.part", "33333333-3333-3333-3333-33333333333.part", "keep.txt"]);
  });

  it("honours env size limits within hard ceilings, with the documented defaults", () => {
    delete process.env.FILES_MAX_UPLOAD_BYTES;
    delete process.env.FILES_MAX_DOWNLOAD_BYTES;
    expect(filesLimits()).toEqual({ maxUploadBytes: 256 * 1024 ** 2, maxDownloadBytes: 1024 ** 3, maxEditBytes: 1024 ** 2 });
    process.env.FILES_MAX_UPLOAD_BYTES = String(10 * 1024 ** 3); // above the 2 GiB ceiling
    expect(filesLimits().maxUploadBytes).toBe(2 * 1024 ** 3);
    process.env.FILES_MAX_UPLOAD_BYTES = "1000";
    expect(filesLimits().maxUploadBytes).toBe(1000);
    process.env.FILES_MAX_UPLOAD_BYTES = "-5";
    expect(filesLimits().maxUploadBytes).toBe(256 * 1024 ** 2);
    expect(stagingDir()).toBe(dir);
  });
});
