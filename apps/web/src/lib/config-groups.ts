/**
 * Single source of truth for the app Configuration tab's left sub-nav.
 *
 * Each card declares which group it belongs to and when it is visible. The page
 * renders the groups that have at least one visible card, so a COMPOSE app (which
 * hides most build/resource cards) simply shows fewer menu entries. Keeping the
 * gating here — not inline in page.tsx — makes it unit-testable without rendering,
 * and the `ConfigCardId` union forces every card to have a group at compile time.
 */

export const CONFIG_GROUPS = [
  { key: "general", labelKey: "apps.cfgGroupGeneral" },
  { key: "build", labelKey: "apps.cfgGroupBuild" },
  { key: "environment", labelKey: "apps.cfgGroupEnvironment" },
  { key: "domains", labelKey: "apps.cfgGroupDomains" },
  { key: "storage", labelKey: "apps.cfgGroupStorage" },
  { key: "health-resources", labelKey: "apps.cfgGroupHealthResources" },
  { key: "automation", labelKey: "apps.cfgGroupAutomation" },
] as const;

export type ConfigGroupKey = (typeof CONFIG_GROUPS)[number]["key"];
export const CONFIG_GROUP_KEYS: string[] = CONFIG_GROUPS.map((g) => g.key);
export const DEFAULT_CONFIG_GROUP: ConfigGroupKey = "general";

export type ConfigCardId =
  | "deploySettings"
  | "clusterDeploy"
  | "environment"
  | "tags"
  | "source"
  | "build"
  | "buildConfig"
  | "buildArgs"
  | "dockerOptions"
  | "credentials"
  | "env"
  | "databaseLinks"
  | "expose"
  | "domain"
  | "extraDomains"
  | "serviceDomains"
  | "domainOptions"
  | "customCert"
  | "volumes"
  | "hostMounts"
  | "volumeBackups"
  | "configMounts"
  | "healthCheck"
  | "limits"
  | "scheduledTasks"
  | "deployHooks"
  | "webhooks"
  | "watchPaths"
  | "preview";

/** The subset of an app's detail the gating predicates read. `AppDetail` satisfies this. */
export interface ConfigGatingFacts {
  source: string;
  isPreview: boolean;
  canWrite: boolean;
  clusterId: string | null;
  webhookToken: string | null;
  domain: string | null;
  domainKind: string | null;
  volumes: readonly unknown[];
  hasConfigMounts: boolean;
  composePath: string | null; // set → a COMPOSE app sourced from git (editable source), vs a pasted compose
}

const notCompose = (a: ConfigGatingFacts) => a.source !== "COMPOSE";
/** A COMPOSE app sourced from git edits its repo/branch/path like a GIT app (vs a pasted compose). */
const isGitCompose = (a: ConfigGatingFacts) => a.source === "COMPOSE" && !!a.composePath;

/**
 * Every card, in display order within its group. The visibility predicates are
 * copied verbatim from the former inline JSX gates in page.tsx — keep them in sync.
 */
export const CONFIG_CARDS: { id: ConfigCardId; group: ConfigGroupKey; visible: (a: ConfigGatingFacts) => boolean }[] = [
  // General
  { id: "deploySettings", group: "general", visible: notCompose },
  { id: "clusterDeploy", group: "general", visible: notCompose },
  { id: "environment", group: "general", visible: () => true },
  { id: "tags", group: "general", visible: (a) => !a.isPreview },
  // Build
  // Edit where the code/image comes from (GIT repo+branch / IMAGE ref) after create; COMPOSE edits via its file.
  { id: "source", group: "build", visible: (a) => (notCompose(a) || isGitCompose(a)) && a.canWrite && !a.isPreview },
  // Edit how a Git app is built (build pack + its fields). GIT only.
  { id: "build", group: "build", visible: (a) => a.source === "GIT" && a.canWrite && !a.isPreview },
  { id: "buildConfig", group: "build", visible: notCompose },
  { id: "buildArgs", group: "build", visible: (a) => a.source === "GIT" },
  { id: "dockerOptions", group: "build", visible: notCompose },
  { id: "credentials", group: "build", visible: () => true },
  // Environment
  { id: "env", group: "environment", visible: () => true },
  // Database links inject a managed DB's connection URI into the app's env; v1 is classic (non-swarm,
  // non-compose) apps only, so hide the card where linking can never work.
  { id: "databaseLinks", group: "environment", visible: (a) => notCompose(a) && !a.isPreview && !a.clusterId },
  // Domains & Network
  { id: "expose", group: "domains", visible: (a) => a.canWrite && !a.isPreview },
  { id: "domain", group: "domains", visible: (a) => a.canWrite && !a.isPreview && a.domainKind === "custom" },
  // Extra alias hostnames: needs a primary domain + write access, classic/compose only (no swarm), not a preview.
  { id: "extraDomains", group: "domains", visible: (a) => a.canWrite && !a.isPreview && !!a.domain && !a.clusterId },
  // Per-service domains: COMPOSE apps only (route individual services to their own hostnames).
  { id: "serviceDomains", group: "domains", visible: (a) => a.source === "COMPOSE" && a.canWrite && !a.isPreview && !a.clusterId },
  { id: "domainOptions", group: "domains", visible: (a) => !!a.domain },
  // Upload a custom TLS cert for this app's domain (served statically, no ACME). Needs a domain + write access.
  { id: "customCert", group: "domains", visible: (a) => a.canWrite && !a.isPreview && !!a.domain },
  // Storage
  { id: "volumes", group: "storage", visible: notCompose },
  // Host folder bind-mounts (e.g. a media library) — docker-run apps only; a COMPOSE stack declares its own.
  { id: "hostMounts", group: "storage", visible: notCompose },
  { id: "volumeBackups", group: "storage", visible: (a) => notCompose(a) && a.volumes.length > 0 },
  { id: "configMounts", group: "storage", visible: (a) => a.source === "COMPOSE" && a.canWrite && a.hasConfigMounts },
  // Health & Resources
  { id: "healthCheck", group: "health-resources", visible: notCompose },
  { id: "limits", group: "health-resources", visible: notCompose },
  // Automation
  { id: "scheduledTasks", group: "automation", visible: notCompose },
  // Pre/post-deploy hook commands run in a container of the app image; v1 is classic (non-swarm,
  // non-compose, non-preview) apps only — hide the card where execution is not wired.
  { id: "deployHooks", group: "automation", visible: (a) => notCompose(a) && !a.clusterId && !a.isPreview },
  { id: "webhooks", group: "automation", visible: (a) => !!a.webhookToken },
  // Watch paths gate which pushes deploy — git-sourced apps only (a GIT build or a compose-from-git app).
  { id: "watchPaths", group: "automation", visible: (a) => (a.source === "GIT" || isGitCompose(a)) && a.canWrite && !a.isPreview },
  { id: "preview", group: "automation", visible: (a) => !a.isPreview && a.source === "GIT" },
];

export interface VisibleConfigGroup {
  key: ConfigGroupKey;
  labelKey: string;
  cardIds: ConfigCardId[];
}

/** Groups that have >=1 visible card, in CONFIG_GROUPS order, each with its visible cards in display order. */
export function visibleConfigGroups(a: ConfigGatingFacts): VisibleConfigGroup[] {
  const out: VisibleConfigGroup[] = [];
  for (const g of CONFIG_GROUPS) {
    const cardIds = CONFIG_CARDS.filter((c) => c.group === g.key && c.visible(a)).map((c) => c.id);
    if (cardIds.length > 0) out.push({ key: g.key, labelKey: g.labelKey, cardIds });
  }
  return out;
}
