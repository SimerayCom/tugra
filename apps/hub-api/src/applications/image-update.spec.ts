import type { PrismaService } from "../prisma/prisma.service";
import {
  computeImageUpdateView,
  isCheckableRef,
  liveFinishedAt,
  loadLiveImageMany,
  parseImageRef,
  parseRecordedDigest,
  refRepoKey,
} from "./image-update";

const D = (c: string) => "sha256:" + c.repeat(64);
const t = (iso: string) => new Date(iso);

describe("parseImageRef", () => {
  it("parses the common shapes", () => {
    expect(parseImageRef("nginx")).toEqual({ host: "docker.io", repo: "library/nginx", tag: "latest", digest: null });
    expect(parseImageRef("nginx:1.27")).toEqual({ host: "docker.io", repo: "library/nginx", tag: "1.27", digest: null });
    expect(parseImageRef("bitnami/redis:7")).toEqual({ host: "docker.io", repo: "bitnami/redis", tag: "7", digest: null });
    expect(parseImageRef("ghcr.io/o/r:tag")).toEqual({ host: "ghcr.io", repo: "o/r", tag: "tag", digest: null });
    expect(parseImageRef("registry:5000/a/b")).toEqual({ host: "registry:5000", repo: "a/b", tag: "latest", digest: null });
    expect(parseImageRef("registry:5000/a/b:v2")).toEqual({ host: "registry:5000", repo: "a/b", tag: "v2", digest: null });
    expect(parseImageRef("localhost/x")).toEqual({ host: "localhost", repo: "x", tag: "latest", digest: null });
  });
  it("sets the digest for repo@sha256 and repo:tag@sha256", () => {
    expect(parseImageRef(`nginx@${D("a")}`)).toEqual({ host: "docker.io", repo: "library/nginx", tag: "latest", digest: D("a") });
    expect(parseImageRef(`ghcr.io/o/r:1.2@${D("b")}`)).toEqual({ host: "ghcr.io", repo: "o/r", tag: "1.2", digest: D("b") });
  });
  it("folds Docker Hub aliases", () => {
    for (const h of ["docker.io", "index.docker.io", "registry-1.docker.io"]) {
      expect(parseImageRef(`${h}/library/nginx:1`)).toMatchObject({ host: "docker.io", repo: "library/nginx", tag: "1" });
      expect(parseImageRef(`${h}/nginx`)).toMatchObject({ host: "docker.io", repo: "library/nginx" });
    }
  });
  it("rejects anything that could reach a shell or is malformed", () => {
    for (const bad of ["", "nginx latest", "nginx;ls", "$(id)", "`id`", "-v", "--rm", "a'b", 'a"b', "a\nb", "x".repeat(256), "nginx@sha256:abc", "nginx:", "a//b", "Nginx", "a/b:ta g", "a@b"]) {
      expect(parseImageRef(bad)).toBeNull();
    }
    expect(parseImageRef("a".repeat(255))).not.toBeNull();
  });
  it("isCheckableRef excludes digest-pinned refs", () => {
    expect(isCheckableRef("nginx")).toBe(true);
    expect(isCheckableRef(`nginx@${D("a")}`)).toBe(false);
    expect(isCheckableRef("a;b")).toBe(false);
  });
});

describe("parseRecordedDigest / repo key equivalence", () => {
  it("parses repo@digest and the swarm repo:tag@digest form", () => {
    expect(parseRecordedDigest(`nginx@${D("a")}`)).toEqual({ repoKey: "docker.io/library/nginx", digest: D("a") });
    expect(parseRecordedDigest(`ghcr.io/o/r:tag@${D("b")}`)).toEqual({ repoKey: "ghcr.io/o/r", digest: D("b") });
    expect(parseRecordedDigest("nginx")).toBeNull();
    expect(parseRecordedDigest(null)).toBeNull();
    expect(parseRecordedDigest("sha256:abc")).toBeNull();
  });
  it("docker.io/library/nginx equals nginx", () => {
    expect(parseRecordedDigest(`docker.io/library/nginx@${D("a")}`)!.repoKey).toBe(refRepoKey("nginx"));
    expect(refRepoKey("a;b")).toBeNull();
  });
});

describe("liveFinishedAt", () => {
  it("is (startedAt ?? createdAt) + durationMs, durationMs null → 0", () => {
    expect(liveFinishedAt({ startedAt: t("2026-11-01T10:00:00Z"), createdAt: t("2026-11-01T09:00:00Z"), durationMs: 5000 })).toEqual(t("2026-11-01T10:00:05Z"));
    expect(liveFinishedAt({ startedAt: null, createdAt: t("2026-11-01T09:00:00Z"), durationMs: 1000 })).toEqual(t("2026-11-01T09:00:01Z"));
    expect(liveFinishedAt({ startedAt: null, createdAt: t("2026-11-01T09:00:00Z"), durationMs: null })).toEqual(t("2026-11-01T09:00:00Z"));
  });
});

describe("computeImageUpdateView", () => {
  const finished = t("2026-11-01T10:00:00Z");
  const checked = t("2026-11-01T12:00:00Z");
  const app = (over: Record<string, unknown> = {}) => ({
    source: "IMAGE" as const,
    isPreview: false,
    image: "nginx",
    status: "RUNNING" as const,
    imageUpdateCheck: true,
    imageUpstreamDigest: D("b") as string | null,
    imageUpstreamCheckedAt: checked as Date | null,
    imageUpstreamChangedAt: checked as Date | null,
    imageCheckError: null as string | null,
    ...over,
  });
  const live = (digest: string | null = `nginx@${D("a")}`, at = finished) => ({ digest, finishedAt: at });
  const view = (a: ReturnType<typeof app>, l: ReturnType<typeof live> | null | undefined = live(), w = true) => computeImageUpdateView(a, l, w);

  it("is null for GIT, COMPOSE, previews, NEW and apps without an image", () => {
    expect(view(app({ source: "GIT" }))).toBeNull();
    expect(view(app({ source: "COMPOSE" }))).toBeNull();
    expect(view(app({ isPreview: true }))).toBeNull();
    expect(view(app({ status: "NEW" }))).toBeNull();
    expect(view(app({ image: null }))).toBeNull();
  });
  it("disabled wins before anything else (even a stored error)", () => {
    expect(view(app({ imageUpdateCheck: false, imageCheckError: "auth" }))).toMatchObject({ state: "disabled", enabled: false, updateAvailable: false, error: null });
  });
  it("pinned for a digest-pinned or unparsable ref", () => {
    expect(view(app({ image: `nginx@${D("a")}` }))?.state).toBe("pinned");
    expect(view(app({ image: "bad ref" }))?.state).toBe("pinned");
  });
  it("no_baseline: no live row, null digest, unparsable digest, repo mismatch — never an update", () => {
    expect(view(app(), null)?.state).toBe("no_baseline");
    expect(computeImageUpdateView(app(), undefined, true)?.state).toBe("no_baseline");
    expect(view(app(), live(null))?.state).toBe("no_baseline");
    expect(view(app(), live("garbage"))?.state).toBe("no_baseline");
    expect(view(app(), live(`redis@${D("a")}`))?.state).toBe("no_baseline");
    expect(view(app({ imageUpstreamDigest: D("b") }), live(null))?.updateAvailable).toBe(false);
  });
  it("pending: never checked, checked before the live deploy finished, or no digest recorded yet", () => {
    expect(view(app({ imageUpstreamCheckedAt: null }))?.state).toBe("pending");
    expect(view(app({ imageUpstreamCheckedAt: t("2026-11-01T09:59:59Z") }))?.state).toBe("pending");
    expect(view(app({ imageUpstreamDigest: null }))?.state).toBe("pending");
  });
  it("a stale probe never beats the post-deploy guard, even with an error recorded", () => {
    expect(view(app({ imageUpstreamCheckedAt: t("2026-11-01T09:00:00Z"), imageCheckError: "auth" }))?.state).toBe("pending");
  });
  it("error takes precedence over a stored digest and carries its code", () => {
    const v = view(app({ imageCheckError: "timeout" }))!;
    expect(v).toMatchObject({ state: "error", error: "timeout", updateAvailable: false });
    expect(view(app({ imageCheckError: "weird" }))).toMatchObject({ state: "error", error: "failed" }); // unknown code → closed vocabulary
  });
  it("up_to_date when digests match, update_available when they differ", () => {
    expect(view(app({ imageUpstreamDigest: D("a") }))).toMatchObject({ state: "up_to_date", updateAvailable: false });
    expect(view(app())).toMatchObject({ state: "update_available", updateAvailable: true });
  });
  it("a manual rollback to an older digest shows update_available again", () => {
    // upstream is b; the rollback re-deployed older digest c, finishing before the (newer) check
    expect(view(app({ imageUpstreamDigest: D("b") }), live(`nginx@${D("c")}`, t("2026-11-01T11:00:00Z")))?.state).toBe("update_available");
  });
  it("redacts both digests for a non-writer but keeps state and timestamps", () => {
    const w = view(app())!;
    expect(w.upstreamDigest).toBe(D("b"));
    expect(w.deployedDigest).toBe(D("a"));
    const r = view(app(), live(), false)!;
    expect(r).toMatchObject({ state: "update_available", upstreamDigest: null, deployedDigest: null, checkedAt: checked.toISOString(), changedAt: checked.toISOString() });
  });
  it("uses finishedAt with a null durationMs (equal timestamps are not stale)", () => {
    const l = { digest: `nginx@${D("a")}`, finishedAt: liveFinishedAt({ startedAt: null, createdAt: checked, durationMs: null }) };
    expect(view(app(), l)?.state).toBe("update_available");
  });
  it("the swarm repo:tag@digest recorded form compares correctly", () => {
    expect(view(app({ image: "ghcr.io/o/r:t", imageUpstreamDigest: D("a") }), live(`ghcr.io/o/r:t@${D("a")}`))?.state).toBe("up_to_date");
  });
});

describe("loadLiveImageMany", () => {
  const mk = (ret: unknown) => {
    const q = jest.fn().mockResolvedValue(ret);
    return { q, prisma: { $queryRaw: q } as unknown as PrismaService };
  };
  it("does not query for an empty id list", async () => {
    const { q, prisma } = mk([]);
    expect((await loadLiveImageMany(prisma, [])).size).toBe(0);
    expect(q).not.toHaveBeenCalled();
  });
  it("issues ONE parameterised query and maps rows (finishedAt derived)", async () => {
    const created = t("2026-11-01T09:00:00Z");
    const { q, prisma } = mk([
      { appId: "a1", imageDigest: `nginx@${D("a")}`, createdAt: created, startedAt: t("2026-11-01T10:00:00Z"), durationMs: 5000 },
      { appId: "a2", imageDigest: null, createdAt: created, startedAt: null, durationMs: null },
    ]);
    const out = await loadLiveImageMany(prisma, ["a1", "a2", "a3"]);
    expect(q).toHaveBeenCalledTimes(1);
    const sql = q.mock.calls[0][0] as { values: unknown[]; sql: string };
    expect(sql.values).toEqual([["a1", "a2", "a3"]]); // ids are parameters, never interpolated
    expect(sql.sql).toContain("DISTINCT ON");
    expect(out.get("a1")).toEqual({ digest: `nginx@${D("a")}`, finishedAt: t("2026-11-01T10:00:05Z") });
    expect(out.get("a2")).toEqual({ digest: null, finishedAt: created });
    expect(out.has("a3")).toBe(false);
  });
  it("treats a non-array or malformed result as empty (other specs mock $queryRaw for the deploy claim)", async () => {
    expect((await loadLiveImageMany(mk(undefined).prisma, ["a"])).size).toBe(0);
    expect((await loadLiveImageMany(mk({ id: "x" }).prisma, ["a"])).size).toBe(0);
    expect((await loadLiveImageMany(mk([{ id: "x" }, null, { appId: "a", createdAt: "not-a-date" }]).prisma, ["a"])).size).toBe(0);
  });
});
