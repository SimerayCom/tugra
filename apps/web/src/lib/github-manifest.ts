/** Only ever post the manifest to GitHub itself (the hub's answer is checked, so a tampered response cannot redirect the form). */
export function isGithubPostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "github.com" && /^\/(settings|organizations\/[^/]+\/settings)\/apps\/new$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Where the install page (and only that) may send the browser next. */
export function isGithubInstallUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "github.com" && /^\/apps\/[^/]+\/installations\/new$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** GitHub's manifest flow wants a real browser form POST (a `manifest` field), not a fetch. */
export function postManifestToGithub(postUrl: string, manifest: Record<string, unknown>): void {
  if (!isGithubPostUrl(postUrl)) throw new Error("unexpected GitHub address");
  const form = document.createElement("form");
  form.method = "post";
  form.action = postUrl;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

/** A PEM private key as GitHub hands out (PKCS#1 "RSA PRIVATE KEY" or PKCS#8 "PRIVATE KEY"). */
export function looksLikePrivateKey(text: string): boolean {
  return /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----/.test(text);
}

/** The GitHub org login rule (letters, digits, single inner hyphens, 39 max). */
export function isGithubLogin(v: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(v);
}

/** Case-insensitive substring filter over repository names. */
export function filterRepos<T extends { fullName: string }>(repos: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  return needle ? repos.filter((r) => r.fullName.toLowerCase().includes(needle)) : repos;
}

/** Can GitHub reach this URL from the internet? false for localhost, private ranges and dotless host names. */
export function isPubliclyReachable(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || /\.(localhost|local|internal|lan)$/.test(host)) return false;
  if (host.startsWith("[")) return !(host === "[::1]" || /^\[(fc|fd|fe80)/.test(host));
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  return host.includes(".");
}
