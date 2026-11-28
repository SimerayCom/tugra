/**
 * The exact image of an imported item, pure. Moving to Tugra never changes the version of anything: an app, a database or a stack member
 * keeps the image the source runs, not whatever its tag points at on the day of a redeploy or a move to another server.
 *
 * The source tells it from the RUNNING container: the image's `RepoDigests` (`repo@sha256:...`) and, when the image carries it, the
 * `org.opencontainers.image.version` label. The pin is `repo:tag@sha256:...` (the tag stays readable, docker pulls by the digest). When
 * only the label is known and the source runs a floating tag, the pin is the exact version tag `repo:<version>`. A digest is never
 * guessed: two different digests for the repository, or none, leave the item unpinned and the preview says so.
 *
 * Leaf module (no imports from the importer or the migration runs): the host inventory, the in-place scripts, the run's safety hints and
 * the executor all use it.
 */

/** `sha256:` plus 64 lower-case hex. The only digest form a pin may take. */
export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
/** What `docker image inspect` prints per RepoDigests entry. */
export const REPO_DIGEST_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,200}@sha256:[a-f0-9]{64}$/;
/** The version an image labels itself with (`org.opencontainers.image.version`), as far as the hub accepts it. */
export const VERSION_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/;
/** The ref shape the apply input and the service choices accept (no registry port: a pin the schemas refuse would fail a whole apply). */
export const EXACT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
/** A tag as docker allows it. */
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** The run hint kinds that carry an exact image (see `migration-runs/steps/import/baseline/exact-images.ts`). */
export const EXACT_IMAGE_KIND = "exact-image" as const;
export const EXACT_OFF_KIND = "exact-off" as const;
/** The label key the version is read from. */
export const OCI_VERSION_LABEL = "org.opencontainers.image.version";

export interface ImageParts {
  /** The repository as written, registry host and port kept, tag and digest cut off. */
  repo: string;
  /** The explicit tag; null when the ref names none. */
  tag: string | null;
  /** `sha256:<hex>` when the ref is pinned to a digest. */
  digest: string | null;
}

export function splitImage(image: string): ImageParts {
  const at = image.indexOf("@");
  const digest = at >= 0 ? image.slice(at + 1) : null;
  const noDigest = at >= 0 ? image.slice(0, at) : image;
  const last = noDigest.split("/").pop() ?? noDigest;
  const colon = last.indexOf(":");
  if (colon < 0) return { repo: noDigest, tag: null, digest };
  return { repo: noDigest.slice(0, noDigest.length - (last.length - colon)), tag: last.slice(colon + 1), digest };
}

/** The repository as docker prints it in RepoDigests: the Docker Hub aliases are folded (`docker.io/library/nginx` is `nginx`), lower-case. */
export function normalizedRepo(ref: string): string {
  let r = splitImage(ref).repo.toLowerCase();
  for (const pre of ["index.docker.io/", "registry-1.docker.io/", "docker.io/"]) if (r.startsWith(pre)) r = r.slice(pre.length);
  return r.startsWith("library/") ? r.slice("library/".length) : r;
}

/** Is the image already pinned to a digest (by the owner or by an earlier import)? */
export const isDigestPinned = (image: string): boolean => /@sha256:[a-f0-9]{64}$/.test(image);

/** No tag or the tag `latest`, and no digest. */
export function isFloatingTag(image: string): boolean {
  const p = splitImage(image);
  return p.digest === null && (p.tag === null || p.tag === "latest");
}

/** The digests the running image reports for the repository of `image` (distinct, valid). */
export function digestsFor(image: string, repoDigests: readonly string[] | undefined): string[] {
  const repo = normalizedRepo(image);
  const out = new Set<string>();
  for (const d of repoDigests ?? []) {
    const at = d.indexOf("@");
    if (at > 0 && DIGEST_RE.test(d.slice(at + 1)) && normalizedRepo(d.slice(0, at)) === repo) out.add(d.slice(at + 1));
  }
  return [...out];
}

export interface ExactImage {
  /** The ref the record stores: `repo:tag@sha256:...`, or `repo:<version>` when only the label is known. */
  ref: string;
  /** The tag as the source runs it (`latest` for an untagged image). */
  tag: string;
  /** The pinned digest; null when the pin is the version tag. */
  digest: string | null;
  /** The image's own version label, when it has one. */
  version: string | null;
  via: "digest" | "version";
}

/**
 * The exact image for a source image. `repoDigests` and `version` are what the running container's image reports; both may be missing
 * (an older agent, a locally built image): the answer is then null, which every caller shows as "unknown" and never as a failure.
 */
export function exactImageFor(image: string, repoDigests: readonly string[] | undefined, version?: string | null): ExactImage | null {
  if (!image || isDigestPinned(image)) return null;
  const parts = splitImage(image);
  if (parts.tag !== null && !TAG_RE.test(parts.tag)) return null;
  const tag = parts.tag ?? "latest";
  const label = version && VERSION_LABEL_RE.test(version) ? version : null;
  const digests = digestsFor(image, repoDigests);
  if (digests.length === 1) {
    const ref = `${parts.repo}:${tag}@${digests[0]}`;
    return EXACT_REF_RE.test(ref) ? { ref, tag, digest: digests[0], version: label, via: "digest" } : null;
  }
  if (digests.length === 0 && label && isFloatingTag(image) && TAG_RE.test(label) && label !== "latest") {
    const ref = `${parts.repo}:${label}`;
    return EXACT_REF_RE.test(ref) ? { ref, tag: label, digest: null, version: label, via: "version" } : null;
  }
  return null;
}

/** `sha256:` and the first twelve hex digits, for a line a person reads. */
export const shortDigest = (digest: string): string => digest.slice(0, 19);

/** The recorded form of a pin in a run hint: the ref, then a space and the version label when there is one. */
export function encodeExact(e: Pick<ExactImage, "ref" | "version">): string {
  return e.version ? `${e.ref} ${e.version}` : e.ref;
}

/** Parse {@link encodeExact}; null when the ref or the version is not one the hub accepts. */
export function decodeExact(value: string): { ref: string; version: string | null; tag: string; digest: string | null } | null {
  const sp = value.indexOf(" ");
  const ref = sp < 0 ? value : value.slice(0, sp);
  const version = sp < 0 ? null : value.slice(sp + 1);
  if (version !== null && !VERSION_LABEL_RE.test(version)) return null;
  if (!EXACT_REF_RE.test(ref)) return null;
  const p = splitImage(ref);
  if (p.digest !== null && !DIGEST_RE.test(p.digest)) return null;
  return { ref, version, tag: p.tag ?? "latest", digest: p.digest };
}

/**
 * May `pin` replace `image` in a record? Same repository (no pin ever changes what the item runs), not floating, a plain ref.
 * A ref already on a digest is never replaced by another one.
 */
export function isExactPinFor(image: string, pin: string): boolean {
  if (!image || isDigestPinned(image) || !decodeExact(pin)) return false;
  if (normalizedRepo(pin) !== normalizedRepo(image)) return false;
  const p = splitImage(pin);
  return p.digest !== null || !isFloatingTag(pin);
}
