/**
 * Tugra's ed25519 LICENSE public key — the trust anchor for signed-license entitlements.
 *
 * ⚠️ SECURITY: this is a COMPILED-IN source constant on purpose, NOT an env var. If the public key came
 * from the environment, a self-hosting operator could substitute their own key and self-sign a Pro/Cloud
 * license — defeating the whole "an operator cannot self-grant a paid edition" guarantee (an env value,
 * even one baked into the image, is overridable at `docker run -e`/compose runtime). Compiling it in means
 * changing the anchor requires forking + rebuilding the AGPL core, which is outside the threat model.
 *
 * Trust anchor for signed-license verification. Compiled in at build time (not an env var) so an operator
 * cannot substitute their own key.
 *
 * To rotate/set: paste the base64 of `publicKey.export({ type: "spki", format: "der" })`.
 */
export const TUGRA_LICENSE_PUBLIC_KEY = "";
