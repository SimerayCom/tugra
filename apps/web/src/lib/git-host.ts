/**
 * Lower-cased host of an https:// (or other `scheme://`) git URL, or null when the URL is an SSH form
 * (`ssh://…` or scp-style `git@host:path`) or can't be parsed. Mirrors the hub's host pinning, which decides
 * whether a connected Git provider's credential may be used for a repository: a provider only authenticates
 * its own host, and SSH repositories clone with a deploy key instead.
 */
export function gitUrlHost(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  if (!u || isSshGitUrl(u)) return null;
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/]+)/.exec(u);
  return m ? m[1].toLowerCase() : null;
}

/** An SSH-form git URL: `ssh://…` or scp-style `user@host:path`. */
export function isSshGitUrl(url: string | null | undefined): boolean {
  const u = (url ?? "").trim();
  return /^ssh:\/\//i.test(u) || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(u);
}
