// Inline Dockerfile client-side checks, mirroring the hub DTO (`inlineDockerfileProblem`): no NUL byte, 48 KiB cap
// (BYTES), and the first non-ARG instruction must be FROM (BOM / blank lines / comments / parser directives skipped).
export const INLINE_DOCKERFILE_MAX = 48 * 1024;

export type InlineDockerfileProblem = "nul" | "no_from" | "too_large" | null;

export function inlineDockerfileBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function inlineDockerfileProblem(text: string): InlineDockerfileProblem {
  if (text.includes("\0")) return "nul";
  if (inlineDockerfileBytes(text) > INLINE_DOCKERFILE_MAX) return "too_large";
  let cont = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (cont) {
      cont = line.endsWith("\\");
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    if (/^ARG(\s|$)/i.test(line)) {
      cont = line.endsWith("\\");
      continue;
    }
    return /^FROM(\s|$)/i.test(line) ? null : "no_from";
  }
  return "no_from";
}
