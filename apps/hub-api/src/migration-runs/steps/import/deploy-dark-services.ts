/**
 * DEPLOY_DARK and the compose SERVICES of the import (C14/R30), pure. A real stack's apps cannot answer their health path without the
 * services they call (a search engine, a document converter, an object store), so DEPLOY_DARK starts those services BEFORE the apps
 * that need them. Which ones is the owner's `serviceStart` choice (see `SERVICE_START_MODES`):
 *  - `dependencies` (default): a service starts when a dark app depends on it, every other service stays stopped;
 *  - `none`: no service starts;
 *  - `all`: every service the import created starts.
 * A dark app DEPENDS on a service when it joined the service's private network (the REMAP_ENV rewrite that points the app's env at the
 * service's alias attaches the app to that network), so the link is a fact of the target, not a guess from names.
 * A worker kept stopped until after the cutover does not count: its service has no reason to run yet.
 */
import type { MinioPolicy, ServiceStartMode } from "../../core/run-contract";
import type { DeploymentRef, ServiceLink } from "./import-ports";

/** Why a service starts or stays stopped (shown to the operator as a code). */
export type ServiceWhy = "dependency" | "all" | "unused" | "choice-none" | "minio-held";

/** One service of the op as the step tracks it: the Tugra app behind it, its deployments and the plan's verdict. */
export interface SvcRow {
  /** The Tugra application id of the service's compose app. */
  id: string;
  itemRef: string;
  name: string;
  status: string;
  exists: boolean;
  deployments: DeploymentRef[];
  /** The Tugra target server it lives on. */
  server: string;
  /** Names of the dark apps that need it (the ones that joined its private network). */
  dependants: string[];
  objectStore: boolean;
  /** A copy volume of it has no finished copy: starting it now would put its first deploy on an empty volume. */
  dataPending: boolean;
  start: boolean;
  why: ServiceWhy;
}

export interface ServiceFacts {
  link: ServiceLink;
  name: string;
  status: string;
  exists: boolean;
  deployments: DeploymentRef[];
  server: string;
}

/**
 * Decide, per service, whether DEPLOY_DARK starts it. `requiredAppIds` are the dark apps that run before the cutover (workers kept
 * stopped are not in it). Deterministic: the rows come back sorted by name then itemRef, which is also the order they are started in.
 */
export function planServiceStart(mode: ServiceStartMode, minioPolicy: MinioPolicy, facts: readonly ServiceFacts[], requiredAppIds: ReadonlySet<string>, appNameOf: ReadonlyMap<string, string>): SvcRow[] {
  const rows = facts.map((f): SvcRow => {
    const dependantIds = f.link.dependants.filter((id) => requiredAppIds.has(id));
    const base = { id: f.link.appId, itemRef: f.link.itemRef, name: f.name, status: f.status, exists: f.exists, deployments: f.deployments, server: f.server, dependants: dependantIds.map((id) => appNameOf.get(id) ?? id).sort(), objectStore: f.link.objectStore, dataPending: f.link.dataPending };
    if (mode === "none") return { ...base, start: false, why: "choice-none" };
    if (mode === "all") return { ...base, start: true, why: "all" };
    // an object store whose buckets stay on the source (policy hold / external) is not started: an empty store on the target helps nobody
    if (f.link.objectStore && minioPolicy !== "mirror") return { ...base, start: false, why: "minio-held" };
    return dependantIds.length > 0 ? { ...base, start: true, why: "dependency" } : { ...base, start: false, why: "unused" };
  });
  return rows.sort((a, b) => (a.name === b.name ? (a.itemRef < b.itemRef ? -1 : 1) : a.name < b.name ? -1 : 1));
}
