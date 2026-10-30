// Pure fuzzy search + ranking for the command palette (⌘K). No React/DOM, so it is fully unit-tested.
// A query is a case-insensitive SUBSEQUENCE of a candidate; a score ranks matches with the usual signals
// (prefix / word-start / camelCase / consecutive / exact-case bonuses, shorter-label tiebreak). Multi-term
// AND across the label + a muted secondary string. Results are grouped, per-group capped, and flattened into
// the single ordered list the keyboard navigates.
import type { Application, ServerView, Database, DomainView } from "./types";
import { scopeByTeam } from "./team-scope";
import { engineLabel } from "./databases";

export type PaletteGroup = "actions" | "navigate" | "apps" | "databases" | "servers" | "domains";
export const GROUP_ORDER: PaletteGroup[] = ["actions", "navigate", "apps", "databases", "servers", "domains"];

export interface PaletteItem {
  id: string; // unique: "nav:/apps", "act:/servers/new", "app:<id>", "db:<id>", "srv:<id>", "dom:<id>"
  group: PaletteGroup;
  label: string; // already translated / resource name / domain
  secondary?: string; // searchable + shown muted (project·env, engine version, hostname·ip, owning app)
  href: string;
  status?: string;
}
export interface RankedItem { item: PaletteItem; score: number; labelIdx: number[] }
export interface RankedGroup { group: PaletteGroup; items: RankedItem[]; total: number }

const NEG = -Infinity;
const isWordChar = (c: string) => /[a-z0-9]/i.test(c);
function bonus(t: string, j: number): number {
  if (j === 0) return 8; // string prefix
  const p = t[j - 1], c = t[j];
  if (!isWordChar(p)) return 6; // after a separator (space - _ / . :) → word start
  if (p === p.toLowerCase() && c !== c.toLowerCase() && isWordChar(c)) return 4; // camelCase hump
  return 0;
}

/** Subsequence match with a DP score; null when `query` isn't a subsequence of `text`. Returns the matched
 *  character indices (for highlighting). An empty query trivially matches with score 0. */
export function fuzzyMatch(query: string, text: string): { score: number; indices: number[] } | null {
  const raw = query.replace(/\s+/g, "");
  const q = raw.toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.slice(0, 120), tl = t.toLowerCase(), n = t.length, m = q.length;
  if (m > n) return null;
  const sc: number[][] = [], bp: number[][] = [];
  for (let i = 0; i < m; i++) {
    sc.push(new Array(n).fill(NEG));
    bp.push(new Array(n).fill(-1));
    for (let j = i; j < n; j++) {
      if (tl[j] !== q[i]) continue;
      const own = 1 + bonus(t, j) + (t[j] === raw[i] ? 1 : 0); // exact-case +1
      if (i === 0) { sc[0][j] = own - Math.min(j, 3); continue; } // capped leading gap
      let best = NEG, from = -1;
      for (let k = i - 1; k < j; k++) {
        const p = sc[i - 1][k];
        if (p === NEG) continue;
        const v = p + (k === j - 1 ? 5 : -(j - k - 1)); // consecutive +5, else −1 per skipped char
        if (v > best) { best = v; from = k; }
      }
      if (from >= 0) { sc[i][j] = best + own; bp[i][j] = from; }
    }
  }
  let bj = -1, bs = NEG;
  for (let j = 0; j < n; j++) if (sc[m - 1][j] > bs) { bs = sc[m - 1][j]; bj = j; }
  if (bj < 0) return null;
  const indices: number[] = [];
  for (let i = m - 1, j = bj; i >= 0; i--) { indices.unshift(j); j = bp[i][j]; }
  let score = bs - n * 0.05; // shorter labels win ties
  if (tl.startsWith(q)) score += 10; // whole-query prefix
  if (tl === q) score += 10; // exact
  return { score, indices };
}

/** Score one item against a query (multi-term AND over label + secondary); null if any term fails to match. */
export function scoreItem(item: PaletteItem, query: string): { score: number; labelIdx: number[] } | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, labelIdx: [] };
  let total = 0;
  const idx = new Set<number>();
  for (const term of terms) {
    const onLabel = fuzzyMatch(term, item.label);
    const onSecondary = item.secondary ? fuzzyMatch(term, item.secondary) : null;
    const labelScore = onLabel ? onLabel.score : NEG;
    const secScore = onSecondary ? onSecondary.score - 12 : NEG; // label-first: secondary matches rank lower
    if (labelScore === NEG && secScore === NEG) return null; // this term matched neither → drop the item
    total += Math.max(labelScore, secScore);
    if (onLabel && labelScore >= secScore) for (const i of onLabel.indices) idx.add(i);
  }
  if (item.group === "actions" || item.group === "navigate") total += 6; // static destinations win close ties
  return { score: total, labelIdx: [...idx].sort((a, b) => a - b) };
}

/** Rank + group + cap. Empty query → original order (actions/navigate uncapped, resource groups capped). */
export function searchPalette(items: PaletteItem[], query: string, opts: { capPerGroup?: number; emptyResourceCap?: number } = {}): RankedGroup[] {
  const cap = opts.capPerGroup ?? 6;
  const emptyCap = opts.emptyResourceCap ?? 3;
  const q = query.trim();
  const byGroup = new Map<PaletteGroup, RankedItem[]>();
  items.forEach((item, i) => {
    if (q) {
      const m = scoreItem(item, q);
      if (!m) return;
      (byGroup.get(item.group) ?? byGroup.set(item.group, []).get(item.group)!).push({ item, score: m.score, labelIdx: m.labelIdx });
    } else {
      (byGroup.get(item.group) ?? byGroup.set(item.group, []).get(item.group)!).push({ item, score: -i, labelIdx: [] }); // -i keeps original order
    }
  });
  const groups: RankedGroup[] = [];
  for (const [group, arr] of byGroup) {
    arr.sort((a, b) => b.score - a.score || items.indexOf(a.item) - items.indexOf(b.item));
    const perCap = q ? cap : group === "actions" || group === "navigate" ? Infinity : emptyCap;
    groups.push({ group, items: arr.slice(0, perCap), total: arr.length });
  }
  // Query → order groups by their best item's score; empty → fixed GROUP_ORDER.
  groups.sort((a, b) => {
    if (q) { const d = (b.items[0]?.score ?? NEG) - (a.items[0]?.score ?? NEG); if (d) return d; }
    return GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
  });
  return groups.filter((g) => g.items.length > 0);
}

/** The single ordered list keyboard nav indexes into (row i of the render === flat[i]). */
export function flatten(groups: RankedGroup[]): RankedItem[] {
  return groups.flatMap((g) => g.items);
}

/** Split `text` into runs, marking the matched characters (merges adjacent indices) for <mark> rendering. */
export function highlightParts(text: string, idx: number[]): { s: string; hit: boolean }[] {
  if (!idx.length) return [{ s: text, hit: false }];
  const hit = new Set(idx);
  const parts: { s: string; hit: boolean }[] = [];
  let cur = "", curHit = hit.has(0);
  for (let i = 0; i < text.length; i++) {
    const h = hit.has(i);
    if (h !== curHit) { if (cur) parts.push({ s: cur, hit: curHit }); cur = ""; curHit = h; }
    cur += text[i];
  }
  if (cur) parts.push({ s: cur, hit: curHit });
  return parts;
}

/** Build searchable palette items from the four live resource lists (team-scoped). */
export function buildResourceItems(
  d: { apps: Application[]; servers: ServerView[]; databases: Database[]; domains: DomainView[] },
  teamId: string | null,
): PaletteItem[] {
  const join = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).join(" · ");
  const apps = scopeByTeam(d.apps, teamId).map((a): PaletteItem => ({
    id: "app:" + a.id, group: "apps", label: a.name, secondary: join(a.domain, a.projectName, a.environmentName), href: `/apps/${a.id}`, status: a.status,
  }));
  const databases = scopeByTeam(d.databases, teamId).map((x): PaletteItem => ({
    id: "db:" + x.id, group: "databases", label: x.name, secondary: join(`${engineLabel(x.engine)} ${x.version}`, x.projectName, x.environmentName), href: `/databases/${x.id}`, status: x.status,
  }));
  const servers = scopeByTeam(d.servers, teamId).map((s): PaletteItem => ({
    id: "srv:" + s.id, group: "servers", label: s.name, secondary: join(s.hostname, s.publicIp, s.clusterName), href: `/servers/${s.id}`, status: s.status,
  }));
  const domains = scopeByTeam(d.domains, teamId).map((x): PaletteItem => ({
    id: "dom:" + x.id, group: "domains", label: x.domain, secondary: x.name, href: `/apps/${x.appId}`,
  }));
  return [...apps, ...databases, ...servers, ...domains];
}
