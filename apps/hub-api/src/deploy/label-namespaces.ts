/**
 * Container-label namespaces Tugra (and Docker's compose/swarm tooling) own. A user label in one of these
 * would hijack ingress routing (traefik.*), spoof Tugra's own lookups (tugra.* — e.g. `tugra.role=gpu-probe`
 * makes gpu-probe cleanup `docker rm -f` the app) or impersonate a compose project / swarm stack.
 * Pure, no imports: the single predicate every gate (dockerOptions, structured editor, compose, builders) uses.
 */
export const RESERVED_LABEL_PREFIXES = [
  "traefik.",
  "tugra.",
  "com.docker.compose.",
  "com.docker.swarm.",
  "com.docker.stack.",
] as const;

/** Short reason per reserved prefix, used in error text. */
export const LABEL_NAMESPACE_WHY: Record<string, string> = {
  "traefik.": "owned by Tugra's ingress routing and would hijack shared proxy routes",
  "tugra.": "Tugra's own bookkeeping labels",
  "com.docker.compose.": "Docker Compose project/service identity",
  "com.docker.swarm.": "Docker Swarm service identity",
  "com.docker.stack.": "Docker stack identity",
};

/** The reserved prefix this label key falls under (case-insensitive, trimmed), or null when it is free to use. */
export function reservedLabelNamespace(key: string): string | null {
  const k = String(key).trim().toLowerCase();
  for (const p of RESERVED_LABEL_PREFIXES) if (k.startsWith(p)) return p;
  return null;
}

/** Bounds for an app's custom container labels. totalBytes = UTF-8 bytes of every key + value. Lives here (a
 *  dependency-free module) so the DTO layer can use it without importing the script builders (import cycle). */
export const CUSTOM_LABEL_LIMITS = { maxCount: 32, keyMax: 128, valueMax: 1024, totalBytes: 16384 };

/** Key charset: starts alphanumeric, then [A-Za-z0-9._/@:-]. No `=`, whitespace, quotes or control characters. */
export const CUSTOM_LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/;
