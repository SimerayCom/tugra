/**
 * Derive browsable web URLs from a git CLONE url (+ optional commit SHA), for the "Open repository" /
 * "Open commit" convenience links. Pure + tested so the SourceCard stays presentation-only.
 *
 * Handles the three clone forms Tugra accepts:
 *   https://host/owner/repo(.git)              (optionally with an x-access-token@ / user@ credential)
 *   git@host:owner/repo(.git)                  (scp-style SSH)
 *   ssh://git@host[:port]/owner/repo(.git)     (ssh URL)
 *
 * Returns only an https:// URL (never javascript:/data: — the result is put in an href), or null when the
 * input is not a recognisable git host URL. The commit path uses the /commit/<sha> convention shared by
 * GitHub, GitLab and Gitea/Forgejo (Bitbucket differs, so a commit link may 404 there — a harmless nicety).
 */
export function gitWebUrls(gitUrl: string | null | undefined, commit?: string | null): { repo: string | null; commit: string | null } {
  const none = { repo: null, commit: null };
  const raw = (gitUrl ?? "").trim();
  if (!raw) return none;

  let host = "";
  let path = ""; // owner/repo, no leading slash, no .git

  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(raw); // git@host:owner/repo
  if (scp && !raw.includes("://")) {
    host = scp[1];
    path = scp[2];
  } else {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return none;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "ssh:") return none;
    host = u.hostname; // drops any user:token@ credential and the port
    path = u.pathname.replace(/^\/+/, "");
  }

  host = host.trim().toLowerCase();
  path = path.replace(/^\/+/, "").replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  // A plausible host (has a dot) and a non-empty path. Reject anything else rather than emit a junk link.
  if (!host || !/^[a-z0-9.-]+\.[a-z0-9.-]+$/.test(host) || !path || /\s/.test(path)) return none;

  const repo = `https://${host}/${path}`;
  const sha = (commit ?? "").trim();
  const commitUrl = /^[0-9a-f]{7,40}$/i.test(sha) ? `${repo}/commit/${sha}` : null;
  return { repo, commit: commitUrl };
}
