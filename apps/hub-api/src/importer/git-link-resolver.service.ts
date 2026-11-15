import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GitSourcesService } from "../git-sources/git-sources.service";
import { apiUrlHost, isTokenKind } from "../git-sources/gitea-client";
import { mapBuildPack } from "./buildpack-map";
import { ns } from "./import-planner";
import { mapLimit } from "./sources/map-limit";
import type { ForeignApp } from "./foreign-fleet";

/**
 * Decides, per imported git app, which connected GitSource (if any) can actually clone its repository: REPO
 * VISIBILITY MATCHING (owner decision D7), keyed by the repo URL's HOST, never by the source PaaS's `git.provider`
 * flag. The old "exactly one installed GitSource => link" heuristic is gone: it could link an App that cannot see
 * the repo. Every outcome that is not a proven link is reported (never silently unlinked) and is recoverable
 * afterwards through the relink endpoint. NEVER returns or logs a credential.
 */
export type GitLinkStatus = "linked" | "public_ok" | "needs_source" | "ambiguous" | "ssh_deploy_key" | "unsupported_host" | "unknown";

export interface GitLinkRow {
  /** The plan/task itemRef (`app:<serverRef>:<sourceRef>`) for a discovered app; the task itemRef for a relink. */
  itemRef: string;
  /** The app's display name (so every app is listed by name, never only counted). */
  name: string;
  repo: { host: string; owner: string; name: string } | null;
  status: GitLinkStatus;
  sourceId?: string;
  sourceName?: string;
  candidates?: { id: string; name: string }[];
  /** Set only for an SSH GitHub URL a connected installation covers: the https URL the app is created with. */
  rewriteUrl?: string;
  /** FIXED text (no secrets, no upstream error text). */
  reason: string;
}

export const GIT_LINK_REASON: Record<GitLinkStatus, string> = {
  linked: "linked to the connected source that can see this repository",
  public_ok: "public repository: it clones without a connected source",
  needs_source: "no connected source can see this repository: connect a GitHub App installed on it, then re-check",
  ambiguous: "several connected sources can see this repository: pick one",
  ssh_deploy_key: "SSH repository: a deploy key is generated; add its public key to the repository",
  unsupported_host: "this git host has no connected source (GitLab/Bitbucket sources are not supported yet)",
  unknown: "could not determine whether a connected source can see this repository",
};

/** Above this many DISTINCT uncovered public-candidate repos the unauthenticated probe is skipped (rate-limit safety). */
export const PUBLIC_PROBE_MAX = 40;
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 8_000;

export interface ParsedRepo {
  host: string;
  owner: string;
  name: string;
  ssh: boolean;
}

/** Pure: https / http URL, `git@host:o/r(.git)`, `ssh://[user@]host[:port]/o/r(.git)` or a bare `o/r` (= github.com,
 *  as Coolify stores a GitHub-App repo). `.git` suffix and trailing slashes are dropped; host is lower-cased. */
export function parseRepoUrl(raw: string | undefined | null): ParsedRepo | null {
  const u = (raw ?? "").trim();
  if (!u) return null;
  const bare = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(u);
  if (bare && !/^[a-z][a-z0-9+.-]*:/i.test(u)) return finish("github.com", `${bare[1]}/${bare[2]}`, false);
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):(.+)$/.exec(u);
  if (scp) return finish(scp[1], scp[2], true);
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme !== "https" && scheme !== "http" && scheme !== "ssh") return null;
  return finish(m[2], m[3], scheme === "ssh");
}

function finish(host: string, path: string, ssh: boolean): ParsedRepo | null {
  const segs = path.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const name = segs[segs.length - 1];
  const owner = segs.slice(0, -1).join("/");
  if (!/^[A-Za-z0-9._-]+$/.test(name) || !/^[A-Za-z0-9._/-]+$/.test(owner) || segs.some((s) => s === "." || s === "..")) return null;
  return { host: host.toLowerCase(), owner, name, ssh };
}

/** Does this app clone a repository whose link we should resolve (GIT build, or a git-sourced compose)? */
export function needsGitLink(app: ForeignApp): boolean {
  if (!app.git?.url) return false;
  const src = mapBuildPack(app).source;
  return src === "GIT" || (src === "COMPOSE" && !app.composeFile);
}

interface Candidate {
  id: string;
  name: string;
  kind: "github" | "token";
  host: string; // the only host this source authenticates
}

@Injectable()
export class GitLinkResolverService {
  private readonly logger = new Logger(GitLinkResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gitSources: GitSourcesService,
  ) {}

  /** Resolve every git app (apps that carry a `gitProviderRef` keep the carried-source path and are skipped here).
   *  Keyed by the app's `sourceRef`. Caller has already authorized `teamId` (the target server's team). */
  async resolve(teamId: string, apps: ForeignApp[]): Promise<Map<string, GitLinkRow>> {
    return this.resolveRepos(
      teamId,
      apps
        .filter((a) => needsGitLink(a) && !a.gitProviderRef)
        .map((a) => ({ key: a.sourceRef, itemRef: ns("app", a.serverRef, a.sourceRef), name: a.name, url: a.git?.url })),
    );
  }

  /** The URL-level core, shared with the post-import relink (which only has each created app's stored repo URL).
   *  Keyed by the caller's `key`. */
  async resolveRepos(teamId: string, todo: Array<{ key: string; itemRef: string; name: string; url: string | null | undefined }>): Promise<Map<string, GitLinkRow>> {
    const rows = new Map<string, GitLinkRow>();
    if (todo.length === 0) return rows;

    let candidates: Candidate[] = [];
    let sourcesOk = true;
    try {
      const all = await this.prisma.gitSource.findMany({ where: { teamId }, select: { id: true, name: true, provider: true, apiUrl: true, installationId: true } });
      candidates = all.flatMap((s): Candidate[] => {
        if (isTokenKind(s.provider)) return s.apiUrl ? [{ id: s.id, name: s.name, kind: "token", host: apiUrlHost(s.apiUrl) }] : [];
        return s.installationId ? [{ id: s.id, name: s.name, kind: "github", host: "github.com" }] : [];
      });
    } catch {
      sourcesOk = false; // cannot even list the team's sources: every app is reported unknown, never guessed
    }

    // Per-call caches: one installation listing per source, one Gitea probe per (source, repo).
    const repoSets = new Map<string, Promise<Set<string> | null>>();
    const installationSet = (id: string): Promise<Set<string> | null> => {
      let p = repoSets.get(id);
      if (!p) {
        p = this.gitSources.installationRepoSet(id).catch(() => null);
        repoSets.set(id, p);
      }
      return p;
    };
    const tokenSees = new Map<string, Promise<"yes" | "no" | "unknown">>();
    const tokenSource = (id: string, owner: string, name: string): Promise<"yes" | "no" | "unknown"> => {
      const k = `${id}|${owner}/${name}`.toLowerCase();
      let p = tokenSees.get(k);
      if (!p) {
        p = this.gitSources.tokenSourceCanSee(id, owner, name).catch(() => "unknown" as const);
        tokenSees.set(k, p);
      }
      return p;
    };

    // Pass 1: classify by visibility. Apps no candidate covers are collected for the public probe.
    const pending: Array<{ app: (typeof todo)[number]; repo: ParsedRepo }> = [];
    await mapLimit(todo, 6, async (app) => {
      const repo = parseRepoUrl(app.url);
      const set = (row: Omit<GitLinkRow, "itemRef" | "name" | "reason">) => rows.set(app.key, { itemRef: app.itemRef, name: app.name, reason: GIT_LINK_REASON[row.status], ...row });
      if (!repo) return set({ repo: null, status: "unknown" });
      const repoView = { host: repo.host, owner: repo.owner, name: repo.name };
      try {
        if (!sourcesOk) return set({ repo: repoView, status: "unknown" });
        const hostCands = candidates.filter((c) => c.host === repo.host);
        if (repo.host !== "github.com" && hostCands.length === 0) return set({ repo: repoView, status: "unsupported_host" });

        const full = `${repo.owner}/${repo.name}`.toLowerCase();
        const sees: Candidate[] = [];
        let unknown = false;
        for (const c of hostCands) {
          if (c.kind === "github") {
            const s = await installationSet(c.id);
            if (s === null) unknown = true;
            else if (s.has(full)) sees.push(c);
          } else {
            const v = await tokenSource(c.id, repo.owner, repo.name);
            if (v === "yes") sees.push(c);
            else if (v === "unknown") unknown = true;
          }
        }
        if (sees.length === 1) {
          const c = sees[0];
          // An SSH GitHub URL a connected installation covers is converted to https (an App token never authenticates ssh).
          const rewriteUrl = repo.ssh && repo.host === "github.com" ? `https://github.com/${repo.owner}/${repo.name}.git` : undefined;
          if (repo.ssh && !rewriteUrl) return set({ repo: repoView, status: "ssh_deploy_key" }); // non-GitHub ssh: keep the deploy-key path
          return set({ repo: repoView, status: "linked", sourceId: c.id, sourceName: c.name, ...(rewriteUrl ? { rewriteUrl } : {}) });
        }
        if (sees.length > 1) return set({ repo: repoView, status: "ambiguous", candidates: sees.map((c) => ({ id: c.id, name: c.name })) });
        // Nothing proven. A source we could not interrogate makes the answer unknown, not "uncovered".
        if (unknown) return set({ repo: repoView, status: "unknown" });
        if (repo.ssh) return set({ repo: repoView, status: "ssh_deploy_key" });
        if (repo.host === "github.com") {
          pending.push({ app, repo });
          return;
        }
        return set({ repo: repoView, status: "needs_source" });
      } catch (e) {
        // Never fall back to a guess: an exception leaves the app unlinked and reported.
        this.logger.warn(`git link resolve failed for an app: ${e instanceof Error ? e.constructor.name : "error"}`);
        return set({ repo: repoView, status: "unknown" });
      }
    });

    // Pass 2: ONE unauthenticated probe per distinct uncovered github.com repo (only when the set is small).
    const distinct = new Map<string, ParsedRepo>();
    for (const p of pending) distinct.set(`${p.repo.owner}/${p.repo.name}`.toLowerCase(), p.repo);
    const verdicts = new Map<string, "public" | "private" | "unknown">();
    if (distinct.size > 0 && distinct.size <= PUBLIC_PROBE_MAX) {
      await mapLimit([...distinct.entries()], PROBE_CONCURRENCY, async ([k, r]) => {
        verdicts.set(k, await probePublicGithub(r.owner, r.name));
      });
    }
    for (const { app, repo } of pending) {
      const k = `${repo.owner}/${repo.name}`.toLowerCase();
      const probed = distinct.size <= PUBLIC_PROBE_MAX;
      const v = verdicts.get(k);
      const status: GitLinkStatus = !probed ? "needs_source" : v === "public" ? "public_ok" : v === "private" ? "needs_source" : "unknown";
      rows.set(app.key, { itemRef: app.itemRef, name: app.name, repo: { host: repo.host, owner: repo.owner, name: repo.name }, status, reason: GIT_LINK_REASON[status] });
    }
    return rows;
  }
}

/** ONE unauthenticated `GET https://api.github.com/repos/o/r`. 200 => public. 404 => private (or gone): no connected
 *  source covers it, so the operator must connect one. 403/429/any failure => unknown (it may be OUR rate limit). */
async function probePublicGithub(owner: string, name: string): Promise<"public" | "private" | "unknown"> {
  try {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status === 200 ? "public" : res.status === 404 ? "private" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Short summary of resolver rows grouped by owner for the review UI ("74 apps => 1-3 groups"). */
export function groupGitLinks(rows: GitLinkRow[]): Array<{ host: string; owner: string; apps: number; status: GitLinkStatus; sourceName?: string }> {
  const groups = new Map<string, { host: string; owner: string; apps: number; status: GitLinkStatus; sourceName?: string }>();
  for (const r of rows) {
    const host = r.repo?.host ?? "unknown";
    const owner = r.repo?.owner ?? "";
    const key = `${host}|${owner}|${r.status}|${r.sourceName ?? ""}`;
    const g = groups.get(key);
    if (g) g.apps++;
    else groups.set(key, { host, owner, apps: 1, status: r.status, ...(r.sourceName ? { sourceName: r.sourceName } : {}) });
  }
  return [...groups.values()].sort((a, b) => (a.host + a.owner + a.status < b.host + b.owner + b.status ? -1 : 1));
}
