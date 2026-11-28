import { API_BASE } from "./api";
import type { ImportPlanItem } from "./types";

/** What a plan's app item says about how it looks (all of it already in the plan, none of it secret): its image, its catalog slug, its site and its repository. */
export interface PlanAppIcon {
  image: string | null;
  templateSlug: string | null;
  /** The primary host name, without a scheme or a path. */
  domain: string | null;
  /** The GitHub login that owns the app's repository (`github.com/<owner>/<repo>`), else null. */
  githubOwner: string | null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** `https://github.com/acme/site.git`, `git@github.com:acme/site.git`, `ssh://git@github.com/acme/site` -> `acme`. Any other host -> null. */
export function githubOwnerOf(url: unknown): string | null {
  const u = text(url);
  if (!u) return null;
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:]([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/[^/\s]+$/i.exec(u);
  return m ? m[1] : null;
}

/** The host of a domain the plan lists (`https://app.example.com/path` -> `app.example.com`). */
export function hostOfDomain(v: unknown): string | null {
  const d = text(v);
  if (!d) return null;
  const host = d.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0].replace(/:\d+$/, "").toLowerCase();
  return host || null;
}

export function planAppIcon(item: Pick<ImportPlanItem, "proposed">): PlanAppIcon {
  const p = item.proposed ?? {};
  const git = p.git && typeof p.git === "object" ? (p.git as { url?: unknown }) : null;
  return { image: text(p.image), templateSlug: text(p.templateSlug), domain: hostOfDomain(p.domain), githubOwner: githubOwnerOf(git?.url) };
}

/** The hub's icon of an app that is only in a plan (a site's favicon or a GitHub avatar): same origin, so the browser contacts neither site. */
export const planIconUrl = (kind: "site" | "github", name: string): string => `${API_BASE}/migration-campaigns/icon?kind=${kind}&name=${encodeURIComponent(name)}`;
