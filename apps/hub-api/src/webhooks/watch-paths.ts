/**
 * Watch paths: glob patterns that decide whether a git push should trigger a deploy. For a monorepo this
 * stops every push from rebuilding every app — only a push that touches a watched path deploys.
 *
 * Pure + dependency-free (no picomatch dep; the patterns are DTO-validated to a safe charset and capped, and
 * the generated regexes use only linear `.*` / `[^/]*` so there is no ReDoS). FAIL-OPEN: the webhook handler
 * only consults this when watchPaths is non-empty AND the push payload actually lists changed files; a
 * truncated / fileless / unparseable payload deploys as before, so a real deploy is never silently skipped.
 */

/** Expand ONE level of `{a,b,c}` alternations in a pattern into multiple patterns (no nesting). `a{b,c}d`
 *  → [`abd`, `acd`]. A pattern with no braces returns itself. Unbalanced braces are left literal. */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  const close = pattern.indexOf("}", open);
  if (close === -1) return [pattern];
  const pre = pattern.slice(0, open);
  const post = pattern.slice(close + 1);
  const alts = pattern.slice(open + 1, close).split(",");
  // Recurse on `post` so a second brace group in the same pattern also expands.
  return alts.flatMap((alt) => expandBraces(`${pre}${alt}${post}`));
}

/** Compile a glob (after brace expansion) to an anchored RegExp. `**` matches across `/`; `*` matches within
 *  a path segment; `?` matches one non-`/` char; every other char is matched literally. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"; // `**` — any chars incl. `/`
        i++;
        // Swallow a `/` right after `**` so `a/**/b` also matches `a/b` (zero intermediate dirs).
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*"; // `*` — within a segment
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`; // escape regex metachars so they match literally
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** A changed file is "watched" if it matches at least one positive pattern (or there are no positives, in
 *  which case everything is a candidate) AND matches no negative (`!`-prefixed) pattern. */
function fileWatched(file: string, positives: RegExp[], negatives: RegExp[]): boolean {
  if (negatives.some((re) => re.test(file))) return false;
  if (positives.length === 0) return true;
  return positives.some((re) => re.test(file));
}

/** True if the push (its `changedFiles`) should trigger a deploy given `patterns`. Patterns are globs;
 *  a leading `!` marks a negation (exclude). The push deploys when ANY changed file is watched. Callers pass
 *  a NON-EMPTY `patterns` and a NON-EMPTY `changedFiles` — emptiness is the fail-open signal handled upstream. */
export function pushMatchesWatchPaths(changedFiles: string[], patterns: string[]): boolean {
  const positives: RegExp[] = [];
  const negatives: RegExp[] = [];
  for (const raw of patterns) {
    const neg = raw.startsWith("!");
    const body = (neg ? raw.slice(1) : raw).replace(/^\/+/, ""); // repo-relative
    if (!body) continue;
    for (const expanded of expandBraces(body)) {
      (neg ? negatives : positives).push(globToRegExp(expanded));
    }
  }
  return changedFiles.some((f) => fileWatched(f.replace(/^\/+/, ""), positives, negatives));
}

/**
 * Pull the changed-file list out of a GitHub / GitLab push payload (union of every commit's
 * added/modified/removed). Returns null when the payload carries no usable file list (no commits array, or
 * the union is empty — a truncated or fileless push), which the caller treats as fail-open (deploy anyway).
 */
export function parseChangedFiles(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const commits = (payload as { commits?: unknown }).commits;
  if (!Array.isArray(commits) || commits.length === 0) return null;
  const files = new Set<string>();
  for (const c of commits) {
    if (!c || typeof c !== "object") continue;
    for (const key of ["added", "modified", "removed"] as const) {
      const list = (c as Record<string, unknown>)[key];
      if (Array.isArray(list)) for (const f of list) if (typeof f === "string" && f) files.add(f);
    }
  }
  return files.size > 0 ? [...files] : null;
}
