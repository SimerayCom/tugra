/**
 * Shared image-ref pinning helpers used by BOTH the agent and the migrator install-script renderers,
 * so the arch digest-pin block is byte-identical across them (extracted from agent-install-script.ts
 * without changing a single emitted character — agent-install-script.spec.ts guards that).
 */

/** A conservative image-ref charset (registry/repo:tag@digest). Defensive — the ref is operator config. */
export const IMAGE_RE = /^[A-Za-z0-9._/:@-]+$/;
/** A docker image digest is exactly 64 lowercase hex chars. */
export const SHA256_RE = /^[a-f0-9]{64}$/;

export type ArchDigests = { amd64: string; arm64: string };

/**
 * Throw unless `image` is a safe ref and (when supplied) both digests are 64-hex. The messages are the
 * exact strings the install-script specs assert, so a renderer's bad-digest / unsafe-ref behaviour and
 * the InstallController's bare-tag fallback stay unchanged.
 */
export function assertPinnable(image: string, digests?: ArchDigests): void {
  if (!IMAGE_RE.test(image)) {
    throw new Error(`refusing to render install script for unsafe image ref: ${JSON.stringify(image)}`);
  }
  if (digests && (!SHA256_RE.test(digests.amd64) || !SHA256_RE.test(digests.arm64))) {
    throw new Error("refusing to render install script with an invalid agent image digest");
  }
}

/**
 * The arch-aware digest-pin sh lines (empty array when no digests). It sets IMAGE to `image@sha256:<arch>`
 * BEFORE the script parses args, so an explicit `--image` still overrides. The lines are emitted exactly
 * as the agent installer always has (same quoting + two-space indent).
 */
export function archPinLines(image: string, digests?: ArchDigests): string[] {
  if (!digests) return [];
  return [
    '_arch="$(uname -m 2>/dev/null || echo unknown)"',
    'case "$_arch" in',
    `  x86_64|amd64) IMAGE="${image}@sha256:${digests.amd64}" ;;`,
    `  aarch64|arm64) IMAGE="${image}@sha256:${digests.arm64}" ;;`,
    "esac",
  ];
}
