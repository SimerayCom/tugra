import type { ServerStatus } from "./types";

const DEPLOY_KEY = "tugra.newResource.deployNow";

/** Remembered "Deploy immediately" choice (default: checked). */
export function readDeployPref(): boolean {
  try {
    return localStorage.getItem(DEPLOY_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeDeployPref(v: boolean): void {
  try {
    localStorage.setItem(DEPLOY_KEY, v ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/** The id of the only ONLINE server in the pool, else null (0 or 2+ online). */
export function soleOnlineServerId(pool: { id: string; status: ServerStatus }[]): string | null {
  const online = pool.filter((s) => s.status === "ONLINE");
  return online.length === 1 ? online[0].id : null;
}

/** Where to land after creating a resource; apps open on the live logs when deploying. */
export function createdHref(kind: "app" | "db", id: string, deploying: boolean): string {
  if (kind === "db") return `/databases/${id}`;
  return deploying ? `/apps/${id}?tab=logs` : `/apps/${id}`;
}
