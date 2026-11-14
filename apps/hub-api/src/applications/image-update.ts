import { Prisma, type Application } from "@prisma/client";
import { z } from "zod";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Pure logic for the per-app "image update available" check (IMAGE apps): reference parsing, the closed error
 * vocabulary, and the decision of what the UI should say. Clean-room, no libraries. The probe itself (script +
 * runner) lives in image-update-script.ts / image-update.service.ts.
 */

export const IMAGE_CHECK_ERRORS = ["auth", "notfound", "unsupported", "timeout", "failed"] as const;
export type ImageCheckError = (typeof IMAGE_CHECK_ERRORS)[number];

export const IMAGE_UPDATE_STATES = ["disabled", "pinned", "no_baseline", "pending", "up_to_date", "update_available", "error"] as const;

export const ImageUpdateViewSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(IMAGE_UPDATE_STATES),
  updateAvailable: z.boolean(),
  checkedAt: z.string().nullable(), // ISO — last probe that produced a verdict
  changedAt: z.string().nullable(), // ISO — when the current upstream digest was first seen
  error: z.enum(IMAGE_CHECK_ERRORS).nullable(), // only when state === "error"
  upstreamDigest: z.string().nullable(), // WRITER-ONLY, else null
  deployedDigest: z.string().nullable(), // WRITER-ONLY, else null
});
export type ImageUpdateView = z.infer<typeof ImageUpdateViewSchema>;
/** Response of POST /apps/:id/image-update-check. */
export const ImageUpdateCheckResultSchema = z.object({ imageUpdate: ImageUpdateViewSchema });

/** Strict allow-list for a ref that will reach a shell (even though every use is shq()-quoted): no whitespace,
 *  quotes, `$`, backticks, `;`, a leading `-`, or more than 255 chars. */
const SAFE_REF = /^[a-z0-9][a-zA-Z0-9._/:@-]{0,254}$/;
const DIGEST_SUFFIX = /^(.*)@(sha256:[0-9a-f]{64})$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;
const REPO_PART_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

export interface ParsedImageRef {
  host: string;
  repo: string;
  tag: string;
  digest: string | null;
}

export function parseImageRef(ref: string): ParsedImageRef | null {
  if (typeof ref !== "string" || !SAFE_REF.test(ref)) return null;
  let rest = ref;
  let digest: string | null = null;
  if (rest.includes("@")) {
    const m = DIGEST_SUFFIX.exec(rest);
    if (!m) return null;
    rest = m[1]!;
    digest = m[2]!;
  }
  if (!rest) return null;
  const segs = rest.split("/");
  if (segs.some((p) => p === "")) return null;
  let host = "docker.io";
  if (segs.length > 1 && (segs[0]!.includes(".") || segs[0]!.includes(":") || segs[0] === "localhost")) {
    host = segs.shift()!;
    if (!HOST_RE.test(host)) return null;
  }
  // The tag is the text after the last ":" of the LAST path component only (a ":" earlier is a host port).
  const last = segs[segs.length - 1]!;
  let tag = "latest";
  const colon = last.lastIndexOf(":");
  if (colon !== -1) {
    tag = last.slice(colon + 1);
    segs[segs.length - 1] = last.slice(0, colon);
    if (!TAG_RE.test(tag)) return null;
  }
  if (segs.some((p) => !REPO_PART_RE.test(p))) return null;
  if (DOCKER_HUB_ALIASES.has(host)) {
    host = "docker.io";
    if (segs.length === 1) segs.unshift("library");
  }
  return { host, repo: segs.join("/"), tag, digest };
}

/** True when the ref names a MOVING tag we can probe (parsable and not pinned to a digest). */
export function isCheckableRef(ref: string): boolean {
  const p = parseImageRef(ref);
  return p !== null && p.digest === null;
}

export function repoKey(host: string, repo: string): string {
  return `${host}/${repo}`.toLowerCase();
}

/** The repo key of a configured ref, or null when unparsable. */
export function refRepoKey(ref: string): string | null {
  const p = parseImageRef(ref);
  return p ? repoKey(p.host, p.repo) : null;
}

/** A recorded Deployment.imageDigest (`repo@sha256:…`, or the swarm form `repo:tag@sha256:…`) → normalised repo key + digest. */
export function parseRecordedDigest(s: string | null | undefined): { repoKey: string; digest: string } | null {
  if (!s) return null;
  const m = /^(.+)@(sha256:[0-9a-f]{64})$/.exec(s);
  if (!m) return null;
  const p = parseImageRef(m[1]!);
  if (!p || p.digest !== null) return null;
  return { repoKey: repoKey(p.host, p.repo), digest: m[2]! };
}

/** Derived end time of a (SUCCESS) deployment row: (startedAt ?? createdAt) + durationMs. */
export function liveFinishedAt(row: { startedAt: Date | null; createdAt: Date; durationMs: number | null }): Date {
  return new Date((row.startedAt ?? row.createdAt).getTime() + (row.durationMs ?? 0));
}

export interface LiveImage {
  digest: string | null;
  finishedAt: Date;
}

type ViewApp = Pick<
  Application,
  | "source"
  | "isPreview"
  | "image"
  | "status"
  | "imageUpdateCheck"
  | "imageUpstreamDigest"
  | "imageUpstreamCheckedAt"
  | "imageUpstreamChangedAt"
  | "imageCheckError"
>;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Is this app a subject of the check at all (IMAGE, deployed, not a preview, has an image)? */
export function isImageCheckSubject(app: Pick<Application, "source" | "isPreview" | "image" | "status">): boolean {
  return app.source === "IMAGE" && !app.isPreview && !!app.image && app.status !== "NEW";
}

/** Decision order: first match wins. null = the feature does not apply to this app. Never yields
 *  `update_available` from a null, stale, mismatched or failed probe. */
export function computeImageUpdateView(app: ViewApp, live: LiveImage | null | undefined, canWrite: boolean): ImageUpdateView | null {
  if (!isImageCheckSubject(app)) return null;
  const checkedAt = iso(app.imageUpstreamCheckedAt);
  const changedAt = iso(app.imageUpstreamChangedAt);
  const mk = (state: ImageUpdateView["state"], extra: { error?: ImageCheckError | null; deployed?: string | null } = {}): ImageUpdateView => ({
    enabled: app.imageUpdateCheck,
    state,
    updateAvailable: state === "update_available",
    checkedAt,
    changedAt,
    error: state === "error" ? (extra.error ?? "failed") : null,
    upstreamDigest: canWrite ? app.imageUpstreamDigest : null,
    deployedDigest: canWrite ? (extra.deployed ?? null) : null,
  });
  if (!app.imageUpdateCheck) return mk("disabled");
  const ref = parseImageRef(app.image!);
  if (!ref || ref.digest !== null) return mk("pinned");
  const rec = live ? parseRecordedDigest(live.digest) : null;
  if (!live || !rec || rec.repoKey !== repoKey(ref.host, ref.repo)) return mk("no_baseline");
  const deployed = rec.digest;
  if (!app.imageUpstreamCheckedAt) return mk("pending", { deployed });
  if (app.imageUpstreamCheckedAt.getTime() < live.finishedAt.getTime()) return mk("pending", { deployed }); // post-deploy/rollback staleness guard
  if (app.imageCheckError) {
    const code = (IMAGE_CHECK_ERRORS as readonly string[]).includes(app.imageCheckError) ? (app.imageCheckError as ImageCheckError) : "failed";
    return mk("error", { error: code, deployed });
  }
  if (!app.imageUpstreamDigest) return mk("pending", { deployed });
  return mk(app.imageUpstreamDigest === deployed ? "up_to_date" : "update_available", { deployed });
}

/**
 * Live row per app = the latest SUCCESS DEPLOY/ROLLBACK deployment (a FAILED / AUTO_ROLLBACK row never counts;
 * a live row with a null digest stays "unknown", never falls back to an older row). ONE batched query served by
 * the existing (appId,status) index — never Prisma `distinct` (loads every row).
 */
export async function loadLiveImageMany(prisma: Pick<PrismaService, "$queryRaw">, appIds: string[]): Promise<Map<string, LiveImage>> {
  const out = new Map<string, LiveImage>();
  if (!appIds.length) return out;
  const rows: unknown = await prisma.$queryRaw(Prisma.sql`
    SELECT DISTINCT ON ("appId") "appId", "imageDigest", "createdAt", "startedAt", "durationMs"
    FROM "Deployment"
    WHERE "appId" = ANY(${appIds}::text[]) AND "status" = 'SUCCESS' AND "kind" IN ('DEPLOY', 'ROLLBACK')
    ORDER BY "appId", "createdAt" DESC`);
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r.appId !== "string") continue;
    const createdAt = r.createdAt instanceof Date ? r.createdAt : null;
    if (!createdAt) continue;
    const startedAt = r.startedAt instanceof Date ? r.startedAt : null;
    const durationMs = typeof r.durationMs === "number" ? r.durationMs : null;
    out.set(r.appId, {
      digest: typeof r.imageDigest === "string" ? r.imageDigest : null,
      finishedAt: liveFinishedAt({ startedAt, createdAt, durationMs }),
    });
  }
  return out;
}
