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
  | "buildConfig"
  | "buildArgs"
  | "dockerOptions"
  | "credentials"
  | "env"
  | "databaseLinks"
  | "expose"
  | "domain"
  | "domainOptions"
  | "volumes"
  | "hostMounts"
  | "volumeBackups"
  | "configMounts"
  | "healthCheck"
  | "limits"
  | "scheduledTasks"
  | "webhooks"
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
}

const notCompose = (a: ConfigGatingFacts) => a.source !== "COMPOSE";

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
  { id: "domainOptions", group: "domains", visible: (a) => !!a.domain },
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
  { id: "webhooks", group: "automation", visible: (a) => !!a.webhookToken },
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
