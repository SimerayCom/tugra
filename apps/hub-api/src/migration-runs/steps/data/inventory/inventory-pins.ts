/**
 * Exact images from the host inventory (R11), pure. Moving to Tugra never changes the version of anything: an app, a database or a stack
 * member is pinned to the image its own RUNNING container runs on the source (`repo:tag@sha256:...`, the tag stays readable), not to
 * what its tag points at on the day of a redeploy or a move to another server (a Meilisearch data directory or a gotenberg build may
 * not open under a newer `latest`, and `postgres:16-alpine` moves under a minor).
 *
 * Only what the host reported for THAT item's own container counts: the container must be the item's (the name rule of the source
 * scripts), running, and carry a digest whose repository is the image's repository. When the host reports no such digest (a locally
 * built image, an inventory from an older script) or two different ones, and no version label to fall back on, nothing is pinned for the
 * item: it stays as the source writes it and the run says so. An operator's own pin (`image-pin`, `service-pin`) is never replaced; a pin
 * an earlier inventory reported is replaced by a newer one.
 */
import type { RunHint } from "../../import/baseline/run-hints";
import { isExactOff } from "../../import/baseline/exact-images";
import { servicePinKey } from "../../import/baseline/image-pins";
import { EXACT_IMAGE_KIND, encodeExact, exactImageFor, isDigestPinned, normalizedRepo as normalizedRepoOf } from "../../../../importer/exact-image";
import { validContainerPrefix } from "../../../../importer/container-prefix";
import { coolifyRefOf } from "../../../../importer/sources/coolify-control";
import { containerNameMatches } from "../source-control/source-scripts";
import type { HostInventory } from "./host-protocol";

/** Re-exported: the repository of an image as docker prints it in RepoDigests (the Docker Hub aliases are folded). */
export const normalizedRepo = normalizedRepoOf;

/** One image the plan would import: an app (`app`), a database (`database`) or one member of a compose stack (`service` + `member`). */
export interface ExactCandidate {
  itemRef: string;
  kind: "app" | "database" | "service";
  /** The compose service key of a stack member. */
  member?: string;
  /** The image the plan or the compose writes; absent for a database the plan gives no image for (the running container's own is used). */
  image?: string;
  /** The app's custom container name prefix, when it has one (its container is `<prefix>-<timestamp>`). */
  containerPrefix?: string;
}

/** The hint key of a candidate: the itemRef, or `<itemRef>#<member>`. */
export const exactKeyOf = (c: Pick<ExactCandidate, "itemRef" | "member">): string => (c.member ? servicePinKey(c.itemRef, c.member) : c.itemRef);

/** What the op's meta keeps of the plan, as far as the exact images need it (`plan.items` and `stackImages`, see the importer's `createOp`). */
export interface ExactMeta {
  plan?: { items?: Array<{ itemRef?: unknown; kind?: unknown; proposed?: { source?: unknown; image?: unknown; containerPrefix?: unknown } }> };
  stackImages?: Array<{ itemRef?: unknown; images?: Array<{ member?: unknown; image?: unknown }> }>;
}

/** The apps (image source), databases and stack members of an op's plan that an exact image can be recorded for. */
export function exactCandidatesOf(meta: ExactMeta): ExactCandidate[] {
  const out: ExactCandidate[] = [];
  for (const i of meta.plan?.items ?? []) {
    if (typeof i.itemRef !== "string") continue;
    if (i.kind === "app" && i.proposed?.source === "IMAGE" && typeof i.proposed.image === "string") out.push({ itemRef: i.itemRef, kind: "app", image: i.proposed.image, ...(validContainerPrefix(i.proposed.containerPrefix) ? { containerPrefix: i.proposed.containerPrefix } : {}) });
    else if (i.kind === "database") out.push({ itemRef: i.itemRef, kind: "database", ...(typeof i.proposed?.image === "string" ? { image: i.proposed.image } : {}) });
  }
  for (const s of meta.stackImages ?? []) {
    if (typeof s.itemRef !== "string") continue;
    for (const m of s.images ?? []) if (typeof m.member === "string" && typeof m.image === "string") out.push({ itemRef: s.itemRef, kind: "service", member: m.member, image: m.image });
  }
  return out;
}

const hostOf = (itemRef: string): string => itemRef.split(":")[1] ?? "_";

/**
 * The `exact-image` hints the inventories justify. Deterministic order (key). Skips an item the owner opted out of and an item the
 * operator pinned by hand (`existing`).
 */
export function deriveExactImages(candidates: readonly ExactCandidate[], inventories: ReadonlyMap<string, HostInventory>, existing: readonly RunHint[] = []): RunHint[] {
  const out = new Map<string, RunHint>();
  for (const c of candidates) {
    if (isExactOff(existing, c.itemRef)) continue;
    if (c.image && isDigestPinned(c.image)) continue;
    if (c.kind === "app" && c.image && existing.some((h) => h.kind === "image-pin" && h.evidence === "operator-attested" && h.key === c.image)) continue;
    if (c.kind === "service" && c.member && existing.some((h) => h.kind === "service-pin" && h.key === servicePinKey(c.itemRef, c.member!) && h.evidence === "operator-attested")) continue;
    const ref = coolifyRefOf(c.itemRef);
    const inv = inventories.get(hostOf(c.itemRef));
    if (!ref || !inv?.complete) continue;
    const kindOk = c.kind === "app" ? ref.kind === "application" : c.kind === "database" ? ref.kind === "database" : ref.kind === "service";
    if (!kindOk || (c.kind === "service" && !c.member)) continue;
    const matched = inv.containers.filter((k) => {
      if (k.state !== "running") return false;
      if (c.kind === "service") return k.name === `${c.member}-${ref.uuid}`;
      return containerNameMatches(k.name, ref.uuid, ref.kind, c.containerPrefix ? [c.containerPrefix] : []);
    });
    if (matched.length === 0) continue;
    // the image the source writes: the plan's own, else (a database the plan names no image for) the one image its running container has
    const runs = new Set(matched.map((k) => k.image));
    const image = c.image ?? (runs.size === 1 ? [...runs][0] : undefined);
    if (!image) continue;
    const versions = new Set(matched.flatMap((k) => (k.imageVersion ? [k.imageVersion] : [])));
    const exact = exactImageFor(
      image,
      matched.flatMap((k) => k.repoDigests ?? []),
      versions.size === 1 ? [...versions][0] : null,
    );
    if (!exact) continue;
    const key = exactKeyOf(c);
    out.set(key, { kind: EXACT_IMAGE_KIND, key, scope: "", value: encodeExact(exact), evidence: "host-loop-reported" });
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}
