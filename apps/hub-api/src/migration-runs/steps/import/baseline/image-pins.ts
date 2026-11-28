/**
 * Image digest pinning (R11), pure. An unpinned source image (`:latest`, no tag) is whatever the registry serves TODAY, not
 * what the source runs: a Meilisearch data directory or a gotenberg build may not open under a newer `latest`. The run records
 * the digest the SOURCE runs and deploys that digest, never the floating tag.
 *
 * Two homes for a pin, because the importer already owns one of them:
 *  - a service member (a compose stack's image): the existing `serviceChoices[<itemRef>].pins[<member>]` of the frozen apply
 *    input, which the service transform writes into the compose (`repo@sha256:...` is accepted there);
 *  - an image app (a Coolify `dockerimage` app): a run hint (`MigrationRunHint`, kind `image-pin`), applied to the app right
 *    before DEPLOY_DARK deploys it.
 */
import type { ImportPlanItem } from "../../../../importer/foreign-fleet";
import type { RunApplyInput } from "../../../core/dto";
import type { RunHint } from "./run-hints";
import { exactPinOf } from "./exact-images";

/** `sha256:` plus 64 lower-case hex. The only digest form a pin may take. */
export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/** `name`, `name:latest` or any ref without a tag or digest is floating; a digest or any other tag is not. Mirrors the service transform. */
export function isFloatingImage(image: string): boolean {
  if (/@sha256:[a-f0-9]{64}$/.test(image)) return false;
  const last = image.split("/").pop() ?? image;
  const colon = last.indexOf(":");
  if (colon < 0) return true;
  return last.slice(colon + 1) === "latest";
}

/** The repository of an image ref: tag and digest stripped, registry host (and port) kept. */
export function imageRepoOf(image: string): string {
  const noDigest = image.split("@")[0];
  const last = noDigest.split("/").pop() ?? noDigest;
  const colon = last.indexOf(":");
  return colon < 0 ? noDigest : noDigest.slice(0, noDigest.length - (last.length - colon));
}

/**
 * `repo@sha256:<hex>` for a FLOATING image and a valid digest; null when the image is already pinned (a digest or a version
 * tag is the operator's own choice and is never overridden) or the digest is malformed.
 */
export function pinnedImageRef(image: string, digest: string): string | null {
  if (!DIGEST_RE.test(digest) || !isFloatingImage(image)) return null;
  const repo = imageRepoOf(image);
  return /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,200}$/.test(repo) ? `${repo}@${digest}` : null;
}

/** The source server of a plan itemRef (`kind:<serverRef|_>:<ref>`), or "" when the item has none. */
export function serverRefOfItem(itemRef: string): string {
  const parts = itemRef.split(":");
  return parts.length >= 3 && parts[1] !== "_" ? parts[1] : "";
}

/** The digest recorded for `image` on `serverRef`: a server-specific pin wins over an every-server one. */
export function pinFor(hints: readonly RunHint[], image: string, serverRef: string): string | null {
  let any: string | null = null;
  for (const h of hints) {
    if (h.kind !== "image-pin" || h.key !== image || !DIGEST_RE.test(h.value)) continue;
    if (h.scope === serverRef && serverRef !== "") return h.value;
    if (h.scope === "") any = h.value;
  }
  return any;
}

/** One floating image the plan would import. `member` is set for a service member, `image` for an image app. */
export interface FloatingImage {
  itemRef: string;
  name: string;
  kind: "app" | "service";
  member?: string;
  /** The image as the source writes it (an image app's own ref; a service member's compose ref when the plan's preflight lists it). */
  image?: string;
  /** The concrete version of it the source's own record shows (never set for an app: its ref is all the source says). */
  seen?: string;
  /** A recorded digest covers it (a run hint for an app, a digest pin in the service choices for a member). */
  pinned: boolean;
}

type PlanItemLike = Pick<ImportPlanItem, "itemRef" | "kind" | "name"> & { proposed: Record<string, unknown> };

/** A service pin counts only when the transform would accept it: same repo, not floating, `pinImages` not switched off. */
function servicePinned(applyInput: Pick<RunApplyInput, "serviceChoices">, itemRef: string, member: string): boolean {
  const choice = applyInput.serviceChoices?.[itemRef];
  const pin = choice?.pins?.[member];
  return !!pin && choice?.pinImages !== false && !isFloatingImage(pin);
}

/** The preflight's per-stack rows (additive, outside the plan hash): which members are floating, with the image the source writes. */
export type PreflightServiceRows = ReadonlyArray<{ itemRef?: string; floating?: ReadonlyArray<{ member: string; image: string; seen?: string }> }>;

/** The hint key of a service member's pin: `<itemRef>#<member>`. */
export const servicePinKey = (itemRef: string, member: string): string => `${itemRef}#${member}`;

/** Every floating image among the plan's included items, each marked pinned or not. Stable order (itemRef, member). */
export function floatingImages(items: readonly PlanItemLike[], applyInput: Pick<RunApplyInput, "serviceChoices">, hints: readonly RunHint[], services?: PreflightServiceRows): FloatingImage[] {
  const out: FloatingImage[] = [];
  for (const it of items) {
    if (it.kind === "app" && it.proposed.source === "IMAGE" && typeof it.proposed.image === "string" && isFloatingImage(it.proposed.image)) {
      out.push({ itemRef: it.itemRef, name: it.name, kind: "app", image: it.proposed.image, pinned: pinFor(hints, it.proposed.image, serverRefOfItem(it.itemRef)) !== null || exactPinOf(hints, it.itemRef) !== null });
    } else if (it.kind === "service" && Array.isArray(it.proposed.imageFloating)) {
      const rows = services?.find((r) => r.itemRef === it.itemRef)?.floating ?? [];
      for (const m of it.proposed.imageFloating) {
        if (typeof m !== "string") continue;
        const row = rows.find((r) => r.member === m);
        const hinted = hints.some((h) => h.kind === "service-pin" && h.key === servicePinKey(it.itemRef, m)) || exactPinOf(hints, it.itemRef, m) !== null;
        out.push({ itemRef: it.itemRef, name: it.name, kind: "service", member: m, ...(row ? { image: row.image, ...(row.seen ? { seen: row.seen } : {}) } : {}), pinned: hinted || servicePinned(applyInput, it.itemRef, m) });
      }
    }
  }
  return out.sort((a, b) => (a.itemRef + (a.member ?? "") < b.itemRef + (b.member ?? "") ? -1 : 1));
}

/** At most this many floating images ride in one dry-run item (the params are capped); a longer list is never read as fully pinned. */
export const IMAGE_PARAM_MAX = 20;

/**
 * The floating images as flat, index-aligned params of a dry-run item or gate check: the plan item, the member (`""` for an image
 * app), the image the source writes (`""` when the plan does not list it) and the concrete version the source's own record shows
 * (`""` when it shows none). `imageCount` is the true total, so a truncated list is recognisable.
 */
export function imageParams(list: readonly FloatingImage[]): Record<string, string[] | number> {
  const shown = list.slice(0, IMAGE_PARAM_MAX);
  return {
    imageCount: list.length,
    imageItems: shown.map((f) => f.itemRef.slice(0, 300)),
    imageMembers: shown.map((f) => (f.member ?? "").slice(0, 300)),
    images: shown.map((f) => (f.image ?? "").slice(0, 300)),
    imageSeen: shown.map((f) => (f.seen ?? "").slice(0, 300)),
  };
}
