/** A post-login return path from `?next=`: only a same-origin absolute path is accepted, anything else is dropped. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 4096) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  return raw;
}
